import { Prisma } from "@prisma/client";
import { prisma } from "./db";

export async function logAudit(entry: {
  actorUserId: string;
  actorEmail: string;
  tenantId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
}) {
  try {
    await prisma.auditLog.create({ data: entry });
  } catch {
    // Auditing failures should never block the underlying action.
  }
}
