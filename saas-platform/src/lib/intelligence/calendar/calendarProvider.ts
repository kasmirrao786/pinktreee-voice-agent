// Calendar provider interface every adapter implements. Keeping this thin
// means adding a new backend later (Outlook, Cal.com, etc.) never touches
// appointmentService.ts.
//
// tenantId is threaded through every method now (it wasn't in the
// standalone intelligence-service version) so the mock adapter can look up
// existing bookings from the real `Appointment` table via Prisma instead of
// an in-process Map — see mockAdapter.ts for why that in-process state was
// worth removing as part of folding this into saas-platform.

export interface CalendarConfig {
  provider: string;
  calendarId: string | null;
  timezone: string;
  slotDurationMinutes: number;
  businessHours: { start: string; end: string; days: number[] };
}

export interface CalendarSlot {
  start: Date;
  end: Date;
}

export interface BookingDetails {
  leadName: string;
  leadEmail: string | null;
  notes: string;
}

export interface CalendarProvider {
  getAvailableSlots(tenantId: string, config: CalendarConfig, rangeStart: Date, rangeEnd: Date): Promise<CalendarSlot[]>;
  bookSlot(tenantId: string, config: CalendarConfig, slot: CalendarSlot, details: BookingDetails): Promise<{ calendarEventId: string }>;
  cancelEvent(tenantId: string, config: CalendarConfig, calendarEventId: string): Promise<void>;
}

export async function getCalendarProvider(providerName: string): Promise<CalendarProvider> {
  switch (providerName) {
    case "google": {
      // Lazy-imported so `googleapis` is only required when actually used.
      const { googleCalendarProvider } = await import("./googleAdapter");
      return googleCalendarProvider;
    }
    case "mock":
    default: {
      const { mockCalendarProvider } = await import("./mockAdapter");
      return mockCalendarProvider;
    }
  }
}
