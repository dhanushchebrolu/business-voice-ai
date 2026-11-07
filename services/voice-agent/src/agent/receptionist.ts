/**
 * The receptionist as a LiveKit Agent.
 *
 * Division of labour (the boundary this service is built around):
 *   - conversation/ (deterministic): what the caller said, what is known,
 *     inferred, uncertain or confirmed, and the single next step;
 *   - the LLM: phrases that next step in the caller's language, and calls
 *     tools that take NO business values from it (they read the state);
 *   - klyro (via BookingBackend): availability, prices, bookings, calendar,
 *     tenant authorization — the only source of truth;
 *   - conversation/guard.ts: drops any sentence that would mislead.
 */
import {
  TransformStream,
  type ReadableStream,
  type TransformStreamDefaultController,
} from "node:stream/web";
import { llm, voice } from "@livekit/agents";
import { VOICE_LANGUAGES } from "../../../../src/lib/voice-languages.ts";
import { callOutcomeLine } from "../../../../src/lib/voice-call-outcomes.ts";
import { z } from "zod";
import type { BookingBackend, Slot } from "../backend/types.ts";
import { PHRASES, ReplyGuard, slotList, type GuardRemoval } from "../conversation/guard.ts";
import {
  agentSaid,
  applyReading,
  bookingExists,
  describeExistingBooking,
  isoDateIn,
  readyToReschedule,
  rescheduling,
  selectRescheduleTarget,
  nextStep,
  readyForAvailability,
  requestProblem,
  readyToBook,
  spokenDate,
  spokenTime,
  stateSummary,
  type BusinessContext,
  type ConversationState,
  type NextStep,
} from "../conversation/state.ts";
import {
  detectLanguage,
  readUtterance,
  type LanguageCode,
  type TimeSpec,
} from "../conversation/understanding.ts";

/**
 * One guarded reply, for audits and tests: what the model produced, what the
 * caller heard, and why anything was removed. Holds caller-facing text (it
 * can contain a name or number), so production telemetry should log only
 * rules and reasons; the full report is for test and smoke-test records.
 */
export interface GuardReport {
  /** The state's step when the reply was generated. */
  step: NextStep["kind"];
  /** Everything the model said, unmodified. */
  original: string;
  /** What the caller heard: the kept sentences, plus any fallback line. */
  modified: string;
  removed: GuardRemoval[];
  /** The fixed line spoken when nothing safe was left, or null. */
  fallback: string | null;
  languages: {
    /** The caller's language in the call state. */
    caller: LanguageCode;
    /** The language the model replied in (by script), or null if it could not be told. */
    response: LanguageCode | null;
    /** The language of what the caller heard. */
    spoken: LanguageCode | null;
  };
}

/**
 * The fallback line's language: the language the model was already speaking
 * (so a guard intervention never silently switches language mid-reply), or
 * the caller's when the reply carries no language signal.
 */
export function fallbackLanguage(original: string, caller: LanguageCode): LanguageCode {
  return detectLanguage(original, null) ?? caller;
}

export interface ReceptionistDeps {
  business: BusinessContext;
  backend: BookingBackend;
  state: ConversationState;
  /** Extra business instructions from klyro (buildAgentInstructions); facts only. */
  businessInstructions?: string;
  onTurn?: (info: {
    step: NextStep;
    state: ConversationState;
    language: LanguageCode;
    /** How this turn's service words resolved (enum and candidate count only; never the words). */
    serviceMatch: { kind: string; candidates: number };
  }) => void;
  /** Removed sentences (rule, exact text, reason) and the full report for this reply. */
  onGuard?: (removed: ReplyGuard["removed"], report: GuardReport) => void;
  onTool?: (info: { name: string; ok: boolean; ms: number; detail?: string }) => void;
}

/** Language names as the production runtime names them (voice-languages.ts). */
const LANGUAGE_NAME = Object.fromEntries(VOICE_LANGUAGES.map((l) => [l.code, l.name])) as Record<
  LanguageCode,
  string
>;
const SPOKEN_LANGUAGES = VOICE_LANGUAGES.map((l) => l.name).join(", ");

/** The production runtime's own line for this situation in the caller's language, as a wording hint (non-English only). */
function suggest(s: ConversationState, key: Parameters<typeof callOutcomeLine>[1]): string {
  const target = s.reschedule.target;
  const line = callOutcomeLine(s.language.current, key, {
    ...(target ? { appointment: { service: target.serviceName, startIso: target.startIso } } : {}),
    ...(s.date ? { date: s.date.value } : {}),
    ...(s.booking.selected ? { time: s.booking.selected.hhmm } : {}),
  });
  return line ? ` Suggested wording: "${line}"` : "";
}

