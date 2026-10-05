"use server";

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { registerSchema, parseForm } from "@/lib/validation";

export type FormState = { error?: string; success?: string } | undefined;

export async function registerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseForm(registerSchema, formData);
  if (!parsed.success) return { error: parsed.error };
  const { companyName, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { error: "An account with that email already exists." };
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const { tenant, user } = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: { name: companyName, plan: "trial", isActive: true },
    });
    const user = await tx.user.create({
      data: { tenantId: tenant.id, email, passwordHash, role: "owner" },
    });
    return { tenant, user };
  });

  const session = await getSession();
  session.userId = user.id;
  session.tenantId = tenant.id;
  session.role = user.role;
  session.email = user.email;
  await session.save();

  redirect("/dashboard");
}

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return { error: "Invalid email or password." };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    return { error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const attempts = user.failedLoginAttempts + 1;
    const LOCK_THRESHOLD = 5;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil: attempts >= LOCK_THRESHOLD ? new Date(Date.now() + 1000 * 60 * 15) : null,
      },
    });
    return attempts >= LOCK_THRESHOLD
      ? { error: "Too many failed attempts. Account locked for 15 minutes." }
      : { error: "Invalid email or password." };
  }

  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
  }

  if (user.role !== "platform_admin") {
    const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });
    if (!tenant || !tenant.isActive) {
      return { error: "This account has been deactivated. Contact support." };
    }
  }

  const session = await getSession();
  session.userId = user.id;
  session.tenantId = user.tenantId;
  session.role = user.role;
  session.email = user.email;
  await session.save();

  redirect(user.role === "platform_admin" ? "/admin" : "/dashboard");
}

export async function logoutAction() {
  const session = await getSession();
  session.destroy();
  redirect("/login");
}

/**
 * Password reset — request step. Issues a single-use, 1-hour token, stores
 * only its SHA-256 hash (so a DB read alone can't be used to reset a
 * password), and "delivers" the reset link by logging it. Swap the
 * console.log for a real mail provider — the token plumbing itself is
 * complete and working end-to-end, including the confirmation step below.
 */
export async function requestPasswordResetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  // Always behave the same whether or not the account exists, to avoid leaking
  // which emails are registered.
  if (user) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 1000 * 60 * 60) },
    });

    // TODO(infra): send via a real mail provider instead of logging.
    console.log(`[password-reset] ${email} -> /reset-password/confirm?token=${token}`);
  }

  return { success: "If that email has an account, we've sent a link to reset your password." };
}

/** Password reset — confirmation step. Validates the token, sets the new password, and burns the token. */
export async function confirmPasswordResetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const token = String(formData.get("token") || "");
  const newPassword = String(formData.get("newPassword") || "");

  if (!token) return { error: "Missing or invalid reset link." };
  if (newPassword.length < 8) return { error: "Password must be at least 8 characters." };

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return { error: "This reset link is invalid or has expired. Request a new one." };
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { tokenHash }, data: { usedAt: new Date() } }),
  ]);

  redirect("/login");
}
