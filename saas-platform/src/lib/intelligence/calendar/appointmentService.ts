import { prisma } from "@/lib/db";
import { getCalendarProvider, type CalendarConfig, type CalendarSlot } from "./calendarProvider";

/**
 * Loads a tenant's calendar config, defaulting to the mock provider if the
 * tenant hasn't connected a real calendar yet. No settings UI writes to
 * TenantCalendarConfig yet (flagged in the root README as a follow-up) —
 * this only reads it.
 */
async function loadTenantCalendarConfig(tenantId: string): Promise<CalendarConfig> {
  const row = await prisma.tenantCalendarConfig.findUnique({ where: { tenantId } });
  if (!row) {
    return {
      provider: process.env.CALENDAR_PROVIDER || "mock",
      calendarId: null,
      timezone: "UTC",
      slotDurationMinutes: 30,
      businessHours: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] },
    };
  }
  return {
    provider: row.provider,
    calendarId: row.calendarId,
    timezone: row.timezone,
    slotDurationMinutes: row.slotDurationMinutes,
    businessHours: row.businessHours as CalendarConfig["businessHours"],
  };
}

/**
 * Returns available slots for a tenant over the next N days. This is the
 * function calling-engine could call mid-conversation for live in-call slot
 * offering (not currently wired up - see root README); it's also usable for
 * the post-call confirmation flow this project actually uses today.
 */
export async function getAvailableSlots(tenantId: string, { daysAhead = 7 }: { daysAhead?: number } = {}): Promise<CalendarSlot[]> {
  const config = await loadTenantCalendarConfig(tenantId);
  const provider = await getCalendarProvider(config.provider);

  const rangeStart = new Date();
  const rangeEnd = new Date(rangeStart.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  return provider.getAvailableSlots(tenantId, config, rangeStart, rangeEnd);
}

export interface BookAppointmentInput {
  tenantId: string;
  leadId: string;
  callId?: string | null;
  agentId: string;
  slot: CalendarSlot;
  leadName?: string | null;
  leadEmail?: string | null;
  notes?: string;
}

/**
 * Books a specific slot and writes the appointment record. Idempotent per
 * callId: if an appointment already exists for this call, it's returned
 * instead of creating a duplicate.
 */
export async function bookAppointment(input: BookAppointmentInput) {
  const { tenantId, leadId, callId, agentId, slot, leadName, leadEmail, notes } = input;

  if (callId) {
    const existing = await prisma.appointment.findFirst({ where: { callId } });
    if (existing) return existing;
  }

  const config = await loadTenantCalendarConfig(tenantId);
  const provider = await getCalendarProvider(config.provider);

  const { calendarEventId } = await provider.bookSlot(tenantId, config, slot, {
    leadName: leadName || "Lead",
    leadEmail: leadEmail || null,
    notes: notes || "",
  });

  const appointment = await prisma.appointment.create({
    data: {
      tenantId,
      leadId,
      callId: callId ?? null,
      agentId,
      scheduledTime: slot.start,
      status: "scheduled",
      calendarEventId,
      confirmationSent: false,
    },
  });

  await sendConfirmation(appointment.id, { leadEmail: leadEmail ?? null, leadName: leadName ?? null, scheduledTime: slot.start });
  return appointment;
}

/**
 * Confirmation delivery is intentionally a stub: logs + marks the row as
 * sent. Wire this to a real email/SMS provider once that's decided — the
 * appointment flow doesn't need to change when you do. (Same stub as the
 * standalone intelligence-service had — folding services together didn't
 * make this any less of a gap, just noting it's carried over, not new.)
 */
async function sendConfirmation(
  appointmentId: string,
  { leadEmail, leadName, scheduledTime }: { leadEmail: string | null; leadName: string | null; scheduledTime: Date }
) {
  console.log(
    `[appointment confirmation] would notify ${leadName || "lead"} <${leadEmail || "no email"}> ` +
      `about their appointment at ${scheduledTime.toISOString()}`
  );
  await prisma.appointment.update({ where: { id: appointmentId }, data: { confirmationSent: true } });
}

/**
 * Cancels a previously booked appointment: frees the event on the
 * underlying calendar (via the same provider it was booked through) and
 * marks the row cancelled rather than deleting it, so it stays visible in
 * the lead's call/appointment history.
 */
export async function cancelAppointment(appointmentId: string): Promise<{ alreadyCancelled: boolean }> {
  const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appointment) {
    throw new Error(`appointment ${appointmentId} not found`);
  }
  if (appointment.status === "cancelled") {
    return { alreadyCancelled: true };
  }

  const config = await loadTenantCalendarConfig(appointment.tenantId);
  const provider = await getCalendarProvider(config.provider);

  if (appointment.calendarEventId) {
    await provider.cancelEvent(appointment.tenantId, config, appointment.calendarEventId);
  }

  await prisma.appointment.update({ where: { id: appointmentId }, data: { status: "cancelled" } });
  return { alreadyCancelled: false };
}
