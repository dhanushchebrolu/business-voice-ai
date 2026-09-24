/**
 * The availability algorithm (spec section 47): business hours ∩ NOT
 * Google-busy ∩ NOT existing ClickAI bookings, sliced by service duration
 * (+ optional buffer), returned as normalized slots. Pure computation over
 * already-fetched inputs — callers (calendar-tools.server.ts) own fetching
 * business_hours, Google busy periods (via a CalendarProvider), and
 * existing bookings; this function never touches the database or the
 * network itself, which is what makes it fully unit-testable with fixed
 * dates (spec section 48: "AI must never invent available times" — this
 * is the one function whose output the AI is allowed to read slots from).
 */

import { zonedWallTimeToUtc, dayOfWeekInTimezone } from "./timezone.ts";

export interface BusinessHoursInterval {
  start: string; // "HH:mm", local to the business's timezone
  end: string; // "HH:mm"
}

export interface BusinessHoursDay {
  dayOfWeek: number; // 0=Sunday .. 6=Saturday
  isClosed: boolean;
  intervals: BusinessHoursInterval[];
}

export interface BusyPeriod {
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC
}

export interface ComputeAvailabilityInput {
  dateIso: string; // "2026-09-25" — the requested date, local to the business's timezone
  timezone: string; // IANA, e.g. "Asia/Kolkata"
  businessHours: BusinessHoursDay[];
  durationMinutes: number;
  bufferMinutes?: number | undefined;
  /** Busy periods from the connected Google Calendar for the requested day. */
  googleBusyPeriods: BusyPeriod[];
  /** Start/end of ClickAI's own existing bookings on the same calendar for the requested day (status not CANCELLED/NO_SHOW). */
  existingBookings: BusyPeriod[];
  /** Defaults to Date.now() — injectable so "exclude past slots for today" is deterministic in tests. */
  now?: Date | undefined;
  /** Minutes of grid step between candidate slot starts. Defaults to the service duration itself (spec's own example: 09:00, 09:30, 10:00 — a 30-minute duration steps on a 30-minute grid). */
  slotStepMinutes?: number | undefined;
}

export interface AvailabilitySlot {
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function computeAvailability(input: ComputeAvailabilityInput): AvailabilitySlot[] {
  const dayOfWeek = dayOfWeekInTimezone(input.dateIso, input.timezone);
  const day = input.businessHours.find((d) => d.dayOfWeek === dayOfWeek);
  if (!day || day.isClosed || day.intervals.length === 0) return [];

  const buffer = input.bufferMinutes ?? 0;
  const stepMinutes = input.slotStepMinutes ?? input.durationMinutes;
  const now = input.now ?? new Date();

  const busy = [
    ...input.googleBusyPeriods.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
    ...input.existingBookings.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
  ];

  const slots: AvailabilitySlot[] = [];

  for (const interval of day.intervals) {
    const intervalStart = zonedWallTimeToUtc(input.dateIso, interval.start, input.timezone);
    const intervalEnd = zonedWallTimeToUtc(input.dateIso, interval.end, input.timezone);

    for (
      let candidateStart = intervalStart;
      candidateStart.getTime() + input.durationMinutes * 60_000 <= intervalEnd.getTime();
      candidateStart = new Date(candidateStart.getTime() + stepMinutes * 60_000)
    ) {
      const candidateEnd = new Date(candidateStart.getTime() + input.durationMinutes * 60_000);

      if (candidateStart.getTime() < now.getTime()) continue; // never offer a slot in the past

      // Buffer inflates the conflict window on both sides of the
      // candidate, so a booked slot's buffer also blocks the immediately
      // adjacent candidate slots, not just exact overlaps.
      const bufferedStart = new Date(candidateStart.getTime() - buffer * 60_000);
      const bufferedEnd = new Date(candidateEnd.getTime() + buffer * 60_000);

      const conflicted = busy.some((b) => overlaps(bufferedStart, bufferedEnd, b.start, b.end));
      if (conflicted) continue;

      slots.push({ start: candidateStart.toISOString(), end: candidateEnd.toISOString() });
    }
  }

  return slots;
}
