/**
 * The call's structured memory. Every value records where it came from:
 *
 *   explicit   the caller said it plainly ("3 PM", "cleaning")
 *   inferred   derived, not said ("4" on a clinic call -> 16:00; caller ID;
 *              Hindi "kal" -> tomorrow)
 *   uncertain  the caller said something with more than one reading
 *              ("12", "2 or 3 PM") — never acted on until resolved
 *   confirmed  the agent read it back and the caller agreed
 *
 * Nothing becomes `confirmed` except through confirmReadBack() after a
 * caller "yes" to that exact read-back. The model cannot confirm facts:
 * it only sees this state and the backend's tool results.
 *
 * Dates are resolved here, from the caller's words, the business time zone
 * and the business clock (resolveDateCandidates); never from a date the
 * model produced. A day with two real readings is `uncertain` and clarified.
 */
import { daysInMonth } from "./numbers.ts";
import type {
  DateExpr,
  Intent,
  LanguageCode,
  Reading,
  ServiceRow,
  SimpleDateExpr,
  TimeSpec,
} from "./understanding.ts";

export type Provenance = "explicit" | "inferred" | "uncertain" | "confirmed";
export type SlotName = "intent" | "service" | "date" | "time" | "customerName" | "phone";
/** A question the agent can be waiting on: a detail, the booking read-back, or "leave it for now?". */
export type QuestionKey = SlotName | "booking" | "leave";

export interface Fact<T> {
  value: T;
  provenance: Provenance;
  turn: number;
  evidence: string;
  alternatives: T[];
  source?: "caller" | "caller_id" | "model";
}

export interface OfferedSlot {
  startIso: string;
  hhmm: string;
}

export type BookingStatus =
  | "none"
  | "checking"
  | "slots_offered"
  | "slot_selected"
  | "awaiting_final_confirmation"
  | "booking"
  | "confirmed"
  /** Saved and holding the slot, but its Google Calendar copy failed: "saved, the team will confirm". */
  | "held_pending_sync"
  /** The backend accepted it but has not confirmed it. */
  | "pending"
  /** The calendar was checked and nothing is free for this service/day/time: ask for another. */
  | "no_availability"
  | "failed";

/** The booking exists in the backend (in any state): never book it again. */
export function bookingExists(s: { booking: { status: BookingStatus } }): boolean {
  return (
    s.booking.status === "confirmed" ||
    s.booking.status === "held_pending_sync" ||
    s.booking.status === "pending"
  );
}

export interface ToolRun {
  name: string;
  status: "running" | "succeeded" | "failed";
  turn: number;
  detail?: string;
}

export interface ChangeRecord {
  turn: number;
  slot: SlotName | "booking";
  from: string | null;
  to: string | null;
  reason: string;
}

export interface ConversationState {
  turn: number;
  language: { current: LanguageCode; preferred: Fact<LanguageCode> | null; switches: number };
  intent: Fact<Intent> | null;
  service: Fact<ServiceRow> | null;
  date: Fact<string> | null; // YYYY-MM-DD in the business's time zone
  time: Fact<TimeSpec> | null;
  customerName: Fact<string> | null;
  phone: Fact<string> | null;
  /** What the agent last read back and is waiting for a yes/no on. */
  pendingReadBack: QuestionKey | null;
  /** The last question the agent actually finished saying (interrupted ones don't count). */
  lastQuestion: QuestionKey | null;
  timesAsked: Partial<Record<QuestionKey, number>>;
  currentTask:
    | "greeting"
    | "collecting"
    | "checking_availability"
    | "choosing_slot"
    | "confirming"
    | "booking"
    | "done"
    | "closed"
    | "handoff";
  booking: {
    status: BookingStatus;
    offered: OfferedSlot[];
    selected: OfferedSlot | null;
    bookingId: string | null;
    error: string | null;
    idempotencyKey: string;
    /** The last calendar query that found nothing free (business-local date, time as described). */
    checked: { date: string; time: string } | null;
    /**
     * Times ("HH:MM") the caller asked for that the calendar showed as NOT free
     * for the current service and date. The only basis for saying a time is
     * unavailable; cleared whenever the service, date or time changes.
     */
    unavailable: string[];
  };
  /**
   * The caller is wrapping up. `leaveConfirmed`: they chose to leave
   * unfinished work (declined "shall I finish it now?"). `closed`: the
   * goodbye was said.
   */
  closing: { requested: boolean; leaveConfirmed: boolean; closed: boolean };
  /** The confirmed booking has been announced once: don't repeat it every turn. */
  bookingAnnounced: boolean;
  tools: ToolRun[];
  changes: ChangeRecord[];
}