function instructionFor(step: NextStep, s: ConversationState): string {
  const p = PHRASES[s.language.current];
  const again = (key: keyof ConversationState["timesAsked"]) =>
    (s.timesAsked[key] ?? 0) > 0
      ? " You asked this before and it was not answered: ask it differently (shorter, with the options spelled out), not word for word."
      : "";
  switch (step.kind) {
    case "clarify":
      return `The caller's ${step.slot} is ambiguous: it could be ${step.options.join(" or ")}. Ask which one they mean. Do not choose for them.${again(step.slot)}`;
    case "ask":
      return `Ask for the ${step.slot} only. Suggested wording: "${p[step.slot]}"${again(step.slot)}`;
    case "confirm_caller_id":
      return `Ask whether to use the number they are calling from, ending in ${step.digits.slice(-4)}. Do not assume yes.`;
    case "check_availability":
      return "Say one short line that you are checking, then call the check_availability tool. Never guess which times are free.";
    case "offer_slots":
      return `Offer exactly these times from the calendar${s.date ? ` for ${spokenDate(s.date.value)}` : ""} and ask which one suits them: ${slotList(s)}. Offer no other time.`;
    case "ask_alternative":
      return `The calendar has nothing free for what the caller asked${s.booking.checked ? ` (${s.booking.checked.time})` : ""}. Say so plainly, then ask for another day or time. Do not suggest any time yourself and do not say anything is free.`;
    case "final_confirmation":
      return rescheduling(s) && s.reschedule.target
        ? `Read back once: move their ${describeExistingBooking(s.reschedule.target)} to ${s.booking.selected ? `${s.date ? spokenDate(s.date.value) : "the new day"} at ${spokenTime(s.booking.selected.hhmm)}` : "the new time"}, then ask the caller to confirm. Do not say it is moved.${suggest(s, "rescheduleConfirm")}`
        : "Read back service, day, time, name and phone number once, then ask the caller to confirm. Do not say it is booked.";
    case "book":
      return rescheduling(s)
        ? "The caller confirmed. Call the reschedule_appointment tool now. Do not say it is moved until the tool says so; nothing new is booked."
        : "The caller confirmed. Call the book_appointment tool now. Do not say it is booked until the tool says so.";
    case "find_bookings":
      return "The caller wants to change an existing appointment. Say one short line that you are looking it up, then call the find_my_bookings tool. Do not ask for the service, name or phone number.";
    case "choose_booking":
      return `The caller has these upcoming appointments: ${step.options.join("; ")}. Ask which one they want to move. Do not choose for them.${again("booking")}`;
    case "reschedule_unavailable":
      return (
        {
          no_caller_id:
            "Their caller ID is not available, so their appointment cannot be found or changed on this call. Say so briefly and suggest calling from the number it was booked with, or contacting the clinic. Do not say anything was changed.",
          not_found:
            "No upcoming appointment was found for the number they are calling from. Say so briefly and offer to book a new one instead. Do not say anything was changed.",
          lookup_failed:
            "Their appointments could not be looked up just now. Apologise briefly and suggest trying again in a little while. Do not say anything was changed.",
          not_allowed:
            "Appointments cannot be changed on this line. Say so briefly and suggest contacting the clinic. Do not say anything was changed.",
        }[step.why] +
        suggest(
          s,
          step.why === "no_caller_id"
            ? "rescheduleNeedsCallerNumber"
            : step.why === "not_found"
              ? "rescheduleNotFound"
              : step.why === "lookup_failed"
                ? "rescheduleLookupFailed"
                : "rescheduleNotPossible",
        )
      );
    case "reschedule_failed":
      return `The appointment could not be moved (${s.reschedule.error ?? "error"}); it stays as it was. Say so plainly and suggest contacting the clinic. Do not say it was moved.${suggest(s, "rescheduleNotPossible")}`;
    case "rescheduled":
      if (s.bookingAnnounced)
        return "The change was already announced. Answer only what the caller just said; do not repeat it.";
      return step.pendingSync
        ? "The appointment was moved in the system, but the clinic calendar is not updated yet: tell the caller it is changed and the clinic team will confirm it. Do not say it is fully confirmed."
        : "The appointment was moved, confirmed by the system. Tell the caller the new day and time and ask if there is anything else.";
    case "confirm_leave":
      return "The caller sounds like they are finishing, but the booking is not done. Ask once, briefly: do they want to finish booking now, or leave it for now? Do not say anything is booked.";
    case "close":
      return step.outcome === "booked"
        ? "The caller is finishing the call and the booking is already settled. Thank them and say goodbye in one short sentence. Ask no question, and do not repeat or reopen the booking details."
        : "The caller is finishing the call. Thank them and say goodbye in one short sentence. Ask no question, ask for no details, and do not say anything is booked.";
    case "done":
      if (s.bookingAnnounced) {
        return "The booking was already announced. Answer only what the caller just said; do not repeat the booking and do not ask for any booking detail again.";
      }
      if (s.booking.status === "confirmed") {
        return "The booking is confirmed by the system. Tell the caller it is booked and ask if there is anything else.";
      }
      if (s.booking.status === "held_pending_sync") {
        return "The booking is saved and the slot is held, but it is not fully confirmed yet: tell the caller it is saved and the clinic team will confirm it. Do not say it is confirmed.";
      }
      if (s.booking.status === "payment_pending") {
        return s.booking.paymentLinkSent
          ? "This service needs payment before the booking is confirmed. The slot is held for them and a payment link has been sent to them on WhatsApp. Explain that the booking is confirmed only once the payment is received. Do not say it is booked or confirmed."
          : "This service needs payment before the booking is confirmed. The slot is held, but the payment link could not be sent just now; the clinic team will send it. Explain that the booking is confirmed only once the payment is received. Do not say it is booked or confirmed.";
      }
      return "The booking request is recorded but not confirmed yet. Tell the caller the team will confirm it. Do not say it is booked.";
  }
}

