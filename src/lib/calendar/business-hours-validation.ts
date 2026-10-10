/**
 * Shared validation for business_hours.intervals / business_hour_overrides
 * .intervals — the single source of truth both the UI/server-function
 * layer (this file) and the database trigger
 * (20261010100000_business_hours_interval_validation.sql) implement.
 * Verified against a real Postgres 16 instance to behave identically (see
 * that migration's own header comment and its sibling test file).
 *
 * Rule: a {start, end} pair is well-formed iff both are strict zero-padded
 * 24h "HH:mm" strings and end is STRICTLY after start. No overnight
 * wraparound, no swapping, no normalization — a reversed or equal pair is
 * rejected outright, never reinterpreted. business_hour_overrides
 * intervals additionally require a boolean isOpen key.
 *
 * Validation only ever applies to a row that claims to be OPEN
 * (business_hours.is_closed === false, business_hour_overrides
 * .is_full_day_closure === false) — a closed/full-day-closure row's
 * intervals are never inspected here, matching both
 * set_business_weekly_hours/apply_business_schedule_override's own
 * behavior of force-overwriting intervals to [] whenever the row is
 * closed. An empty array is valid in the open case too ("open, nothing
 * configured yet" — a real, distinct state from closed).
 */

const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export interface BusinessHourTimeInterval {
  start: string;
  end: string;
}

export interface BusinessHourOverrideInterval extends BusinessHourTimeInterval {
  isOpen: boolean;
}

/** Returns a human-readable error, or null if the interval is well-formed. Never throws. */
export function describeInvalidInterval(interval: { start: unknown; end: unknown }): string | null {
  if (typeof interval.start !== "string" || !TIME_PATTERN.test(interval.start)) {
    return `"${String(interval.start)}" is not a valid time — use 24-hour HH:mm, e.g. "09:00".`;
  }
  if (typeof interval.end !== "string" || !TIME_PATTERN.test(interval.end)) {
    return `"${String(interval.end)}" is not a valid time — use 24-hour HH:mm, e.g. "19:00".`;
  }
  if (interval.end <= interval.start) {
    return `Closing time (${interval.end}) must be after opening time (${interval.start}). Overnight hours are not supported.`;
  }
  return null;
}

/** Validates an override interval's isOpen key in addition to start/end. */
export function describeInvalidOverrideInterval(interval: {
  start: unknown;
  end: unknown;
  isOpen: unknown;
}): string | null {
  if (typeof interval.isOpen !== "boolean") {
    return `Each override interval must say whether it opens or closes the period.`;
  }
  return describeInvalidInterval(interval);
}

/** First validation error across a list of plain {start,end} intervals, or null if all are well-formed. An empty list is always well-formed. */
export function describeInvalidIntervals(
  intervals: readonly { start: unknown; end: unknown }[],
): string | null {
  for (const interval of intervals) {
    const error = describeInvalidInterval(interval);
    if (error) return error;
  }
  return null;
}

/** Same as describeInvalidIntervals, for override intervals (which also require isOpen). */
export function describeInvalidOverrideIntervals(
  intervals: readonly { start: unknown; end: unknown; isOpen: unknown }[],
): string | null {
  for (const interval of intervals) {
    const error = describeInvalidOverrideInterval(interval);
    if (error) return error;
  }
  return null;
}

const ERROR_PREFIX = "INVALID_BUSINESS_HOURS_INTERVAL: ";

/**
 * Strips the database trigger's own error prefix off a Postgres/PostgREST
 * error that reached the RPC or a direct table write, returning just the
 * human-readable remainder — or null if this isn't one of ours, so the
 * caller can fall back to its own generic message.
 */
export function describeBusinessHoursWriteError(error: unknown): string | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : null;
  if (!message) return null;
  const idx = message.indexOf(ERROR_PREFIX);
  if (idx === -1) return null;
  return message.slice(idx + ERROR_PREFIX.length).trim();
}

interface WeeklyDayLike {
  dayOfWeek: number;
  isClosed: boolean;
  intervals: readonly { start: unknown; end: unknown }[];
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Day-specific diagnostic for the dashboard calendar view: names the exact
 * weekday and the exact offending interval, rather than a generic warning.
 * Returns null when the day is closed (nothing to validate) or has no
 * invalid interval. Never throws, never mutates the input.
 */
export function describeInvalidWeeklyDay(day: WeeklyDayLike | undefined): string | null {
  if (!day || day.isClosed) return null;
  for (const interval of day.intervals) {
    const error = describeInvalidInterval(interval);
    if (error) {
      const dayName = DAY_NAMES[day.dayOfWeek] ?? `day ${day.dayOfWeek}`;
      return `${dayName}'s weekly hours contain an invalid time range and are being treated as closed: ${error} Fix it under Weekly working hours.`;
    }
  }
  return null;
}

interface OverrideLike {
  isFullDayClosure: boolean;
  intervals: readonly { start: unknown; end: unknown }[];
}

/**
 * Day-specific diagnostic for a daily override, scoped to the exact date
 * being viewed. Returns null when the override is a full-day closure
 * (nothing to validate), there is no override, or it has no invalid
 * interval.
 */
export function describeInvalidOverride(
  override: OverrideLike | undefined,
  dateIso: string,
): string | null {
  if (!override || override.isFullDayClosure) return null;
  for (const interval of override.intervals) {
    const error = describeInvalidInterval(interval);
    if (error) {
      return `The override for ${dateIso} contains an invalid time range and is being treated as closed: ${error} Fix or remove it.`;
    }
  }
  return null;
}

const MAX_WARNED_KEYS = 500;

/**
 * Process-lifetime, bounded deduplication for the server-side diagnostic
 * log below — a business with legacy-invalid hours would otherwise log on
 * every single availability check / booking attempt against it. Evicts
 * the single oldest key once the cap is reached (insertion-ordered Map),
 * never a full clear, so the warned set never goes fully cold and start
 * re-logging everything at once.
 */
const warnedKeys = new Map<string, true>();

function warnOnce(key: string, log: () => void): void {
  if (warnedKeys.has(key)) return;
  if (warnedKeys.size >= MAX_WARNED_KEYS) {
    const oldest = warnedKeys.keys().next().value;
    if (oldest !== undefined) warnedKeys.delete(oldest);
  }
  warnedKeys.set(key, true);
  log();
}

/**
 * Logs a structured, PII-free diagnostic the first time a given
 * business+day (or business+date, for an override) is found to have an
 * invalid interval, so legacy-invalid production data fails safely with a
 * visible server-side trace instead of silently looking like ordinary
 * unavailability. Never includes customer/patient data — only schema
 * identifiers (businessId, dayOfWeek/dateIso) and the offending interval's
 * own start/end strings.
 */
export function logInvalidBusinessHoursOnce(key: string, details: Record<string, unknown>): void {
  warnOnce(key, () => {
    console.warn("[business-hours] invalid interval ignored, treating day as closed", details);
  });
}

/** Test-only: resets the warnOnce dedup state between test cases. */
export function _resetWarnedKeysForTests(): void {
  warnedKeys.clear();
}