export interface BusinessContext {
  businessName: string;
  timeZone: string;
  services: ServiceRow[];
  now: () => Date;
}

function show(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && v && "name" in v) return String((v as ServiceRow).name);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function newConversation(opts: {
  callId: string;
  callerId: string | null;
  primaryLanguage: LanguageCode;
}): ConversationState {
  const phone =
    opts.callerId && /\d{10}$/.test(opts.callerId.replace(/\D/g, ""))
      ? ({
          value: opts.callerId.replace(/\D/g, "").slice(-10),
          provenance: "inferred",
          turn: 0,
          evidence: "caller ID",
          alternatives: [],
          source: "caller_id",
        } satisfies Fact<string>)
      : null;
  return {
    turn: 0,
    language: { current: opts.primaryLanguage, preferred: null, switches: 0 },
    intent: null,
    service: null,
    date: null,
    time: null,
    customerName: null,
    phone,
    pendingReadBack: null,
    lastQuestion: null,
    timesAsked: {},
    currentTask: "greeting",
    booking: {
      status: "none",
      offered: [],
      selected: null,
      bookingId: null,
      error: null,
      idempotencyKey: `${opts.callId}:booking:1`,
      checked: null,
      unavailable: [],
    },
    closing: { requested: false, leaveConfirmed: false, closed: false },
    bookingAnnounced: false,
    tools: [],
    changes: [],
  };
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

export function isoDateIn(timeZone: string, d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Hour of day (0..23) at the business, for date-boundary rules. */
export function localHourIn(timeZone: string, d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(d),
  );
}

/** Calendar arithmetic on YYYY-MM-DD (noon UTC: never crosses a date line). */
export function addDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T12:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Before this hour (business time), "tomorrow" / "repu" / "kal" may mean the
 * day that has just started ("tomorrow morning" said at 00:30 before
 * sleeping): both readings are kept and the caller is asked.
 */
export const AFTER_MIDNIGHT_UNTIL_HOUR = 4;

export interface DateCandidates {
  /** YYYY-MM-DD in the business time zone: the first reading. */
  primary: string;
  /** Other real readings; non-empty means the date must be clarified. */
  alternatives: string[];
  /** An explicit date (with its year) that has already passed: never usable. */
  passed?: boolean;
  /** No year was said and this year's date has passed: next year's is assumed, and asked. */
  nextYear?: boolean;
  /** Two day words that name different days ("Friday 15 November" when the 15th is a Sunday). */
  conflict?: boolean;
  /** Another day word named exactly this day ("Tuesday the 10th"): as good as said outright. */
  corroborated?: boolean;
}

const ymd = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const weekdayOf = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();

function resolveSimple(value: SimpleDateExpr, ctx: BusinessContext): DateCandidates {
  const now = ctx.now();
  const today = isoDateIn(ctx.timeZone, now);
  if (value.kind === "relative") {
    const primary = addDays(today, value.days);
    const afterMidnight =
      value.days === 1 && localHourIn(ctx.timeZone, now) < AFTER_MIDNIGHT_UNTIL_HOUR;
    return { primary, alternatives: afterMidnight ? [today] : [] };
  }
  if (value.kind === "calendar") {
    const [ty, tm] = today.split("-").map(Number) as [number, number];
    if (value.month === null) {
      // "the 15th" / "15 तारीख": the next 15th (this month's if still ahead).
      for (let i = 0; i < 13; i++) {
        const y = ty + Math.floor((tm - 1 + i) / 12);
        const mo = ((tm - 1 + i) % 12) + 1;
        if (value.day > daysInMonth(mo, y)) continue;
        const iso = ymd(y, mo, value.day);
        if (iso >= today) return { primary: iso, alternatives: [] };
      }
    }
    const month = value.month ?? tm;
    if (value.year !== null) {
      const iso = ymd(value.year, month, value.day);
      return iso < today
        ? { primary: iso, alternatives: [], passed: true }
        : { primary: iso, alternatives: [] };
    }
    // No year: this year's date, or (once it has passed) the next one that exists.
    for (let y = ty; y <= ty + 8; y++) {
      if (value.day > daysInMonth(month, y)) continue;
      const iso = ymd(y, month, value.day);
      if (iso >= today)
        return { primary: iso, alternatives: [], ...(y !== ty ? { nextYear: true } : {}) };
    }
    return {
      primary: ymd(ty, month, Math.min(value.day, daysInMonth(month, ty))),
      alternatives: [],
      passed: true,
    };
  }
  const todayWd = new Date(`${today}T12:00:00Z`).getUTCDay();
  const ahead = (value.weekday - todayWd + 7) % 7;
  if (ahead === 0) {
    // Today's own weekday: "this Monday" is today, "next Monday" a week on;
    // a bare "Monday" on a Monday could be either.
    if (value.qualifier === "this") return { primary: today, alternatives: [] };
    if (value.qualifier === "next") return { primary: addDays(today, 7), alternatives: [] };
    return { primary: today, alternatives: [addDays(today, 7)] };
  }
  return { primary: addDays(today, ahead), alternatives: [] };
}

/**
 * The only place a spoken day becomes a calendar date: the caller's words,
 * the business time zone and the business clock. Deterministic.
 */
export function resolveDateCandidates(value: DateExpr, ctx: BusinessContext): DateCandidates {
  if (value.kind === "either") {
    const all = value.options.map((o) => resolveSimple(o, ctx).primary);
    return {
      primary: all[0]!,
      alternatives: [...new Set(all.slice(1))].filter((d) => d !== all[0]),
    };
  }
  return resolveSimple(value, ctx);
}

/**
 * Other day words said with the date must name the same day. One that
 * picks a single reading settles it ("this Monday, the 9th"); one that
 * contradicts it ("Friday 15 November" when the 15th is a Sunday) makes the
 * date a question for the caller, with the day the other word names.
 */
export function crossCheckDate(
  c: DateCandidates,
  checks: SimpleDateExpr[],
  ctx: BusinessContext,
): DateCandidates {
  const today = isoDateIn(ctx.timeZone, ctx.now());
  let cur = c;
  for (const chk of checks) {
    const cands = [cur.primary, ...cur.alternatives];
    let fits: string[];
    let other: string;
    if (chk.kind === "weekday") {
      fits = cands.filter((d) => weekdayOf(d) === chk.weekday);
      // The same weekday nearest the date said (not earlier than today).
      const offsets = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6];
      other =
        offsets
          .map((o) => addDays(cur.primary, o))
          .find((d) => weekdayOf(d) === chk.weekday && d >= today) ??
        resolveSimple(chk, ctx).primary;
    } else {
      const r = resolveSimple(chk, ctx);
      const theirs = [r.primary, ...r.alternatives];
      fits = cands.filter((d) => theirs.includes(d));
      other = r.primary;
    }
    if (fits.length === 1)
      cur = { ...cur, primary: fits[0]!, alternatives: [], corroborated: !cur.conflict };
    else if (fits.length === 0)
      cur = {
        ...cur,
        alternatives: [...new Set([...cur.alternatives, other])].filter((d) => d !== cur.primary),
        conflict: true,
      };
  }
  return cur;
}

