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
import { z } from "zod";
import type { BookingBackend, Slot } from "../backend/types.ts";
import { PHRASES, ReplyGuard, slotList } from "../conversation/guard.ts";
import {
  agentSaid,
  applyReading,
  bookingExists,
  nextStep,
  readyForAvailability,
  readyToBook,
  spokenTime,
  stateSummary,
  type BusinessContext,
  type ConversationState,
  type NextStep,
} from "../conversation/state.ts";
import { readUtterance, type LanguageCode, type TimeSpec } from "../conversation/understanding.ts";

export interface ReceptionistDeps {
  business: BusinessContext;
  backend: BookingBackend;
  state: ConversationState;
  /** Extra business instructions from klyro (buildAgentInstructions); facts only. */
  businessInstructions?: string;
  onTurn?: (info: { step: NextStep; state: ConversationState; language: LanguageCode }) => void;
  onGuard?: (removed: ReplyGuard["removed"]) => void;
  onTool?: (info: { name: string; ok: boolean; ms: number; detail?: string }) => void;
}

const LANGUAGE_NAME: Record<LanguageCode, string> = {
  "en-IN": "English",
  "hi-IN": "Hindi",
  "te-IN": "Telugu",
};

function instructionFor(step: NextStep, s: ConversationState): string {
  const p = PHRASES[s.language.current];
  switch (step.kind) {
    case "clarify":
      return `The caller's ${step.slot} is ambiguous: it could be ${step.options.join(" or ")}. Ask which one they mean. Do not choose for them.`;
    case "ask":
      return `Ask for the ${step.slot} only. Suggested wording: "${p[step.slot]}"`;
    case "confirm_caller_id":
      return `Ask whether to use the number they are calling from, ending in ${step.digits.slice(-4)}. Do not assume yes.`;
    case "check_availability":
      return "Say one short line that you are checking, then call the check_availability tool. Never guess which times are free.";
    case "offer_slots":
      return `Offer exactly these times from the calendar and ask which one suits them: ${slotList(s)}. Offer no other time.`;
    case "final_confirmation":
      return "Read back service, day, time, name and phone number once, then ask the caller to confirm. Do not say it is booked.";
    case "book":
      return "The caller confirmed. Call the book_appointment tool now. Do not say it is booked until the tool says so.";
    case "done":
      if (s.booking.status === "confirmed") {
        return "The booking is confirmed by the system. Tell the caller it is booked and ask if there is anything else.";
      }
      if (s.booking.status === "held_pending_sync") {
        return "The booking is saved and the slot is held, but it is not fully confirmed yet: tell the caller it is saved and the clinic team will confirm it. Do not say it is confirmed.";
      }
      return "The booking request is recorded but not confirmed yet. Tell the caller the team will confirm it. Do not say it is booked.";
  }
}

export function directive(step: NextStep, s: ConversationState): string {
  return [
    "CALL STATE (authoritative; values marked inferred/uncertain are NOT facts the caller confirmed):",
    stateSummary(s),
    "",
    `NEXT STEP: ${instructionFor(step, s)}`,
    `Reply in ${LANGUAGE_NAME[s.language.current]}, the language the caller just used. Keep it short and natural for a phone call.`,
    "Ask at most one question. Never repeat a question the caller already answered.",
    "Never invent prices, hours, services, free times, customer records, booking ids or confirmation status; only say what is in CALL STATE or a tool result.",
  ].join("\n");
}

function timeWindow(t: TimeSpec | undefined): { notBefore?: string; notAfter?: string } {
  if (!t) return {};
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

function hhmmOf(slot: Slot, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(slot.startIso));
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
        s.booking.status = "checking";
        s.currentTask = "checking_availability";
        const want = s.time!.value;
        const res = await timed(
          "check_availability",
          () =>
            d.backend.checkAvailability({
              serviceId: s.service!.value.id,
              date: s.date!.value,
              durationMinutes: s.service!.value.durationMinutes || 30,
              ...timeWindow(want),
            }),
          (r) => r.ok,
          (r) => (r.ok ? `${r.slots.length} slots` : r.error),
        );
        if (!res.ok) {
          s.booking.status = "failed";
          s.booking.error = res.error;
          return `FAILED: the calendar could not be checked (${res.error}). Nothing is booked. Apologise and offer to try again.`;
        }
        let slots = res.slots.map((x) => ({
          startIso: x.startIso,
          hhmm: hhmmOf(x, d.business.timeZone),
          endIso: x.endIso,
        }));
        if (want.kind === "exact") {
          const exact = slots.find((x) => x.hhmm === want.hhmm);
          slots = exact ? [exact] : slots.slice(0, 3);
        } else {
          slots = slots.slice(0, 3);
        }
        s.booking.offered = slots.map(({ startIso, hhmm }) => ({ startIso, hhmm }));
        slotEnds.clear();
        for (const x of slots) slotEnds.set(x.startIso, x.endIso);
        s.booking.status = slots.length ? "slots_offered" : "none";
        s.currentTask = "choosing_slot";
        if (!slots.length)
          return "NO_SLOTS: nothing is free for that day and time. Ask for another day or time.";
        if (want.kind === "exact" && slots.length === 1 && slots[0]!.hhmm === want.hhmm) {
          return `AVAILABLE: ${spokenTime(want.hhmm)} is free. Ask if they want it.`;
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

  constructor(deps: ReceptionistDeps) {
    const knownPrices = new Set<number>();
    super({
      instructions:
        `You are the phone receptionist for ${deps.business.businessName}. You speak English, Hindi and Telugu. ` +
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
      });
      applyReading(s, reading, this.deps.business);
      const tts = this.session?.tts as
        { updateOptions?: (o: { targetLanguageCode: string }) => void } | undefined;
      tts?.updateOptions?.({ targetLanguageCode: s.language.current });
      this.lastStep = nextStep(s);
      this.deps.onTurn?.({ step: this.lastStep, state: s, language: s.language.current });
    } else {
      this.lastStep = nextStep(s);
    }
    ctx.items.splice(
      Math.max(0, ctx.items.length - 1),
      0,
      llm.ChatMessage.create({ role: "system", content: directive(this.lastStep, s) }),
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
    const guard = new ReplyGuard(this.deps.state, { knownPrices: [...this.knownPrices] });
    const state = this.deps.state;
    const onGuard = this.deps.onGuard;
    let buffer = "";
    let spoke = false;
    let calledTool = false;
    const flushSentences = (controller: TransformStreamDefaultController<Out>, final: boolean) => {
      let consumed = 0;
      for (const m of buffer.matchAll(/[^.!?।\n]+[.!?।\n]+/g)) {
        const ok = guard.check(m[0]);
        if (ok) {
          controller.enqueue(ok);
          spoke = true;
        }
        consumed = m.index! + m[0].length;
      }
      buffer = buffer.slice(consumed);
      if (final && buffer.trim()) {
        const ok = guard.check(buffer);
        if (ok) {
          controller.enqueue(ok);
          spoke = true;
        }
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
            flushSentences(controller, false);
            return;
          }
          if (chunk.delta?.toolCalls?.length) calledTool = true;
          const content = chunk.delta?.content;
          if (content) {
            buffer += content;
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
          if (guard.removed.length) onGuard?.(guard.removed);
          if (!spoke && !calledTool && guard.removed.length) {
            const p = PHRASES[state.language.current];
            const step = nextStep(state);
            controller.enqueue(
              step.kind === "ask"
                ? p[step.slot]
                : step.kind === "check_availability"
                  ? p.checking
                  : p.notYetBooked,
            );
          }
        },
      }),
    );
  }
}
