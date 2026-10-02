import fs from "fs/promises";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { STORAGE_ROOT } from "@/lib/actions/knowledge";

// Streams an uploaded knowledge-base file back to the browser only if the
// requesting session's tenant matches the source's tenant — this is what
// makes local-disk storage safe to use here instead of a public /uploads
// directory, where the URL alone would be enough to read another tenant's
// document.
export async function GET(_req: NextRequest, { params }: { params: { sourceId: string } }) {
  const session = await getSession();
  if (!session.tenantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const source = await prisma.knowledgeSource.findFirst({
    where: { id: params.sourceId, tenantId: session.tenantId },
  });
  if (!source || source.type !== "file" || !source.sourceUrl) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const filePath = path.join(STORAGE_ROOT, source.sourceUrl);
    const buffer = await fs.readFile(filePath);
    const filename = path.basename(source.sourceUrl).replace(/^[0-9a-f-]{36}-/, "");
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found on disk" }, { status: 404 });
  }
}