export function directive(step: NextStep, s: ConversationState, ctx?: BusinessContext): string {
  return [
    "CALL STATE (authoritative; values marked inferred/uncertain are NOT facts the caller confirmed):",
    stateSummary(s, ctx),
    "",
    `NEXT STEP: ${instructionFor(step, s)}`,
    `Reply in ${LANGUAGE_NAME[s.language.current]}, the language the caller just used. Keep it short and natural for a phone call.`,
    s.language.unsupportedHeard && !s.language.unsupportedExplained
      ? `The caller may be speaking a language you cannot speak. First say briefly, in ${LANGUAGE_NAME[s.language.current]}, that you can speak ${SPOKEN_LANGUAGES}, and ask them to continue in one of those.`
      : "",
    "Ask at most one question. Never repeat a question the caller already answered.",
    "Never invent prices, hours, services, free times, customer records, booking ids or confirmation status; only say what is in CALL STATE or a tool result.",
  ]
    .filter(Boolean)
    .join("\n");
}

function timeWindow(t: TimeSpec | undefined): {
  notBefore?: string | undefined;
  notAfter?: string | undefined;
} {
  if (!t) return {};
  if (t.kind === "anyOf") return { notBefore: t.hhmms[0], notAfter: t.hhmms[t.hhmms.length - 1] };
  if (t.kind === "after") return { notBefore: t.hhmm };
  if (t.kind === "before") return { notAfter: t.hhmm };
  if (t.kind === "period") {
    return t.period === "morning"
      ? { notBefore: "08:00", notAfter: "11:59" }
      : t.period === "afternoon"
        ? { notBefore: "12:00", notAfter: "16:59" }
        : { notBefore: "17:00", notAfter: "21:00" };
  }
  return {};
}

function hhmmOf(startIso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(startIso));
}

export interface UsableSlot {
  startIso: string;
  endIso: string;
  hhmm: string;
}

/**
 * The only slots the agent may offer: well-formed, on the requested business
 * date, within the requested window, not in the past, de-duplicated and in
 * order. A backend answer that is not a list is malformed (never "nothing
 * free"); individual bad entries are dropped and counted.
 */