/** Resolves a spoken day to YYYY-MM-DD in the business's own time zone (first reading). */
export function resolveDate(value: DateExpr, ctx: BusinessContext): string {
  return resolveDateCandidates(value, ctx).primary;
}

/** "Tuesday 3 November", plus "(today)" / "(tomorrow)" when the business clock is known. */
export function spokenDate(iso: string, ctx?: BusinessContext): string {
  const label = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${iso}T12:00:00Z`));
  if (!ctx) return label;
  const today = isoDateIn(ctx.timeZone, ctx.now());
  const rel =
    iso === today
      ? "today"
      : iso === addDays(today, 1)
        ? "tomorrow"
        : iso === addDays(today, 2)
          ? "day after tomorrow"
          : null;
  return rel ? `${label} (${rel})` : label;
}

/* ------------------------------------------------------------------ */
/* Applying one caller turn                                            */
/* ------------------------------------------------------------------ */

type Key = "intent" | "service" | "date" | "time" | "customerName" | "phone";

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function setFact<T>(
  s: ConversationState,
  key: Key,
  next: Omit<Fact<T>, "turn">,
  reason: string,
  keepBooking = false,
): void {
  const prev = s[key] as Fact<T> | null;
  if (prev && sameValue(prev.value, next.value)) {
    // Repeating a value never lowers its standing (a confirmed fact stays
    // confirmed); it can raise inferred/uncertain to explicit.
    if (prev.provenance === "inferred" || prev.provenance === "uncertain") {
      (s as unknown as Record<Key, Fact<T>>)[key] = {
        ...prev,
        provenance: next.provenance,
        evidence: next.evidence,
        alternatives: next.alternatives,
        turn: s.turn,
      };
    }
    return;
  }
  (s as unknown as Record<Key, Fact<T> | null>)[key] = { ...next, turn: s.turn };
  s.changes.push({
    turn: s.turn,
    slot: key,
    from: show(prev?.value),
    to: show(next.value),
    reason,
  });
  // A changed service/date/time invalidates any slot offered or chosen for the old one.
  if (
    !keepBooking &&
    prev &&
    (key === "service" || key === "date" || key === "time") &&
    !bookingExists(s)
  ) {
    if (s.booking.offered.length || s.booking.selected) {
      s.changes.push({
        turn: s.turn,
        slot: "booking",
        from: s.booking.status,
        to: "none",
        reason: `${key} changed`,
      });
    }
    s.booking.offered = [];
    s.booking.selected = null;
    s.booking.status = "none";
    s.booking.checked = null;
    s.booking.unavailable = [];
    if (s.pendingReadBack === "booking") s.pendingReadBack = null;
  }
}

/**
 * Forget a date or time the caller has just made untrustworthy ("make it
 * 16:30 AM", "31 February"): asking again is safer than keeping the old
 * value or guessing a new one. Any slot offered or chosen for it goes too.
 */
function clearFact(s: ConversationState, key: "date" | "time", reason: string): void {
  const prev = s[key];
  if (!prev || bookingExists(s)) return;
  s[key] = null;
  s.changes.push({ turn: s.turn, slot: key, from: show(prev.value), to: null, reason });
  if (s.booking.offered.length || s.booking.selected) {
    s.changes.push({
      turn: s.turn,
      slot: "booking",
      from: s.booking.status,
      to: "none",
      reason: `${key} unclear`,
    });
  }
  s.booking.offered = [];
  s.booking.selected = null;
  s.booking.status = "none";
  s.booking.checked = null;
  s.booking.unavailable = [];
  if (s.pendingReadBack === "booking") s.pendingReadBack = null;
}

/** The caller said yes/no to the agent's last read-back. */
function answerReadBack(s: ConversationState, r: Reading): boolean {
  const target = s.pendingReadBack;
  if (!target) return false;
  if (target === "leave") {
    // "Shall I finish it now, or leave it for now?"
    if (r.affirm && !r.closing && !r.correction) {
      s.closing.requested = false; // continue where we were
      s.pendingReadBack = null;
      return true;
    }
    if (r.deny || r.closing) {
      s.closing.requested = true;
      s.closing.leaveConfirmed = true;
      s.pendingReadBack = null;
      return true;
    }
    return false;
  }
  if (r.affirm && !r.correction) {
    if (target === "booking") {
      for (const k of ["service", "date", "time", "customerName", "phone"] as const) {
        const f = s[k] as Fact<unknown> | null;
        if (f && f.provenance !== "uncertain") f.provenance = "confirmed";
      }
      if (
        s.booking.status === "slot_selected" ||
        s.booking.status === "awaiting_final_confirmation"
      ) {
        s.booking.status = "awaiting_final_confirmation";
        s.currentTask = "booking";
      }
    } else {
      const f = s[target as Key] as Fact<unknown> | null;
      if (f && f.provenance !== "uncertain") f.provenance = "confirmed";
    }
    s.pendingReadBack = null;
    return true;
  }
  if (r.deny) {
    if (target !== "booking") {
      const f = s[target as Key] as Fact<unknown> | null;
      // "No" without a replacement: the value is now doubtful, not deleted.
      if (f) f.provenance = "uncertain";
      if (target === "phone" && f?.source === "caller_id") s.phone = null;
    }
    s.pendingReadBack = null;
    return true;
  }
  return false;
}

export function applyReading(
  s: ConversationState,
  r: Reading,
  ctx: BusinessContext,
): ConversationState {
  s.turn += 1;
  if (r.noise) return s; // background noise / filler never changes anything

  if (r.language && r.language !== s.language.current) {
    s.language.switches += 1;
    s.language.current = r.language;
  }

  const answeredReadBack = answerReadBack(s, r);
  const cert = (c: "explicit" | "inferred" | "uncertain"): Provenance => c;

  if (r.intent && (!s.intent || s.intent.value !== r.intent)) {
    // Asking about free slots inside a booking keeps the booking intent.
    if (!(r.intent === "availability" && s.intent?.value === "book")) {
      setFact(
        s,
        "intent",
        {
          value: r.intent,
          provenance: "explicit",
          evidence: r.text,
          alternatives: [],
          source: "caller",
        },
        "caller stated",
      );
    }
  }
  if (r.services.length === 1) {
    setFact(
      s,
      "service",
      {
        value: r.services[0]!,
        provenance: "explicit",
        evidence: r.text,
        alternatives: [],
        source: "caller",
      },
      r.correction ? "caller corrected" : "caller stated",
    );
  } else if (r.services.length > 1) {
    setFact(
      s,
      "service",
      {
        value: r.services[0]!,
        provenance: "uncertain",
        evidence: r.text,
        alternatives: r.services.slice(1),
        source: "caller",
      },
      "caller named several services",
    );
  }
  // A clarification with a single reading ("15 November next year?", "3 PM?")
  // answered with a plain yes: the caller has now said it.
  for (const k of ["date", "time"] as const) {
    const f = s[k] as Fact<unknown> | null;
    if (
      f?.provenance === "uncertain" &&
      f.alternatives.length === 0 &&
      s.lastQuestion === k &&
      r.affirm &&
      !r.correction &&
      !answeredReadBack &&
      !(k === "date" ? r.date : r.time)
    ) {
      f.provenance = "explicit";
      f.turn = s.turn;
    }
  }
  const dateQuestion = s.lastQuestion === "date";
  if (r.date) {
    let c = resolveDateCandidates(r.date.value, ctx);
    if (r.date.crossCheck?.length) c = crossCheckDate(c, r.date.crossCheck, ctx);
    if (c.passed) {
      // A day that has already passed is never booked; ask for another.
      if (r.correction || dateQuestion || !s.date) clearFact(s, "date", "the day named has passed");
    } else {
      setFact(
        s,
        "date",
        {
          value: c.primary,
          provenance:
            c.alternatives.length || c.nextYear || c.conflict
              ? "uncertain"
              : c.corroborated
                ? "explicit"
                : cert(r.date.certainty),
          evidence: c.nextYear ? `${r.date.evidence} (this year's has passed)` : r.date.evidence,
          alternatives: c.alternatives,
          source: "caller",
        },
        r.correction ? "caller corrected" : "caller stated",
      );
    }
  } else if (r.dateUnclear && (r.correction || dateQuestion)) {
    clearFact(s, "date", `caller's date unclear: ${r.dateUnclear}`);
  }
  if (!r.time && r.timeUnclear) {
    clearFact(s, "time", `caller's time unclear: ${r.timeUnclear}`);
  }
  // Naming one of the offered slots is a choice among them, not a new request.
  const offeredHit =
    s.booking.status === "slots_offered" && r.time && r.time.spec.kind === "exact"
      ? (s.booking.offered.find((o) => o.hhmm === (r.time!.spec as { hhmm: string }).hhmm) ??
        // "4" while 4 PM is on offer: the offer resolves the AM/PM doubt.
        s.booking.offered.find((o) =>
          r.time!.alternatives.some((a) => a.kind === "exact" && a.hhmm === o.hhmm),
        ))
      : undefined;
  if (r.time && offeredHit) {
    setFact(
      s,
      "time",
      {
        value: { kind: "exact", hhmm: offeredHit.hhmm },
        provenance: "explicit",
        evidence: r.time.evidence,
        alternatives: [],
        source: "caller",
      },
      "caller chose an offered slot",
      true,
    );
    s.booking.selected = offeredHit;
    s.booking.status = "slot_selected";
    s.currentTask = "confirming";
  } else if (r.time) {
    setFact(
      s,
      "time",
      {
        value: r.time.spec,
        provenance: cert(r.time.certainty),
        evidence: r.time.evidence,
        alternatives: r.time.alternatives,
        source: "caller",
      },
      r.correction ? "caller corrected" : "caller stated",
    );
  }
  // "4 or 5?" was asked and the caller answered with a question for the
  // calendar ("which one is free?"), deferred ("either", "you tell me"), or
  // did not resolve it: check the calendar for every candidate instead of
  // asking the same question again. Nothing is picked for the caller; they
  // choose among the free ones.
  if (
    s.time?.provenance === "uncertain" &&
    !r.time &&
    (r.asksAvailability || r.defers || (s.lastQuestion === "time" && (s.timesAsked.time ?? 0) >= 1))
  ) {
    const candidates = [s.time.value, ...s.time.alternatives];
    if (candidates.every((c) => c.kind === "exact")) {
      const hhmms = [...new Set(candidates.map((c) => (c as { hhmm: string }).hhmm))].sort();
      setFact(
        s,
        "time",
        {
          value: { kind: "anyOf", hhmms } as TimeSpec,
          provenance: "inferred",
          evidence: r.asksAvailability
            ? "caller asked which is free"
            : r.defers
              ? "caller left the choice to the calendar"
              : "clarification not answered",
          alternatives: [],
          source: "caller",
        },
        "check every candidate instead of asking again",
      );
    }
  }
  if (r.name) {
    setFact(
      s,
      "customerName",
      {
        value: r.name,
        provenance: "explicit",
        evidence: r.text,
        alternatives: [],
        source: "caller",
      },
      r.correction ? "caller corrected" : "caller stated",
    );
  }
  if (r.phoneDigits) {
    setFact(
      s,
      "phone",
      {
        value: r.phoneDigits,
        provenance: "explicit",
        evidence: r.text,
        alternatives: [],
        source: "caller",
      },
      "caller stated",
    );
  }

  // "Yes" to a single offered slot selects it.
  if (
    s.booking.status === "slots_offered" &&
    r.affirm &&
    !answeredReadBack &&
    s.booking.offered.length === 1
  ) {
    s.booking.selected = s.booking.offered[0]!;
    s.booking.status = "slot_selected";
    s.currentTask = "confirming";
  }

  // Wrapping up. A yes to a read-back is never a goodbye; a new request
  // in the same breath ("thanks, and a whitening too") reopens the call.
  const newRequest =
    r.services.length > 0 ||
    !!r.date ||
    !!r.time ||
    !!r.name ||
    !!r.phoneDigits ||
    r.intent !== null ||
    r.asksAvailability;
  if (answeredReadBack && r.affirm) {
    // A yes to a read-back moves the call on ("leave" answers set closing themselves).
  } else if (r.closing && !newRequest) {
    s.closing.requested = true;
    if (r.deny) s.closing.leaveConfirmed = true;
  } else if (newRequest) {
    s.closing = { requested: false, leaveConfirmed: false, closed: false };
    if (s.currentTask === "closed") s.currentTask = "collecting";
  }

  if (s.currentTask === "greeting") s.currentTask = "collecting";
  return s;
}

