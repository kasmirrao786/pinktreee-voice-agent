"use server";

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";

// Private (non-public) storage root for uploaded knowledge-base documents.
// Files are served back out through /api/knowledge-files/[sourceId], which
// checks tenant ownership before streaming anything — nothing here is
// reachable by a bare URL guess. Swap this for S3/Railway volumes + signed
// URLs before production; a local disk path won't survive a redeploy on
// most hosts.
const STORAGE_ROOT = path.join(process.cwd(), "storage", "knowledge");

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv"]);

/**
 * Creates a raw knowledge_sources row. This project owns that row and the
 * CRUD/list/delete UI around it. Project 1 owns turning it into
 * knowledge_chunks (chunking + pgvector embeddings) via its ingestion
 * endpoint — we just call out to it and record nothing more than the
 * source itself; "processing" vs "indexed" status is derived by checking
 * whether any chunks exist yet for this source (see getSourceStatus below).
 */
export async function createKnowledgeSourceAction(agentId: string, formData: FormData) {
  const { tenantId } = await requireSession();

  // Confirm the agent belongs to this tenant before attaching a source to it.
  const agent = await prisma.agent.findFirst({ where: { id: agentId, tenantId } });
  if (!agent) throw new Error("Agent not found");

  const type = String(formData.get("type") || "text");
  const rawContent = String(formData.get("rawContent") || "") || null;
  const sourceUrl = String(formData.get("sourceUrl") || "") || null;

  const source = await prisma.knowledgeSource.create({
    data: { tenantId, agentId, type, rawContent, sourceUrl },
  });

  await triggerIngestion(source.id, tenantId, agentId);
  revalidatePath(`/agents/${agentId}`);
}

/**
 * Handles the "Upload flow for documents" requirement — saves the uploaded
 * file to private disk storage (see STORAGE_ROOT above), extracts plain-text
 * content directly for text-like formats so it's immediately searchable
 * even before Project 1's chunker runs, and records the source. Binary
 * formats (PDF, DOCX, etc.) are stored as-is with rawContent left null;
 * Project 1's ingestion step is expected to extract their text.
 */
export async function uploadKnowledgeFileAction(agentId: string, formData: FormData) {
  const { tenantId } = await requireSession();

  const agent = await prisma.agent.findFirst({ where: { id: agentId, tenantId } });
  if (!agent) throw new Error("Agent not found");

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) return;

  const ext = path.extname(file.name).toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  const dir = path.join(STORAGE_ROOT, tenantId, agentId);
  await fs.mkdir(dir, { recursive: true });
  const storedFilename = `${crypto.randomUUID()}-${file.name}`;
  await fs.writeFile(path.join(dir, storedFilename), buffer);

  const rawContent = TEXT_EXTENSIONS.has(ext) ? buffer.toString("utf8").slice(0, 200_000) : null;

  const source = await prisma.knowledgeSource.create({
    data: {
      tenantId,
      agentId,
      type: "file",
      rawContent,
      sourceUrl: path.join(tenantId, agentId, storedFilename), // relative path under STORAGE_ROOT
    },
  });

  await triggerIngestion(source.id, tenantId, agentId);
  revalidatePath(`/agents/${agentId}`);
}

async function triggerIngestion(sourceId: string, tenantId: string, agentId: string) {
  try {
    // Admin-configured endpoint (set at /admin/settings) takes priority over
    // the env var, so ops can repoint ingestion without a redeploy.
    const setting = await prisma.platformSetting.findUnique({ where: { key: "ingestion_endpoint_url" } });
    const ingestUrl = (setting?.value as string) || process.env.INGESTION_ENDPOINT_URL;
    if (ingestUrl) {
      await fetch(ingestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, tenantId, agentId }),
      });
    }
  } catch {
    // Best-effort — the source just shows "processing" until chunks show up.
  }
}

export async function deleteKnowledgeSourceAction(agentId: string, sourceId: string) {
  const { tenantId } = await requireSession();

  const source = await prisma.knowledgeSource.findFirst({ where: { id: sourceId, tenantId, agentId } });
  if (source?.type === "file" && source.sourceUrl) {
    await fs.rm(path.join(STORAGE_ROOT, source.sourceUrl), { force: true });
  }

  await prisma.knowledgeSource.deleteMany({ where: { id: sourceId, tenantId, agentId } });
  revalidatePath(`/agents/${agentId}`);
}

const STORAGE_ROOT = path.join(process.cwd(), "storage", "knowledge");