export function usableSlots(
  raw: unknown,
  q: { date: string; notBefore?: string | undefined; notAfter?: string | undefined },
  ctx: Pick<BusinessContext, "timeZone" | "now">,
): { ok: true; slots: UsableSlot[]; dropped: number } | { ok: false; error: "malformed_response" } {
  if (!Array.isArray(raw)) return { ok: false, error: "malformed_response" };
  const now = ctx.now().getTime();
  const seen = new Set<string>();
  const slots: UsableSlot[] = [];
  let dropped = 0;
  for (const x of raw as unknown[]) {
    const o = x as Partial<Slot> | null;
    const start = typeof o?.startIso === "string" ? Date.parse(o.startIso) : NaN;
    const end = typeof o?.endIso === "string" ? Date.parse(o.endIso) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      dropped++;
      continue;
    }
    const startIso = new Date(start).toISOString();
    const hhmm = hhmmOf(startIso, ctx.timeZone);
    if (
      isoDateIn(ctx.timeZone, new Date(start)) !== q.date ||
      start <= now ||
      (q.notBefore && hhmm < q.notBefore) ||
      (q.notAfter && hhmm > q.notAfter) ||
      seen.has(startIso)
    ) {
      dropped++;
      continue;
    }
    seen.add(startIso);
    slots.push({ startIso: o!.startIso!, endIso: o!.endIso!, hhmm });
  }
  slots.sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso));
  return { ok: true, slots, dropped };
}

function describeWant(t: TimeSpec): string {
  if (t.kind === "anyOf") return t.hhmms.map(spokenTime).join(" or ");
  if (t.kind === "period") return `the ${t.period}`;
  return `${t.kind === "exact" ? "" : `${t.kind} `}${spokenTime(t.hhmm)}`;
}

