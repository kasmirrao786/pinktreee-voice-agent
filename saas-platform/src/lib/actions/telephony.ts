"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireSession, assertRole } from "@/lib/session";
import { encryptCredential } from "@/lib/crypto";
import { logAudit } from "@/lib/audit";

/**
 * Saves a provider credential. The plaintext value is encrypted with
 * AES-256-GCM before it ever reaches the database (see lib/crypto.ts) and is
 * never sent back to the frontend — read paths only ever expose a masked
 * form. This is customer-owned infrastructure; we store and verify the
 * connection, we don't provision numbers on their account. Restricted to
 * owner/admin since it touches billing-adjacent third-party credentials.
 */
export async function saveProviderCredentialAction(formData: FormData) {
  const { tenantId, role, userId, email } = await requireSession();
  assertRole(role, ["owner", "admin"]);

  const provider = String(formData.get("provider") || "");
  const value = String(formData.get("value") || "").trim();
  if (!provider || !value) return;

  const { encryptedValue, keyVersion } = encryptCredential(value);

  await prisma.providerCredential.upsert({
    where: { tenantId_provider: { tenantId, provider } },
    create: { tenantId, provider, encryptedValue, encryptionKeyVersion: keyVersion },
    update: { encryptedValue, encryptionKeyVersion: keyVersion },
  });

  await logAudit({ actorUserId: userId, actorEmail: email, tenantId, action: "telephony.connect", targetType: "provider", targetId: provider });
  revalidatePath("/settings/telephony");
}

/**
 * Campaign.phoneNumberId is a required foreign key (Restrict on delete), so
 * dropping a provider's phone numbers while a campaign still references one
 * would otherwise fail with a raw database error. Check first.
 */
export async function removeProviderCredentialAction(provider: string): Promise<{ error?: string }> {
  const { tenantId, role, userId, email } = await requireSession();
  assertRole(role, ["owner", "admin"]);

  const numbers = await prisma.phoneNumber.findMany({ where: { tenantId, provider }, select: { id: true } });
  const numberIds = numbers.map((n) => n.id);

  if (numberIds.length > 0) {
    const campaignsUsingNumbers = await prisma.campaign.count({
      where: { tenantId, phoneNumberId: { in: numberIds } },
    });
    if (campaignsUsingNumbers > 0) {
      return {
        error: `${campaignsUsingNumbers} campaign(s) still use a phone number from this provider. Stop or reassign them before disconnecting.`,
      };
    }
  }

  await prisma.providerCredential.deleteMany({ where: { tenantId, provider } });
  // Also drop any phone numbers we'd previously listed under that provider —
  // they're only meaningful while the connection is active. Any agent
  // assignment to one of these numbers is optional (SetNull), so this is safe.
  await prisma.phoneNumber.deleteMany({ where: { tenantId, provider } });

  await logAudit({ actorUserId: userId, actorEmail: email, tenantId, action: "telephony.disconnect", targetType: "provider", targetId: provider });
  revalidatePath("/settings/telephony");
  return {};
}

/**
 * Verifies a stored connection and syncs the phone-number list. In this
 * build phase (no live Telnyx/Twilio calls wired up) this seeds a couple of
 * representative fixture numbers so the rest of the UI (agent assignment,
 * campaigns) has real rows to work against; swap the body for a real
 * provider API call when that integration lands.
 */
export async function verifyProviderConnectionAction(provider: string) {
  const { tenantId, role } = await requireSession();
  assertRole(role, ["owner", "admin"]);

  const cred = await prisma.providerCredential.findUnique({
    where: { tenantId_provider: { tenantId, provider } },
  });
  if (!cred) return;

  const existing = await prisma.phoneNumber.findMany({ where: { tenantId, provider } });
  if (existing.length === 0) {
    const fixtureNumbers =
      provider === "twilio" ? ["+15005550006", "+15005550010"] : ["+18005551234", "+18005555678"];
    await prisma.phoneNumber.createMany({
      data: fixtureNumbers.map((n) => ({ tenantId, provider, e164Number: n })),
    });
  }

  revalidatePath("/settings/telephony");
}
