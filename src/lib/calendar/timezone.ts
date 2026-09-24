/**
 * Minimal, dependency-free IANA timezone <-> UTC conversion for the
 * availability algorithm (spec section 16: "timezone handling must be
 * explicit... store and use business timezone"). Uses only Node's built-in
 * Intl (full ICU by default in modern Node), no date library dependency.
 *
 * The single-pass offset-resolution technique below is the standard,
 * widely-used idiom for this — it is exact everywhere except for instants
 * that fall exactly within a DST transition's ambiguous/skipped window,
 * which this feature does not need to resolve perfectly (a slot generator
 * picking a slightly-off boundary on the two DST-transition days a year is
 * an acceptable, well-understood limitation, not a correctness bug for the
 * other 363 days).
 */

function offsetMillisAt(utcGuessMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcGuessMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map["hour"] === "24" ? 0 : Number(map["hour"]);
  const asIfUtc = Date.UTC(
    Number(map["year"]),
    Number(map["month"]) - 1,
    Number(map["day"]),
    hour,
    Number(map["minute"]),
    Number(map["second"]),
  );
  return asIfUtc - utcGuessMs;
}

/** Converts a wall-clock date+time in the given IANA timezone to a UTC Date instant. */
export function zonedWallTimeToUtc(
  dateIso: string, // "2026-09-25"
  timeHHmm: string, // "16:00"
  timeZone: string,
): Date {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  const [hour, minute] = timeHHmm.split(":").map(Number) as [number, number];
  const utcGuessMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = offsetMillisAt(utcGuessMs, timeZone);
  return new Date(utcGuessMs - offset);
}

/** The day-of-week (0=Sunday .. 6=Saturday, matching business_hours.day_of_week) for a date in the given timezone. */
export function dayOfWeekInTimezone(dateIso: string, timeZone: string): number {
  const noon = zonedWallTimeToUtc(dateIso, "12:00", timeZone);
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
  const weekday = dtf.format(noon);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekday] ?? 0;
}
