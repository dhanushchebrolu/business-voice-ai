/**
 * The availability algorithm (spec section 47): business hours ∩ NOT
 * Google-busy ∩ NOT existing ClickAI bookings, sliced by service duration
 * (+ optional buffer), returned as normalized slots. Pure computation over
 * already-fetched inputs — callers (calendar-tools.server.ts) own fetching
 * business_hours, daily overrides, Google busy periods (via a
 * CalendarProvider or the external_calendar_events cache it populates),
 * and existing bookings; this function never touches the database or the
 * network itself, which is what makes it fully unit-testable with fixed
 * dates (spec section 48: "AI must never invent available times" — this
 * is the one function whose output the AI is allowed to read slots from).
 *
 * Precedence (hospital calendar spec section 3), enforced by construction
 * below rather than by any ordering convention the caller must get right:
 *   1. A full-day closure override wins outright — no slots, regardless of
 *      the recurring weekly hours or anything else in `override.intervals`.
 *   2. Otherwise, a date-specific override's open/close intervals are
 *      layered onto the recurring weekly hours for that one date, open
 *      first then close, so an explicit close always wins over an
 *      overlapping open on the same date (the conservative reading —
 *      "close this slot" should never be silently undone by "open this
 *      slot" elsewhere in the same override).
 *   3/4. Confirmed/pending bookings and Google-busy periods are only ever
 *      SUBTRACTED from whatever the override/weekly-hours step decided was
 *      open — an override can never force a slot open that's already
 *      booked or externally busy (see the busy/conflict filter below,
 *      which runs after and independently of the open-interval step).
 *   5. (external-event-must-never-auto-cancel-a-booking) is a property of
 *      the reconciliation/sync code path, not this pure function.
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

/** One open or close decision within a daily override, local wall-clock time. */
export interface OverrideInterval {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
  /** true = open this period even outside/instead of the recurring weekly hours; false = close this period even if the recurring weekly hours would otherwise have opened it. */
  isOpen: boolean;
}

/** A single date's override row (business_hour_overrides), already resolved by the caller to the requested dateIso — or omitted/undefined when no override exists for that date. */
export interface BusinessHourOverride {
  isFullDayClosure: boolean;
  intervals: OverrideInterval[];
}

export interface BusyPeriod {
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC
}

export interface ComputeAvailabilityInput {
  dateIso: string; // "2026-09-25" — the requested date, local to the business's timezone
  timezone: string; // IANA, e.g. "Asia/Kolkata"
  businessHours: BusinessHoursDay[];
  /** The daily override for this exact dateIso, if one exists. Omitted/undefined means the recurring weekly schedule applies unmodified. */
  override?: BusinessHourOverride | undefined;
  durationMinutes: number;
  bufferMinutes?: number | undefined;
  /** Busy periods from the connected Google Calendar for the requested day — either a live freeBusy call or the external_calendar_events cache it populates; this function is agnostic to which. */
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

/** A local-wall-clock minute range within one day, [start, end) in minutes since local midnight. */
interface MinuteRange {
  start: number;
  end: number;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

function toHHmm(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Normalizes a set of ranges: sorted, merging any that overlap or touch. */
function mergeRanges(ranges: MinuteRange[]): MinuteRange[] {
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged: MinuteRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** Removes `sub` from every range in `ranges`, splitting a range into two where `sub` falls strictly inside it. */
function subtractRange(ranges: MinuteRange[], sub: MinuteRange): MinuteRange[] {
  const result: MinuteRange[] = [];
  for (const r of ranges) {
    if (sub.end <= r.start || sub.start >= r.end) {
      result.push(r); // no overlap
      continue;
    }
    if (sub.start > r.start) result.push({ start: r.start, end: Math.min(sub.start, r.end) });
    if (sub.end < r.end) result.push({ start: Math.max(sub.end, r.start), end: r.end });
  }
  return result.filter((r) => r.end > r.start);
}

/** Resolves the effective open wall-clock intervals for one date, applying override precedence over the recurring weekly day. */
function resolveEffectiveIntervals(
  day: BusinessHoursDay | undefined,
  override: BusinessHourOverride | undefined,
): MinuteRange[] {
  if (override?.isFullDayClosure) return [];

  const base: MinuteRange[] =
    day && !day.isClosed
      ? day.intervals.map((i) => ({ start: toMinutes(i.start), end: toMinutes(i.end) }))
      : [];

  if (!override) return mergeRanges(base);

  let effective = base;
  for (const oi of override.intervals) {
    if (!oi.isOpen) continue;
    effective = mergeRanges([...effective, { start: toMinutes(oi.start), end: toMinutes(oi.end) }]);
  }
  for (const oi of override.intervals) {
    if (oi.isOpen) continue;
    effective = subtractRange(effective, { start: toMinutes(oi.start), end: toMinutes(oi.end) });
  }
  return effective;
}

/**
 * Resolves the effective open UTC time ranges for one date, applying the
 * exact same full-day-closure/override precedence computeAvailability uses
 * internally — exported so booking-time server-side revalidation
 * (booking-service.server.ts) can check "does [startIso, endIso) fall
 * inside an open range" without re-deriving the precedence rules in a
 * second place (spec: never a parallel booking system). This is the one
 * function both the availability LISTING and the booking-time REJECTION
 * path call, so they can never disagree about what counts as open.
 */
export function resolveEffectiveOpenRangesUtc(
  dateIso: string,
  timezone: string,
  businessHours: BusinessHoursDay[],
  override: BusinessHourOverride | undefined,
): { start: Date; end: Date }[] {
  const dayOfWeek = dayOfWeekInTimezone(dateIso, timezone);
  const day = businessHours.find((d) => d.dayOfWeek === dayOfWeek);
  const effective = resolveEffectiveIntervals(day, override);
  return effective.map((r) => ({
    start: zonedWallTimeToUtc(dateIso, toHHmm(r.start), timezone),
    end: zonedWallTimeToUtc(dateIso, toHHmm(r.end), timezone),
  }));
}

export function computeAvailability(input: ComputeAvailabilityInput): AvailabilitySlot[] {
  const dayOfWeek = dayOfWeekInTimezone(input.dateIso, input.timezone);
  const day = input.businessHours.find((d) => d.dayOfWeek === dayOfWeek);
  const effectiveIntervals = resolveEffectiveIntervals(day, input.override);
  if (effectiveIntervals.length === 0) return [];

  const buffer = input.bufferMinutes ?? 0;
  const stepMinutes = input.slotStepMinutes ?? input.durationMinutes;
  const now = input.now ?? new Date();

  const busy = [
    ...input.googleBusyPeriods.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
    ...input.existingBookings.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
  ];

  const slots: AvailabilitySlot[] = [];

  for (const range of effectiveIntervals) {
    const intervalStart = zonedWallTimeToUtc(input.dateIso, toHHmm(range.start), input.timezone);
    const intervalEnd = zonedWallTimeToUtc(input.dateIso, toHHmm(range.end), input.timezone);

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
