"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireSession, assertRole } from "@/lib/session";

export type AccountFormState = { error?: string; success?: string } | undefined;

export async function updateWorkspaceNameAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const { tenantId, role } = await requireSession();
  assertRole(role, ["owner"]);
  const name = String(formData.get("name") || "").trim();
  if (!name) return { error: "Workspace name can't be empty." };

  await prisma.tenant.update({ where: { id: tenantId }, data: { name } });
  revalidatePath("/settings/account");
  return { success: "Workspace name updated." };
}

export async function changePasswordAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const { userId } = await requireSession();
  const currentPassword = String(formData.get("currentPassword") || "");
  const newPassword = String(formData.get("newPassword") || "");

  if (newPassword.length < 8) return { error: "New password must be at least 8 characters." };

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) return { error: "Current password is incorrect." };

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  return { success: "Password updated." };
}