export function buildTools(d: ReceptionistDeps, knownPrices: Set<number>) {
  const s = d.state;
  /** End time of each offered slot, as the calendar returned it (per call). */
  const slotEnds = new Map<string, string>();
  const timed = async <T>(
    name: string,
    fn: () => Promise<T>,
    ok: (r: T) => boolean,
    detail?: (r: T) => string,
  ) => {
    const t0 = performance.now();
    const run: ConversationState["tools"][number] = { name, status: "running", turn: s.turn };
    s.tools.push(run);
    try {
      const r = await fn();
      run.status = ok(r) ? "succeeded" : "failed";
      if (detail) run.detail = detail(r);
      d.onTool?.({
        name,
        ok: ok(r),
        ms: performance.now() - t0,
        ...(run.detail ? { detail: run.detail } : {}),
      });
      return r;
    } catch (e) {
      run.status = "failed";
      run.detail = (e as Error).message;
      d.onTool?.({ name, ok: false, ms: performance.now() - t0, detail: run.detail });
      throw e;
    }
  };
  return {
    check_availability: llm.tool({
      description:
        "Ask the clinic calendar which times are free for the caller's service, day and time preference (all taken from the call state). The only way to know availability.",
      parameters: z.object({}),
      execute: async () => {
        if (!readyForAvailability(s))
          return "NOT_READY: the service, day and time are not all known yet.";
        const problem = requestProblem(s.date!.value, s.time!.value, d.business);
        if (problem)
          return `NOT_READY: ${problem}. Ask the caller for the day and time again; do not guess.`;
        s.booking.status = "checking";
        s.currentTask = "checking_availability";
        s.booking.unavailable = []; // evidence is per check: never carried over
        const want = s.time!.value;
        const date = s.date!.value; // resolved from the caller's words; tools take no model arguments
        const window = timeWindow(want);
        const res = await timed(
          "check_availability",
          () =>
            d.backend.checkAvailability({
              serviceId: s.service!.value.id,
              date,
              durationMinutes: s.service!.value.durationMinutes || 30,
              ...window,
            }),
          (r) => !!r && r.ok === true && Array.isArray(r.slots),
          (r) =>
            r?.ok
              ? Array.isArray(r.slots)
                ? `${r.slots.length} slots`
                : "malformed"
              : String(r?.error),
        );
        if (!res || !res.ok) {
          s.booking.status = "failed";
          s.booking.error = res?.error ?? "no_response";
          return `FAILED: the calendar could not be checked (${s.booking.error}). Nothing is booked. Apologise and offer to try again.`;
        }
        const usable = usableSlots(res.slots, { date, ...window }, d.business);
        if (!usable.ok) {
          // A malformed answer is not "nothing free": never claim either way.
          s.booking.status = "failed";
          s.booking.error = usable.error;
          return "FAILED: the calendar could not be checked (malformed_response). Nothing is booked. Apologise and offer to try again.";
        }
        // The caller's own times the calendar did not return as free: the only
        // times the agent may call unavailable (a failed check proves nothing).
        const freeNow = new Set(usable.slots.map((x) => x.hhmm));
        const requested =
          want.kind === "exact" ? [want.hhmm] : want.kind === "anyOf" ? want.hhmms : [];
        s.booking.unavailable = requested.filter((h) => !freeNow.has(h));
        let slots = usable.slots;
        if (want.kind === "exact") {
          const exact = slots.find((x) => x.hhmm === want.hhmm);
          slots = exact ? [exact] : slots.slice(0, 3);
        } else if (want.kind === "anyOf") {
          // Only the caller's own candidates: "4 or 5" is never answered with 4:30.
          slots = slots.filter((x) => want.hhmms.includes(x.hhmm));
        } else {
          slots = slots.slice(0, 3);
        }
        s.booking.offered = slots.map(({ startIso, hhmm }) => ({ startIso, hhmm }));
        slotEnds.clear();
        for (const x of slots) slotEnds.set(x.startIso, x.endIso);
        s.currentTask = "choosing_slot";
        if (!slots.length) {
          s.booking.status = "no_availability";
          s.booking.checked = { date, time: describeWant(want) };
          return "NO_SLOTS: nothing is free for that day and time. Ask for another day or time.";
        }
        s.booking.status = "slots_offered";
        s.booking.checked = null;
        if (want.kind === "exact" && slots.length === 1 && slots[0]!.hhmm === want.hhmm) {
          return `AVAILABLE: ${spokenTime(want.hhmm)} is free. Ask if they want it.`;
        }
        if (want.kind === "anyOf") {
          const free = new Set(slots.map((x) => x.hhmm));
          const taken = want.hhmms.filter((h) => !free.has(h));
          return `OFFER: ${taken.length ? `${taken.map(spokenTime).join(", ")} ${taken.length > 1 ? "are" : "is"} not free. ` : ""}Free times: ${slots
            .map((x) => spokenTime(x.hhmm))
            .join(", ")}. Ask which one.`;
        }
        return `OFFER: ${want.kind === "exact" ? `${spokenTime(want.hhmm)} is not free. ` : ""}Free times: ${slots
          .map((x) => spokenTime(x.hhmm))
          .join(", ")}. Ask which one.`;
      },
    }),
    book_appointment: llm.tool({
      description:
        "Book the slot the caller chose. Only works after the caller confirmed the read-back of service, day, time, name and phone. Uses the call state; takes no arguments.",
      parameters: z.object({}),
      execute: async () => {
        const ready = readyToBook(s);
        if (!ready.ok) return `NOT_ALLOWED: ${ready.reason}. Do not tell the caller it is booked.`;
        s.booking.status = "booking";
        const sel = s.booking.selected!;
        const endIso =
          slotEnds.get(sel.startIso) ??
          new Date(
            new Date(sel.startIso).getTime() + (s.service!.value.durationMinutes || 30) * 60_000,
          ).toISOString();
        const res = await timed(
          "book_appointment",
          () =>
            d.backend.book({
              serviceId: s.service!.value.id,
              serviceName: s.service!.value.name,
              slot: { startIso: sel.startIso, endIso },
              customerName: s.customerName!.value,
              customerPhone: s.phone!.value,
            }),
          (r) => r.ok,
          (r) => (r.ok ? r.outcome : r.error),
        );
        if (res.ok) {
          s.booking.bookingId = res.bookingId;
          s.currentTask = "done";
          if (res.outcome === "confirmed") {
            s.booking.status = "confirmed";
            return `BOOKED: the booking for ${spokenTime(sel.hhmm)} is confirmed.`;
          }
          if (res.outcome === "payment_pending") {
            // G5: held until paid. Never "confirmed" (the guard also blocks
            // any "booked"/"confirmed" claim unless the status is confirmed).
            s.booking.status = "payment_pending";
            s.booking.paymentLinkSent = res.payment?.linkSent === true;
            return s.booking.paymentLinkSent
              ? `PAYMENT_PENDING: ${spokenTime(sel.hhmm)} is held until the payment is received; the payment link was sent on WhatsApp. It is NOT confirmed yet. Do not say it is booked or confirmed.`
              : `PAYMENT_PENDING: ${spokenTime(sel.hhmm)} is held until the payment is received, but the payment link could not be sent just now; the clinic team will send it. It is NOT confirmed. Do not say it is booked or confirmed.`;
          }
          if (res.outcome === "saved_calendar_sync_failed") {
            s.booking.status = "held_pending_sync";
            return `SAVED_NOT_CONFIRMED: the booking for ${spokenTime(sel.hhmm)} is saved and the slot is held, but the calendar could not be updated; the clinic team will confirm it. Do not say it is confirmed.`;
          }
          s.booking.status = "pending";
          return "PENDING: the request is recorded but not confirmed yet. Tell the caller the team will confirm it.";
        }
        s.booking.error = res.error;
        if (res.error === "slot_taken") {
          s.booking.status = "none";
          s.booking.offered = [];
          s.booking.selected = null;
          // The backend just proved this time is taken: the agent may say so.
          s.booking.unavailable = [sel.hhmm];
          return `SLOT_TAKEN: ${res.message} Nothing is booked. Apologise and check availability again.`;
        }
        if (res.retryable) {
          // Same call + same slot = same idempotency key at klyro: a retry cannot double-book.
          s.booking.status = "awaiting_final_confirmation";
          return `FAILED: ${res.message} Nothing is booked yet. Offer to try again.`;
        }
        s.booking.status = "failed";
        return `NOT_BOOKED: ${res.message} Nothing is booked. Offer to have the clinic call back.`;
      },
    }),
    find_my_bookings: llm.tool({
      description:
        "Look up the caller's own upcoming appointments (identified by the number they are calling from), to change one. Takes no arguments.",
      parameters: z.object({}),
      execute: async () => {
        if (s.reschedule.status !== "looking_up")
          return "NOT_NEEDED: the appointment to change is already known or not being changed.";
        if (!d.backend.findMyBookings) {
          s.reschedule = { ...s.reschedule, status: "unavailable", why: "not_allowed" };
          return "NOT_AVAILABLE: appointments cannot be changed on this line.";
        }
        const res = await timed(
          "find_my_bookings",
          () => d.backend.findMyBookings!(),
          (r) => r.ok,
          (r) => (r.ok ? `${r.bookings.length} bookings` : r.error),
        );
        if (!res.ok) {
          s.reschedule = {
            ...s.reschedule,
            status: "unavailable",
            why: res.error === "not_allowed" ? "not_allowed" : "lookup_failed",
          };
          return "LOOKUP_FAILED: the appointments could not be looked up. Nothing was changed.";
        }
        if (!res.callerIdentified) {
          s.reschedule = { ...s.reschedule, status: "unavailable", why: "no_caller_id" };
          return "NO_CALLER_ID: without the caller's number their appointments cannot be found. Nothing was changed.";
        }
        const tz = d.business.timeZone;
        const bookings = res.bookings
          .filter(
            (b) => Number.isFinite(Date.parse(b.startIso)) && Number.isFinite(Date.parse(b.endIso)),
          )
          .map((b) => ({
            ...b,
            date: isoDateIn(tz, new Date(b.startIso)),
            hhmm: hhmmOf(b.startIso, tz),
          }));
        if (!bookings.length) {
          s.reschedule = { ...s.reschedule, status: "unavailable", why: "not_found" };
          return "NOT_FOUND: no upcoming appointment for the caller's number. Nothing was changed.";
        }
        s.reschedule.bookings = bookings;
        if (bookings.length === 1) {
          selectRescheduleTarget(s, bookings[0]!, d.business);
          return `FOUND: ${describeExistingBooking(bookings[0]!, d.business)}. Ask for the new day and time.`;
        }
        s.reschedule.status = "choose";
        return `FOUND ${bookings.length}: ${bookings.map((b) => describeExistingBooking(b, d.business)).join("; ")}. Ask which one to move.`;
      },
    }),
    reschedule_appointment: llm.tool({
      description:
        "Move the caller's chosen appointment to the new time they confirmed (taken from the call state). Never creates a new booking. Takes no arguments.",
      parameters: z.object({}),
      execute: async () => {
        const ready = readyToReschedule(s);
        if (!ready.ok) return `NOT_ALLOWED: ${ready.reason}. Do not tell the caller it is moved.`;
        if (!d.backend.reschedule) {
          s.reschedule = { ...s.reschedule, status: "failed", error: "not_allowed" };
          return "NOT_MOVED: appointments cannot be changed on this line.";
        }
        const sel = s.booking.selected!;
        const target = s.reschedule.target!;
        const length = Date.parse(target.endIso) - Date.parse(target.startIso);
        const endIso =
          slotEnds.get(sel.startIso) ??
          new Date(
            new Date(sel.startIso).getTime() +
              (s.service?.value.durationMinutes
                ? s.service.value.durationMinutes * 60_000
                : length),
          ).toISOString();
        s.booking.status = "booking";
        const res = await timed(
          "reschedule_appointment",
          () =>
            d.backend.reschedule!({
              bookingId: target.id,
              slot: { startIso: sel.startIso, endIso },
            }),
          (r) => r.ok,
          (r) => (r.ok ? r.outcome : r.error),
        );
        if (res.ok) {
          s.reschedule.status = res.outcome === "confirmed" ? "moved" : "moved_pending_sync";
          s.booking.status = "none";
          s.currentTask = "done";
          return res.outcome === "confirmed"
            ? `MOVED: the appointment is now at ${spokenTime(sel.hhmm)}, confirmed by the system.`
            : `MOVED_NOT_SYNCED: the appointment is moved to ${spokenTime(sel.hhmm)} in the system, but the clinic calendar is not updated yet; the team will confirm it. Do not say it is fully confirmed.`;
        }
        if (res.error === "slot_taken") {
          s.booking.status = "none";
          s.booking.offered = [];
          s.booking.selected = null;
          s.booking.unavailable = [sel.hhmm];
          return `SLOT_TAKEN: ${res.message} The appointment was NOT moved; it stays at its old time. Apologise and check availability again.`;
        }
        if (res.retryable) {
          s.booking.status = "awaiting_final_confirmation";
          return `FAILED: ${res.message} The appointment was NOT moved yet. Offer to try again.`;
        }
        s.reschedule = { ...s.reschedule, status: "failed", error: res.error };
        s.booking.status = "none";
        return `NOT_MOVED: ${res.message} The appointment stays at its old time.`;
      },
    }),
    get_service_price: llm.tool({
      description:
        "The clinic's price for the caller's service. Never state a price that this tool did not return.",
      parameters: z.object({}),
      execute: async () => {
        if (!s.service || s.service.provenance === "uncertain")
          return "NOT_READY: the service is not known yet.";
        const price = s.service.value.priceInr ?? null;
        if (price === null)
          return "UNKNOWN: the clinic has not published a price. Say a staff member can confirm it.";
        knownPrices.add(price);
        return `PRICE: ${s.service.value.name} costs ₹${price}.`;
      },
    }),
  };
}

