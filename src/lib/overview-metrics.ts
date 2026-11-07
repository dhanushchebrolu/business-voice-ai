/**
 * Pure helpers behind the dashboard overview charts. Everything is derived from rows the customer
 * already loads (call_logs, leads, bookings); nothing here invents a number.
 */

type CallLike = {
  status: string;
  started_at: string | null;
  created_at: string;
  answered_at?: string | null;
};

const ANSWERED = new Set(["answered", "in_progress", "completed"]);
const MISSED = new Set(["no_answer", "busy", "failed", "cancelled"]);

/** A call the receptionist picked up (call_logs.status check constraint, or an answered_at stamp). */
export const isAnswered = (c: Pick<CallLike, "status" | "answered_at">) =>
  ANSWERED.has(c.status) || Boolean(c.answered_at);

/** A call that ended without being answered. Still-ringing / initiated calls are neither. */
export const isMissed = (c: Pick<CallLike, "status" | "answered_at">) =>
  !isAnswered(c) && MISSED.has(c.status);

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export type DayBucket = { key: string; label: string; answered: number; missed: number };

/** Calls per local calendar day for the last `days` days (oldest first, today last). */
export function callsByDay(calls: CallLike[], days: number, now = new Date()): DayBucket[] {
  const buckets: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    buckets.push({
      key: dayKey(d),
      label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
      answered: 0,
      missed: 0,
    });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const c of calls) {
    const b = byKey.get(dayKey(new Date(c.started_at ?? c.created_at)));
    if (!b) continue;
    if (isAnswered(c)) b.answered++;
    else if (isMissed(c)) b.missed++;
  }
  return buckets;
}

export type WeekBucket = { key: string; label: string; count: number };

/** Counts per week (Monday start) for the last `weeks` weeks, oldest first. */
export function countsByWeek(
  dates: (string | null | undefined)[],
  weeks: number,
  now = new Date(),
): WeekBucket[] {
  const monday = (d: Date) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  };
  const start = monday(now);
  const buckets: WeekBucket[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() - i * 7);
    buckets.push({
      key: dayKey(d),
      label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
      count: 0,
    });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const v of dates) {
    if (!v) continue;
    const b = byKey.get(dayKey(monday(new Date(v))));
    if (b) b.count++;
  }
  return buckets;
}

/** Whole-number percentage, or null when there is nothing to divide by (so the UI can say "no data"). */
export const percent = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 100) : null;