/**
 * Work the caller would lose by hanging up now: a booking under way, an
 * open clarification, or a booking request not finished.
 */
export function pendingWork(s: ConversationState): boolean {
  if (bookingExists(s)) return false;
  if (["slot_selected", "awaiting_final_confirmation", "booking"].includes(s.booking.status))
    return true;
  if ([s.service, s.date, s.time].some((f) => f?.provenance === "uncertain")) return true;
  return (
    s.intent?.value === "book" &&
    s.booking.status !== "no_availability" &&
    s.booking.status !== "failed"
  );
}

/* ------------------------------------------------------------------ */
/* What to do next                                                     */
/* ------------------------------------------------------------------ */

const usable = (f: Fact<unknown> | null): boolean => !!f && f.provenance !== "uncertain";

export function missingDetails(s: ConversationState): SlotName[] {
  const m: SlotName[] = [];
  if (!usable(s.service)) m.push("service");
  if (!usable(s.date)) m.push("date");
  if (!usable(s.time)) m.push("time");
  if (!usable(s.customerName)) m.push("customerName");
  if (
    !s.phone ||
    s.phone.provenance === "uncertain" ||
    (s.phone.source === "caller_id" && s.phone.provenance !== "confirmed")
  )
    m.push("phone");
  return m;
}

