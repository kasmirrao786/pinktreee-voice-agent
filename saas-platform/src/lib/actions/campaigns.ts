"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";

export async function createCampaignAction(formData: FormData) {
  const { tenantId } = await requireSession();

  const name = String(formData.get("name") || "Untitled campaign");
  const agentId = String(formData.get("agentId") || "");
  const phoneNumberId = String(formData.get("phoneNumberId") || "");
  const leadIds = formData.getAll("leadIds").map(String);

  if (!agentId || !phoneNumberId || leadIds.length === 0) {
    return { error: "Select an agent, a phone number, and at least one lead." };
  }

  const startAt = String(formData.get("startAt") || "");
  const windowStart = String(formData.get("windowStart") || "09:00");
  const windowEnd = String(formData.get("windowEnd") || "18:00");
  const days = formData.getAll("days").map(String);
  const maxAttempts = Math.max(1, parseInt(String(formData.get("maxAttempts") || "3"), 10) || 3);
  const retryDelayMinutes = Math.max(5, parseInt(String(formData.get("retryDelayMinutes") || "60"), 10) || 60);

  // Re-verify agent/phone number belong to this tenant to prevent a tampered
  // form from wiring a campaign to another tenant's resources.
  const [agent, phoneNumber] = await Promise.all([
    prisma.agent.findFirst({ where: { id: agentId, tenantId } }),
    prisma.phoneNumber.findFirst({ where: { id: phoneNumberId, tenantId } }),
  ]);
  if (!agent || !phoneNumber) {
    return { error: "Invalid agent or phone number." };
  }

  const campaign = await prisma.campaign.create({
    data: {
      tenantId,
      name,
      agentId,
      phoneNumberId,
      status: "draft",
      leadIds,
      schedule: {
        startAt: startAt || null,
        callingWindow: { start: windowStart, end: windowEnd },
        days: days.length > 0 ? days : ["mon", "tue", "wed", "thu", "fri"],
      },
      retryConfig: { maxAttempts, retryDelayMinutes },
    },
  });

  // Attach these leads to the campaign so they show up on the campaign's
  // lead list and on each lead's own record.
  await prisma.lead.updateMany({
    where: { id: { in: leadIds }, tenantId },
    data: { campaignId: campaign.id },
  });

  revalidatePath("/campaigns");
  redirect(`/campaigns/${campaign.id}`);
}

/**
 * Starting a campaign wraps Project 1's dial-queue engine — this project
 * owns the configuration/monitoring surface, not the dialing logic itself.
 * Calls the calling-engine's tenant-scoped campaign endpoint, which loads and
 * the campaign's leads/agent/phone-number from this same database and
 * starts actually placing calls. The local status flip only happens after
 * that call confirms it accepted the campaign - so the UI never shows
 * "running" for a campaign nothing is actually dialing.
 */
async function callCallingEngine(path: string, options: RequestInit = {}) {
  const baseUrl = process.env.CALLING_ENGINE_URL;
  if (!baseUrl) {
    return { ok: false, error: "CALLING_ENGINE_URL is not configured - the calling engine can't be reached from this app." };
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: body?.error || `calling engine returned ${res.status}` };
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "calling engine request failed" };
  }
}

export async function startCampaignAction(campaignId: string) {
  const { tenantId } = await requireSession();
  const result = await callCallingEngine(`/tenants/${tenantId}/campaigns/${campaignId}/start`);
  if (!result.ok) {
    revalidatePath(`/campaigns/${campaignId}`);
    console.error(result.error);
    return;
  }
  // The calling engine also writes status/startedAt directly (it needs to
  // update dialedCount/skippedCount as it runs regardless), but flipping
  // it here too means the page shows "running" immediately on this
  // request rather than waiting for the next poll/revalidation.
  await prisma.campaign.updateMany({
    where: { id: campaignId, tenantId },
    data: { status: "running", startedAt: new Date() },
  });
  revalidatePath(`/campaigns/${campaignId}`);
}

export async function pauseCampaignAction(campaignId: string) {
  const { tenantId } = await requireSession();
  const result = await callCallingEngine(`/tenants/${tenantId}/campaigns/${campaignId}/pause`);
  if (!result.ok) {
    revalidatePath(`/campaigns/${campaignId}`);
    console.error(result.error);
    return;
  }
  await prisma.campaign.updateMany({ where: { id: campaignId, tenantId }, data: { status: "paused" } });
  revalidatePath(`/campaigns/${campaignId}`);
}

export async function stopCampaignAction(campaignId: string) {
  const { tenantId } = await requireSession();
  const result = await callCallingEngine(`/tenants/${tenantId}/campaigns/${campaignId}/stop`);
  if (!result.ok) {
    revalidatePath(`/campaigns/${campaignId}`);
    console.error(result.error);
    return;
  }
  await prisma.campaign.updateMany({
    where: { id: campaignId, tenantId },
    data: { status: "completed", finishedAt: new Date() },
  });
  revalidatePath(`/campaigns/${campaignId}`);
}