export class ReceptionistAgent extends voice.Agent {
  readonly deps: ReceptionistDeps;
  private lastStep: NextStep = { kind: "ask", slot: "service" };
  private sttLanguage: string | null = null;
  private readonly knownPrices: Set<number>;
  private observedMessageId: string | null = null;
  /** The current directive asks the model to name the supported languages (see directive). */
  private explainingUnsupported = false;

  constructor(deps: ReceptionistDeps) {
    const knownPrices = new Set<number>();
    super({
      instructions:
        `You are the phone receptionist for ${deps.business.businessName}. You speak ${SPOKEN_LANGUAGES}. ` +
        "Each turn you receive the call state and one NEXT STEP; do exactly that step." +
        (deps.businessInstructions
          ? `\n\nBUSINESS FACTS (do not state anything else as fact):\n${deps.businessInstructions}`
          : ""),
      tools: buildTools(deps, knownPrices),
    });
    this.deps = deps;
    this.knownPrices = knownPrices;
  }

  setSttLanguage(code: string | null): void {
    this.sttLanguage = code;
  }

  /** What the caller actually heard; interrupted speech doesn't count as asked. */
  recordSpoken(interrupted: boolean): void {
    agentSaid(this.deps.state, this.lastStep, { interrupted });
    if (!interrupted && this.explainingUnsupported) {
      this.deps.state.language.unsupportedExplained = true;
      this.explainingUnsupported = false;
    }
  }