export function readyForAvailability(s: ConversationState): boolean {
  return usable(s.service) && usable(s.date) && usable(s.time);
}

const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Last line of defence before a calendar query: the day must be a real
 * date that has not passed (business time zone) and every time a valid
 * 24-hour HH:MM. Returns why not, or null when the request is usable.
 */
export function requestProblem(
  date: string,
  time: TimeSpec,
  ctx: Pick<BusinessContext, "timeZone" | "now">,
): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (
    !m ||
    Number(m[3]) < 1 ||
    Number(m[2]) < 1 ||
    Number(m[2]) > 12 ||
    Number(m[3]) > daysInMonth(Number(m[2]), Number(m[1]))
  )
    return "the date is not a real date";
  if (date < isoDateIn(ctx.timeZone, ctx.now())) return "the date has already passed";
  const times = time.kind === "period" ? [] : time.kind === "anyOf" ? time.hhmms : [time.hhmm];
  if (time.kind === "anyOf" && times.length === 0) return "no time was given";
  if (times.some((t) => !HHMM.test(t))) return "the time is not a valid clock time";
  return null;
}

export function readyToBook(s: ConversationState): { ok: true } | { ok: false; reason: string } {
  if (bookingExists(s)) return { ok: false, reason: "already_booked" };
  if (!s.booking.selected) return { ok: false, reason: "no_slot_selected" };
  if (s.booking.status !== "awaiting_final_confirmation")
    return { ok: false, reason: "caller_has_not_confirmed" };
  for (const k of ["service", "date", "time", "customerName", "phone"] as const) {
    if ((s[k] as Fact<unknown> | null)?.provenance !== "confirmed")
      return { ok: false, reason: `${k}_not_confirmed` };
  }
  return { ok: true };
}

