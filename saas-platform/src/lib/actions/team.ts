"use server";

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireSession, assertRole, getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";
import { inviteSchema, parseForm } from "@/lib/validation";

export type TeamFormState = { error?: string; success?: string } | undefined;

/**
 * The shared "users" table supports multiple accounts per tenant with a
 * role, but nothing in the original build spec covered how a second
 * teammate actually gets one. This issues a single-use, 7-day invite token
 * (only its hash is stored) and "delivers" it by logging the link, same
 * pattern as password reset — swap for a real mailer.
 */
export async function inviteTeammateAction(_prev: TeamFormState, formData: FormData): Promise<TeamFormState> {
  const { tenantId, role: actingRole, userId, email: actingEmail } = await requireSession();
  assertRole(actingRole, ["owner", "admin"]);

  const parsed = parseForm(inviteSchema, formData);
  if (parsed.error) return { error: parsed.error };
  const { email, role } = parsed.data;

  // Only an owner can grant admin — an admin inviting someone can only add members.
  if (role === "admin") assertRole(actingRole, ["owner"]);

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) return { error: "Someone with that email already has an account." };

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  await prisma.invite.create({
    data: {
      tenantId,
      email,
      role,
      tokenHash,
      invitedBy: userId,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
    },
  });

  // TODO(infra): send via a real mail provider instead of logging.
  console.log(`[team-invite] ${email} -> /invite/accept?token=${token}`);

  await logAudit({ actorUserId: userId, actorEmail: actingEmail, tenantId, action: "team.invite", targetType: "invite", metadata: { email, role } });
  revalidatePath("/settings/team");
  return { success: `Invite sent to ${email}.` };
}

export async function revokeInviteAction(inviteId: string) {
  const { tenantId, role } = await requireSession();
  assertRole(role, ["owner", "admin"]);
  await prisma.invite.deleteMany({ where: { id: inviteId, tenantId, acceptedAt: null } });
  revalidatePath("/settings/team");
}

export async function updateUserRoleAction(userId: string, formData: FormData) {
  const { tenantId, role: actingRole } = await requireSession();
  assertRole(actingRole, ["owner"]); // only an owner can change roles

  const newRole = String(formData.get("role") || "member") as "admin" | "member";
  const target = await prisma.user.findFirst({ where: { id: userId, tenantId } });
  if (!target || target.role === "owner") return; // can't demote the/an owner this way

  await prisma.user.update({ where: { id: userId }, data: { role: newRole } });
  revalidatePath("/settings/team");
}

export async function removeUserAction(userId: string): Promise<{ error?: string }> {
  const { tenantId, role: actingRole, userId: actingUserId } = await requireSession();
  assertRole(actingRole, ["owner", "admin"]);

  if (userId === actingUserId) return { error: "You can't remove your own account here." };

  const target = await prisma.user.findFirst({ where: { id: userId, tenantId } });
  if (!target) return { error: "User not found." };
  if (target.role === "owner") return { error: "The workspace owner can't be removed." };

  await prisma.user.deleteMany({ where: { id: userId, tenantId } });
  revalidatePath("/settings/team");
  return {};
}

/** Accepts an invite: validates the token, creates the user, and logs them in. */
export async function acceptInviteAction(_prev: TeamFormState, formData: FormData): Promise<TeamFormState> {
  const token = String(formData.get("token") || "");
  const password = String(formData.get("password") || "");

  if (!token) return { error: "Missing or invalid invite link." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const invite = await prisma.invite.findUnique({ where: { tokenHash } });

  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
    return { error: "This invite is invalid or has expired. Ask for a new one." };
  }

  const existingUser = await prisma.user.findUnique({ where: { email: invite.email } });
  if (existingUser) return { error: "Someone with that email already has an account." };

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { tenantId: invite.tenantId, email: invite.email, passwordHash, role: invite.role },
    });
    await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    return created;
  });

  const session = await getSession();
  session.userId = user.id;
  session.tenantId = user.tenantId;
  session.role = user.role;
  session.email = user.email;
  await session.save();

  redirect("/dashboard");
}