  bookingExists(): boolean {
    return bookingExists(this.deps.state);
  }

  /**
   * Reads the caller's newest message into the state (once per message) and
   * returns the context for this generation. Runs inside llmNode, which
   * LiveKit calls for every reply in audio and text sessions alike (unlike
   * onUserTurnCompleted, which only fires at the end of an audio turn), and
   * again after each tool result, so the directive always reflects the
   * latest booking state.
   */
  private prepare(chatCtx: llm.ChatContext): llm.ChatContext {
    const s = this.deps.state;
    const ctx = chatCtx.copy();
    const last = ctx.items[ctx.items.length - 1];
    if (
      last &&
      last.type === "message" &&
      last.role === "user" &&
      last.id !== this.observedMessageId
    ) {
      this.observedMessageId = last.id;
      const reading = readUtterance(last.textContent ?? "", {
        catalog: this.deps.business.services,
        sttLanguage: this.sttLanguage,
        // Natural-language service matching while the service is open,
        // being clarified or was just asked for; once it is settled only a
        // configured name (or a correction) can change it.
        fuzzyServices:
          !s.service || s.service.provenance === "uncertain" || s.lastQuestion === "service",
      });
      applyReading(s, reading, this.deps.business);
      const tts = this.session?.tts as
        { updateOptions?: (o: { targetLanguageCode: string }) => void } | undefined;
      tts?.updateOptions?.({ targetLanguageCode: s.language.current });
      this.lastStep = nextStep(s);
      this.deps.onTurn?.({
        step: this.lastStep,
        state: s,
        language: s.language.current,
        serviceMatch: { kind: reading.serviceMatch, candidates: reading.services.length },
      });
    } else {
      this.lastStep = nextStep(s);
    }
    this.explainingUnsupported = !!s.language.unsupportedHeard && !s.language.unsupportedExplained;
    ctx.items.splice(
      Math.max(0, ctx.items.length - 1),
      0,
      llm.ChatMessage.create({
        role: "system",
        content: directive(this.lastStep, s, this.deps.business),
      }),
    );
    return ctx;
  }