export type NextStep =
  | { kind: "clarify"; slot: SlotName; options: string[] }
  | { kind: "ask"; slot: SlotName }
  | { kind: "confirm_caller_id"; digits: string }
  | { kind: "check_availability" }
  | { kind: "offer_slots" }
  /** The calendar has nothing free for what was asked: ask for another day or time. */
  | { kind: "ask_alternative" }
  | { kind: "final_confirmation" }
  | { kind: "book" }
  | { kind: "done" }
  /** The caller is wrapping up with work pending: ask once whether to finish it now. */
  | { kind: "confirm_leave" }
  /** Say goodbye: no questions, nothing reopened. */
  | { kind: "close"; outcome: "booked" | "not_booked" };

function describe(v: unknown, ctx?: BusinessContext): string {
  if (v && typeof v === "object" && "kind" in (v as object)) {
    const t = v as TimeSpec;
    if (t.kind === "period") return `in the ${t.period}`;
    if (t.kind === "anyOf")
      return `${t.hhmms.map(spokenTime).join(" or ")} (either suits the caller)`;
    return `${t.kind === "exact" ? "" : t.kind + " "}${spokenTime(t.hhmm)}`;
  }
  if (v && typeof v === "object" && "name" in (v as object)) return (v as ServiceRow).name;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return spokenDate(v, ctx);
  return String(v);
}

