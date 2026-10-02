// Requires the optional `googleapis` dependency - see package.json
// `optionalDependencies`. Only imported when a tenant's
// TenantCalendarConfig.provider = 'google', so tenants using the mock
// provider never need this installed.
//
// Auth: expects a Google service-account JSON file, shared with the target
// calendar (the calendar owner grants the service account "Make changes to
// events" access). Path comes from GOOGLE_SERVICE_ACCOUNT_JSON_PATH.

import fs from "node:fs";
import type { CalendarProvider, CalendarSlot, BookingDetails, CalendarConfig } from "./calendarProvider";

async function getAuthedClient() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { google } = await import("googleapis");
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  if (!keyPath || !fs.existsSync(keyPath)) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON_PATH is not set or file does not exist - required for the google calendar provider"
    );
  }
  const credentials = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

export const googleCalendarProvider: CalendarProvider = {
  async getAvailableSlots(_tenantId: string, config: CalendarConfig, rangeStart: Date, rangeEnd: Date): Promise<CalendarSlot[]> {
    const calendar = await getAuthedClient();
    const slotMs = (config.slotDurationMinutes ?? 30) * 60 * 1000;

    const freeBusy = await calendar.freebusy.query({
      requestBody: {
        timeMin: rangeStart.toISOString(),
        timeMax: rangeEnd.toISOString(),
        items: [{ id: config.calendarId ?? undefined }],
      },
    });

    const busyRaw = (config.calendarId && freeBusy.data.calendars?.[config.calendarId]?.busy) || [];
    const busy = busyRaw.map((b) => ({
      start: new Date(b.start as string),
      end: new Date(b.end as string),
    }));

    const slots: CalendarSlot[] = [];
    let cursor = new Date(rangeStart);
    while (cursor.getTime() + slotMs <= rangeEnd.getTime() && slots.length < 20) {
      const day = cursor.getUTCDay();
      const hour = cursor.getUTCHours();
      const businessDays = config.businessHours?.days ?? [1, 2, 3, 4, 5];
      const startHour = parseInt((config.businessHours?.start ?? "09:00").split(":")[0], 10);
      const endHour = parseInt((config.businessHours?.end ?? "17:00").split(":")[0], 10);
      const withinBusinessHours = businessDays.includes(day) && hour >= startHour && hour < endHour;

      const slotEnd = new Date(cursor.getTime() + slotMs);
      const overlapsBusy = busy.some((b) => cursor < b.end && slotEnd > b.start);

      if (withinBusinessHours && !overlapsBusy) {
        slots.push({ start: new Date(cursor), end: slotEnd });
      }
      cursor = new Date(cursor.getTime() + slotMs);
    }
    return slots;
  },

  async bookSlot(_tenantId: string, config: CalendarConfig, slot: CalendarSlot, details: BookingDetails) {
    const calendar = await getAuthedClient();
    const event = await calendar.events.insert({
      calendarId: config.calendarId ?? undefined,
      requestBody: {
        summary: `Call with ${details.leadName || "lead"}`,
        description: details.notes || "",
        start: { dateTime: slot.start.toISOString(), timeZone: config.timezone || "UTC" },
        end: { dateTime: slot.end.toISOString(), timeZone: config.timezone || "UTC" },
        attendees: details.leadEmail ? [{ email: details.leadEmail }] : [],
      },
    });
    return { calendarEventId: event.data.id ?? "" };
  },

  async cancelEvent(_tenantId: string, config: CalendarConfig, calendarEventId: string) {
    const calendar = await getAuthedClient();
    await calendar.events.delete({ calendarId: config.calendarId ?? undefined, eventId: calendarEventId });
  },
};
