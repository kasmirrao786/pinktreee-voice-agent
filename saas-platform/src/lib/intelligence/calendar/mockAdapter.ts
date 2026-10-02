import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import type { CalendarProvider, CalendarSlot, BookingDetails, CalendarConfig } from "./calendarProvider";

// Zero-setup default for dev/demo/tenants who haven't connected a real
// calendar yet.
//
// Ported from intelligence-service's mockAdapter.js, with one deliberate
// change: the original kept booked slots in an in-process `Map`, which was
// fine as a standalone single-replica service but would have silently
// broken (double-bookings across replicas, bookings vanishing on restart)
// the moment saas-platform — which this got folded into, and which IS
// meant to scale beyond one replica — ran more than one instance. Since a
// real `Appointment` row already gets written right after `bookSlot`
// returns, this now checks for overlaps against those real rows through
// Prisma instead of maintaining a second, redundant, non-shared copy of
// the same information.
export const mockCalendarProvider: CalendarProvider = {
  async getAvailableSlots(tenantId: string, config: CalendarConfig, rangeStart: Date, rangeEnd: Date): Promise<CalendarSlot[]> {
    const slotMs = (config.slotDurationMinutes ?? 30) * 60 * 1000;

    const existing = await prisma.appointment.findMany({
      where: {
        tenantId,
        status: { not: "cancelled" },
        scheduledTime: { gte: rangeStart, lte: rangeEnd },
      },
      select: { scheduledTime: true },
    });
    const booked = existing.map((a) => ({
      start: a.scheduledTime,
      end: new Date(a.scheduledTime.getTime() + slotMs),
    }));

    const slots: CalendarSlot[] = [];
    let cursor = new Date(rangeStart);

    while (cursor.getTime() + slotMs <= rangeEnd.getTime() && slots.length < 20) {
      const day = cursor.getUTCDay(); // 0=Sun..6=Sat
      const hour = cursor.getUTCHours();
      const businessDays = config.businessHours?.days ?? [1, 2, 3, 4, 5];
      const startHour = parseInt((config.businessHours?.start ?? "09:00").split(":")[0], 10);
      const endHour = parseInt((config.businessHours?.end ?? "17:00").split(":")[0], 10);

      const withinBusinessHours = businessDays.includes(day) && hour >= startHour && hour < endHour;
      const slotEnd = new Date(cursor.getTime() + slotMs);
      const overlapsBooked = booked.some((b) => cursor < b.end && slotEnd > b.start);

      if (withinBusinessHours && !overlapsBooked) {
        slots.push({ start: new Date(cursor), end: slotEnd });
      }

      cursor = new Date(cursor.getTime() + slotMs);
    }

    return slots;
  },

  async bookSlot(_tenantId: string, _config: CalendarConfig, _slot: CalendarSlot, _details: BookingDetails) {
    // Nothing to do beyond generating an id - the caller (appointmentService)
    // writes the real Appointment row right after this returns, and that
    // row IS the source of truth getAvailableSlots reads back above.
    return { calendarEventId: `mock_${randomUUID()}` };
  },

  async cancelEvent() {
    // Nothing to free on a "calendar" that was never real - the caller
    // already flips the Appointment row's status to 'cancelled', which is
    // what getAvailableSlots checks.
  },
};
