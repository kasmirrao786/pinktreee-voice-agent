"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/session";
import { logAudit } from "@/lib/audit";

export async function setTenantActiveAction(tenantId: string, isActive: boolean) {
  const { userId, email } = await requirePlatformAdmin();
  await prisma.tenant.update({ where: { id: tenantId }, data: { isActive } });
  await logAudit({
    actorUserId: userId,
    actorEmail: email,
    tenantId,
    action: isActive ? "tenant.activate" : "tenant.deactivate",
    targetType: "tenant",
    targetId: tenantId,
  });
  revalidatePath("/admin");
  revalidatePath(`/admin/tenants/${tenantId}`);
}

/**
 * Platform-wide "system/provider configuration" (build spec section 9).
 * A simple key/value store (PlatformSetting) rather than dedicated columns,
 * so new settings don't need a schema migration. Read these in Project 1's
 * runtime / this app's other server actions instead of hardcoding values.
 */
export async function updatePlatformSettingsAction(formData: FormData) {
  const { userId, email } = await requirePlatformAdmin();

  const ingestionEndpointUrl = String(formData.get("ingestionEndpointUrl") || "").trim();
  const defaultMaxAttempts = parseInt(String(formData.get("defaultMaxAttempts") || "3"), 10) || 3;
  const defaultRetryDelayMinutes = parseInt(String(formData.get("defaultRetryDelayMinutes") || "60"), 10) || 60;
  const availableVoices = String(formData.get("availableVoices") || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  await prisma.$transaction([
    prisma.platformSetting.upsert({
      where: { key: "ingestion_endpoint_url" },
      create: { key: "ingestion_endpoint_url", value: ingestionEndpointUrl },
      update: { value: ingestionEndpointUrl },
    }),
    prisma.platformSetting.upsert({
      where: { key: "default_retry_policy" },
      create: { key: "default_retry_policy", value: { defaultMaxAttempts, defaultRetryDelayMinutes } },
      update: { value: { defaultMaxAttempts, defaultRetryDelayMinutes } },
    }),
    prisma.platformSetting.upsert({
      where: { key: "available_voices" },
      create: { key: "available_voices", value: availableVoices },
      update: { value: availableVoices },
    }),
  ]);

  await logAudit({ actorUserId: userId, actorEmail: email, action: "platform_settings.update" });
  revalidatePath("/admin/settings");
}
