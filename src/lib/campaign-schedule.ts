/**
 * Pure calling-window logic (spec §21: start/end date, calling days, calling
 * hours, timezone) — no I/O, no provider/database access, so it's testable
 * without mocking anything and reusable from both the dispatcher and any
 * future UI preview ("your next call window opens at...").
 */

export interface CampaignSchedule {
  startDate?: string | undefined; // "YYYY-MM-DD"
  endDate?: string | undefined; // "YYYY-MM-DD"
  windowStart?: string | undefined; // "HH:MM", local to `timezone`
  windowEnd?: string | undefined; // "HH:MM", local to `timezone`
  /** 0 = Sunday .. 6 = Saturday. Empty/absent = every day. */
  days?: number[] | undefined;
  timezone?: string | undefined; // IANA zone, e.g. "Asia/Kolkata"
}

/** Local wall-clock parts of `now` in `timezone`, computed via Intl (no date library dependency). */
function localParts(now: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts["weekday"]!);
  return {
    date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    minutesOfDay: Number(parts["hour"]) * 60 + Number(parts["minute"]),
    weekday: weekdayIndex,
  };
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Whether `now` falls inside this campaign's configured calling window.
 * Missing/invalid schedule fields are treated as "no restriction" for that
 * dimension — an empty schedule means "always callable", matching a
 * campaign that never opened the scheduling step.
 */
export function isWithinCallingWindow(schedule: CampaignSchedule, now: Date = new Date()): boolean {
  const timezone = schedule.timezone || "UTC";
  let local: ReturnType<typeof localParts>;
  try {
    local = localParts(now, timezone);
  } catch {
    // Unknown/invalid IANA zone — fail safe to "not callable" rather than
    // silently ignoring a misconfigured timezone and calling at the wrong hour.
    return false;
  }

  if (schedule.startDate && local.date < schedule.startDate) return false;
  if (schedule.endDate && local.date > schedule.endDate) return false;
  if (schedule.days && schedule.days.length > 0 && !schedule.days.includes(local.weekday))
    return false;

  if (schedule.windowStart && schedule.windowEnd) {
    const start = toMinutes(schedule.windowStart);
    const end = toMinutes(schedule.windowEnd);
    if (start !== null && end !== null) {
      if (start <= end) {
        if (local.minutesOfDay < start || local.minutesOfDay >= end) return false;
      } else {
        // Window crosses midnight (e.g. 22:00-02:00).
        if (local.minutesOfDay < start && local.minutesOfDay >= end) return false;
      }
    }
  }

  return true;
}