  /** Guards the model's text sentence by sentence while it streams. */
  override async llmNode(
    chatCtx: llm.ChatContext,
    toolCtx: llm.ToolContext,
    modelSettings: voice.ModelSettings,
  ): ReturnType<voice.Agent["llmNode"]> {
    const upstream = await voice.Agent.default.llmNode(
      this,
      this.prepare(chatCtx),
      toolCtx,
      modelSettings,
    );
    if (!upstream) return null;
    type Out =
      NonNullable<Awaited<ReturnType<voice.Agent["llmNode"]>>> extends ReadableStream<infer T>
        ? T
        : never;
    const guard = new ReplyGuard(this.deps.state, {
      knownPrices: [...this.knownPrices],
      // A goodbye asks nothing: no "anything else?", no booking questions.
      noQuestions: this.lastStep.kind === "close",
    });
    const state = this.deps.state;
    const onGuard = this.deps.onGuard;
    const stepKind = this.lastStep.kind;
    let buffer = "";
    let original = "";
    let heard = "";
    let spoke = false;
    let calledTool = false;
    const say = (controller: TransformStreamDefaultController<Out>, text: string) => {
      controller.enqueue(text);
      heard += text;
      spoke = true;
    };
    const flushSentences = (controller: TransformStreamDefaultController<Out>, final: boolean) => {
      let consumed = 0;
      for (const m of buffer.matchAll(/[^.!?।\n]+[.!?।\n]+/g)) {
        const ok = guard.check(m[0]);
        if (ok) say(controller, ok);
        consumed = m.index! + m[0].length;
      }
      buffer = buffer.slice(consumed);
      if (final && buffer.trim()) {
        const ok = guard.check(buffer);
        if (ok) say(controller, ok);
        buffer = "";
      }
    };
    return upstream.pipeThrough(
      new TransformStream<Out, Out>({
        transform(chunk, controller) {
          if (typeof chunk === "symbol") {
            flushSentences(controller, true);
            controller.enqueue(chunk);
            return;
          }
          if (typeof chunk === "string") {
            buffer += chunk;
            original += chunk;
            flushSentences(controller, false);
            return;
          }
          if (chunk.delta?.toolCalls?.length) calledTool = true;
          const content = chunk.delta?.content;
          if (content) {
            buffer += content;
            original += content;
            flushSentences(controller, false);
            const { content: _drop, ...rest } = chunk.delta!;
            if (rest.toolCalls?.length)
              controller.enqueue({ ...chunk, delta: { ...rest, role: rest.role ?? "assistant" } });
            return;
          }
          controller.enqueue(chunk);
        },
        flush(controller) {
          flushSentences(controller, true);
          if (!guard.removed.length) return;
          let fallback: string | null = null;
          if (!spoke && !calledTool) {
            const p = PHRASES[fallbackLanguage(original, state.language.current)];
            const step = nextStep(state);
            fallback =
              step.kind === "ask"
                ? p[step.slot]
                : step.kind === "check_availability"
                  ? p.checking
                  : step.kind === "close"
                    ? p.goodbye
                    : step.kind === "ask_alternative"
                      ? p.noneFree
                      : p.notYetBooked;
            say(controller, fallback);
          }
          onGuard?.(guard.removed, {
            step: stepKind,
            original,
            modified: heard,
            removed: [...guard.removed],
            fallback,
            languages: {
              caller: state.language.current,
              response: detectLanguage(original, null),
              spoken: detectLanguage(heard, null),
            },
          });
        },
      }),
    );
  }
}