export function spokenTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  if (h === 0 && m === 0) return "12 midnight";
  if (h === 12 && m === 0) return "12 noon";
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

/** Exactly one thing to do next. Uncertainty is always resolved first. */
export function nextStep(s: ConversationState): NextStep {
  if (bookingExists(s))
    return s.closing.requested ? { kind: "close", outcome: "booked" } : { kind: "done" };
  if (s.closing.requested) {
    if (!s.closing.leaveConfirmed && pendingWork(s) && !s.timesAsked.leave)
      return { kind: "confirm_leave" };
    return { kind: "close", outcome: "not_booked" };
  }
  for (const k of ["service", "date", "time"] as const) {
    const f = s[k] as Fact<unknown> | null;
    if (f?.provenance === "uncertain") {
      return {
        kind: "clarify",
        slot: k,
        // Dates carry their year here: "15 November" may be next year's.
        options: [f.value, ...f.alternatives].map((v) =>
          k === "date" && typeof v === "string" ? `${describe(v)} ${v.slice(0, 4)}` : describe(v),
        ),
      };
    }
  }
  if (!usable(s.service)) return { kind: "ask", slot: "service" };
  if (!usable(s.date)) return { kind: "ask", slot: "date" };
  if (!usable(s.time)) return { kind: "ask", slot: "time" };
  if (s.booking.status === "no_availability") return { kind: "ask_alternative" };
  if (s.booking.status === "none" || s.booking.status === "failed")
    return { kind: "check_availability" };
  if (s.booking.status === "checking") return { kind: "check_availability" };
  if (s.booking.status === "slots_offered") return { kind: "offer_slots" };
  if (!usable(s.customerName)) return { kind: "ask", slot: "customerName" };
  if (s.phone?.source === "caller_id" && s.phone.provenance === "inferred")
    return { kind: "confirm_caller_id", digits: s.phone.value };
  if (!usable(s.phone)) return { kind: "ask", slot: "phone" };
  if (s.booking.status === "slot_selected") return { kind: "final_confirmation" };
  if (s.booking.status === "awaiting_final_confirmation" || s.booking.status === "booking")
    return { kind: "book" };
  return { kind: "done" };
}

