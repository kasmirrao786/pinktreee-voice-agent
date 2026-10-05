"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireSession, assertRole } from "@/lib/session";
import { agentSchema, parseForm } from "@/lib/validation";

export type AgentFormState = { error?: string } | undefined;

function parseConditions(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function createAgentAction(_prev: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const { tenantId, role } = await requireSession();
  assertRole(role, ["owner", "admin"]);

  const parsed = parseForm(agentSchema, formData);
  if (!parsed.success) return { error: parsed.error };
  const { name, systemPrompt, description, voiceId, llmModel, greetingMessage, closingMessage, transferNumber } = parsed.data;

  const agent = await prisma.agent.create({
    data: {
      tenantId,
      name,
      description: description || null,
      systemPrompt,
      voiceId: voiceId || null,
      llmModel: llmModel || null,
      greetingMessage: greetingMessage || null,
      closingMessage: closingMessage || null,
      transferNumber: transferNumber || null,
      transferConditions: parseConditions(String(formData.get("transferConditions") || "")),
      assignedPhoneNumberId: String(formData.get("assignedPhoneNumberId") || "") || null,
      isEnabled: formData.get("isEnabled") === "on",
    },
  });

  revalidatePath("/agents");
  redirect(`/agents/${agent.id}`);
}

export async function updateAgentAction(agentId: string, _prev: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const { tenantId, role } = await requireSession();
  assertRole(role, ["owner", "admin"]);

  const parsed = parseForm(agentSchema, formData);
  if (!parsed.success) return { error: parsed.error };
  const { name, systemPrompt, description, voiceId, llmModel, greetingMessage, closingMessage, transferNumber } = parsed.data;

  // Tenant-scoped update: the where clause requires both id AND tenantId to
  // match, so a request can never mutate another tenant's agent even if an
  // id were guessed or tampered with.
  await prisma.agent.updateMany({
    where: { id: agentId, tenantId },
    data: {
      name,
      description: description || null,
      systemPrompt,
      voiceId: voiceId || null,
      llmModel: llmModel || null,
      greetingMessage: greetingMessage || null,
      closingMessage: closingMessage || null,
      transferNumber: transferNumber || null,
      transferConditions: parseConditions(String(formData.get("transferConditions") || "")),
      assignedPhoneNumberId: String(formData.get("assignedPhoneNumberId") || "") || null,
      isEnabled: formData.get("isEnabled") === "on",
    },
  });

  revalidatePath(`/agents/${agentId}`);
  revalidatePath("/agents");
  return {};
}

export async function toggleAgentEnabledAction(agentId: string, nextValue: boolean) {
  const { tenantId, role } = await requireSession();
  assertRole(role, ["owner", "admin"]);
  await prisma.agent.updateMany({
    where: { id: agentId, tenantId },
    data: { isEnabled: nextValue },
  });
  revalidatePath("/agents");
  revalidatePath(`/agents/${agentId}`);
}

/**
 * Agent.id is a required foreign key on Call and Campaign (Restrict on
 * delete), so hard-deleting an agent with call/campaign history would
 * otherwise fail with a raw database FK error. Check first and give a
 * useful message — disabling is the right move for an agent that's already
 * been used.
 */
export async function deleteAgentAction(agentId: string): Promise<{ error?: string }> {
  const { tenantId, role } = await requireSession();
  assertRole(role, ["owner", "admin"]);

  const agent = await prisma.agent.findFirst({ where: { id: agentId, tenantId } });
  if (!agent) return { error: "Agent not found." };

  const [callCount, campaignCount] = await Promise.all([
    prisma.call.count({ where: { agentId, tenantId } }),
    prisma.campaign.count({ where: { agentId, tenantId } }),
  ]);
  if (callCount > 0 || campaignCount > 0) {
    return {
      error: `This agent has ${callCount} call(s) and ${campaignCount} campaign(s) on record and can't be deleted — disable it instead so it stops taking new calls.`,
    };
  }

  await prisma.agent.deleteMany({ where: { id: agentId, tenantId } });
  revalidatePath("/agents");
  return {};
}
