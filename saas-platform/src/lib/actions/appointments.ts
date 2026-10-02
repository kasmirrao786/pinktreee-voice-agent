"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getAvailableSlots, bookAppointment, cancelAppointment } from "@/lib/intelligence/calendar/appointmentService";

/**
 * These were originally three unauthenticated API routes
 * (/api/tenants/:tenantId/availability, /appointments POST, /appointments/:id
 * DELETE) mirroring the standalone intelligence-service's HTTP surface.
 * Rewritten as server actions instead: tenantId now comes from the
 * authenticated session rather than a client-supplied URL parameter, so
 * there's no way to book or cancel an appointment for a tenant you're not
 * logged into. The one endpoint that legitimately needs to be a public,
 * unauthenticated-but-signed HTTP route is the calling-engine webhook (see
 * src/app/api/webhooks/call-events/route.ts) — that one stays an API route
 * because it's called by a separate process, not by this app's own UI.
 */

export async function getAvailableSlotsAction(daysAhead = 7) {
  const { tenantId } = await requireSession();
  return getAvailableSlots(tenantId, { daysAhead });
}

export async function bookAppointmentAction(input: {
  leadId: string;
  callId?: string | null;
  agentId: string;
  slotStart: string;
  slotEnd: string;
  notes?: string;
}) {
  const { tenantId } = await requireSession();

  // Confirm the lead actually belongs to this tenant before booking on
  // their behalf - requireSession() proves who's asking, this proves
  // they're allowed to touch this specific lead.
  const lead = await prisma.lead.findFirst({ where: { id: input.leadId, tenantId } });
  if (!lead) {
    return { error: "lead not found for this tenant" };
  }

  const appointment = await bookAppointment({
    tenantId,
    leadId: input.leadId,
    callId: input.callId ?? null,
    agentId: input.agentId,
    slot: { start: new Date(input.slotStart), end: new Date(input.slotEnd) },
    leadName: lead.name,
    leadEmail: lead.email,
    notes: input.notes,
  });

  revalidatePath(`/leads/${input.leadId}`);
  return { appointment };
}

export async function cancelAppointmentAction(appointmentId: string) {
  const { tenantId } = await requireSession();

  const appointment = await prisma.appointment.findFirst({ where: { id: appointmentId, tenantId } });
  if (!appointment) {
    return { error: "appointment not found for this tenant" };
  }

  const result = await cancelAppointment(appointmentId);
  revalidatePath(`/leads/${appointment.leadId}`);
  return result;
}