/* ------------------------------------------------------------------ */
/* What the agent said                                                 */
/* ------------------------------------------------------------------ */

/**
 * Record what the agent finished saying. An interrupted reply is not a
 * question asked: the caller never heard it, so it is not counted and does
 * not open a read-back.
 */
export function agentSaid(
  s: ConversationState,
  step: NextStep,
  opts: { interrupted: boolean },
): void {
  if (opts.interrupted) return;
  if (step.kind === "close") {
    s.closing.closed = true;
    s.currentTask = "closed";
    s.lastQuestion = null;
    return;
  }
  if (step.kind === "done") s.bookingAnnounced = true;
  const slot: QuestionKey | null =
    step.kind === "ask" || step.kind === "clarify"
      ? step.slot
      : step.kind === "confirm_caller_id"
        ? "phone"
        : step.kind === "final_confirmation"
          ? "booking"
          : step.kind === "confirm_leave"
            ? "leave"
            : null;
  if (!slot) return;
  s.lastQuestion = slot;
  s.timesAsked[slot] = (s.timesAsked[slot] ?? 0) + 1;
  if (
    step.kind === "confirm_caller_id" ||
    step.kind === "final_confirmation" ||
    step.kind === "confirm_leave"
  )
    s.pendingReadBack = slot;
}

/** For the model: the state as plain facts, with their standing. */
export function stateSummary(s: ConversationState, ctx?: BusinessContext): string {
  const d = (v: unknown) => describe(v, ctx);
  const line = (label: string, f: Fact<unknown> | null) =>
    f
      ? `- ${label}: ${d(f.value)} [${f.provenance}${f.alternatives.length ? `; could also be ${f.alternatives.map(d).join(" / ")}` : ""}]`
      : `- ${label}: (unknown)`;
  const now = ctx ? ctx.now() : null;
  return [
    ctx && now
      ? `Today at the business: ${spokenDate(isoDateIn(ctx.timeZone, now))}, ${new Intl.DateTimeFormat("en-GB", { timeZone: ctx.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now)} (${ctx.timeZone}). Dates below are already resolved; never compute or change a date yourself.`
      : "",
    `Caller language now: ${s.language.current}`,
    line("intent", s.intent),
    line("service", s.service),
    line("date", s.date),
    line("time", s.time),
    line("name", s.customerName),
    line("phone", s.phone),
    `- booking: ${s.booking.status}${s.booking.selected ? ` (${spokenTime(s.booking.selected.hhmm)})` : ""}${s.booking.bookingId ? ` id=${s.booking.bookingId}` : ""}`,
    s.booking.offered.length
      ? `- slots the calendar offered: ${s.booking.offered.map((o) => spokenTime(o.hhmm)).join(", ")}`
      : "",
    s.booking.status === "no_availability" && s.booking.checked
      ? `- the calendar has nothing free for ${d(s.booking.checked.date)}, ${s.booking.checked.time}`
      : "",
    s.closing.requested ? "- the caller is wrapping up the call" : "",
  ]
    .filter(Boolean)
    .join("\n");
}
