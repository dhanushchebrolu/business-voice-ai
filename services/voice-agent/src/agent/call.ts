/**
 * One phone call, from the SIP participant joining to klyro being told the
 * session ended. Kept free of LiveKit's JobContext so the decision logic is
 * testable; worker.ts supplies the real room operations.
 *
 *   1. klyro session start (entitlement gate, tenant, business facts).
 *      Denied -> short message (no LLM), hang up. klyro unreachable ->
 *      apology, hang up: never take a call the backend has not authorised.
 *   2. Agent + AgentSession with the business's own services/prices.
 *   3. Guards: maximum call length; silence -> one check-in, then goodbye.
 *   4. End: klyro session-end with outcome codes only (no transcript).
 *      Billing is NOT done here; klyro bills from the signed LiveKit webhook.
 */
import type { voice } from "@livekit/agents";
import { InMemoryBookingBackend } from "../backend/in-memory.ts";
import {
  KlyroBookingBackend,
  endSession,
  startSession,
  type StartSessionResponse,
} from "../backend/klyro-backend.ts";
import type { KlyroClient } from "../backend/klyro-client.ts";
import type { BookingBackend } from "../backend/types.ts";
import {
  newConversation,
  type BusinessContext,
  type ConversationState,
} from "../conversation/state.ts";
import type { LanguageCode, ServiceRow } from "../conversation/understanding.ts";
import { CallTelemetry } from "../runtime/telemetry.ts";
import { ReceptionistAgent } from "./receptionist.ts";

export interface SipCallInfo {
  roomName: string;
  sipCallId: string;
  calledNumber: string;
  callerNumber: string | null;
  direction: "inbound" | "outbound";
  outboundCallLogId?: string;
}

export interface CallIO {
  /** Speak a fixed line without the LLM (denials, apologies). */
  say(text: string): Promise<void>;
  hangup(reason: string): Promise<void>;
}

const DENIED: Record<LanguageCode, string> = {
  "en-IN": "Sorry, this number cannot take calls right now. Please try again later.",
  "hi-IN": "क्षमा करें, यह नंबर अभी कॉल नहीं ले सकता। कृपया बाद में प्रयास करें।",
  "te-IN": "క్షమించండి, ఈ నంబర్ ఇప్పుడు కాల్స్ తీసుకోలేదు. దయచేసి తర్వాత ప్రయత్నించండి.",
};
const UNAVAILABLE: Record<LanguageCode, string> = {
  "en-IN": "Sorry, we are having a technical problem. Please call again in a few minutes.",
  "hi-IN": "क्षमा करें, तकनीकी समस्या है। कृपया कुछ मिनट बाद फिर से कॉल करें।",
  "te-IN": "క్షమించండి, సాంకేతిక సమస్య ఉంది. దయచేసి కొన్ని నిమిషాల తర్వాత మళ్ళీ కాల్ చేయండి.",
};

export function asLanguage(code: string | null | undefined): LanguageCode {
  return code?.startsWith("hi") ? "hi-IN" : code?.startsWith("te") ? "te-IN" : "en-IN";
}

export type CallDecision =
  | { kind: "reject"; reason: string; message: string; callId: string | null }
  | {
      kind: "accept";
      callId: string;
      state: ConversationState;
      business: BusinessContext;
      backend: BookingBackend;
      greeting: string;
      instructions: string;
      voiceId: string;
      speakingPace: number;
    };

/** Step 1: ask klyro whether and how to take this call. */
export async function decideCall(
  client: KlyroClient,
  info: SipCallInfo,
  telemetry: CallTelemetry,
  now: () => Date = () => new Date(),
): Promise<CallDecision> {
  let r: StartSessionResponse;
  try {
    r = await startSession(client, {
      sipCallId: info.sipCallId,
      roomName: info.roomName,
      calledNumber: info.calledNumber,
      callerNumber: info.callerNumber,
      direction: info.direction,
      ...(info.outboundCallLogId ? { outboundCallLogId: info.outboundCallLogId } : {}),
    });
  } catch (e) {
    telemetry.emit("provider.error", {
      provider: "klyro",
      stage: "session_start",
      error: (e as Error).message,
    });
    return {
      kind: "reject",
      reason: "backend_unreachable",
      message: UNAVAILABLE["en-IN"],
      callId: null,
    };
  }
  if (!r.allowed) {
    telemetry.emit("call.rejected", { reason: r.reason });
    return { kind: "reject", reason: r.reason, message: DENIED["en-IN"], callId: r.callId };
  }
  telemetry.setCallId(r.callId);
  const b = r.business;
  const language = asLanguage(b.primaryLanguage);
  const services: ServiceRow[] = b.services.map((s) => ({
    id: s.id,
    name: s.name,
    durationMinutes: s.durationMinutes ?? 30,
    priceInr: b.currency === "INR" ? s.price : null,
  }));
  const business: BusinessContext = { businessName: b.name, timeZone: b.timezone, services, now };
  const state = newConversation({
    callId: r.callId,
    callerId: r.callerNumber,
    primaryLanguage: language,
  });
  return {
    kind: "accept",
    callId: r.callId,
    state,
    business,
    backend: new KlyroBookingBackend(client, r.callId, b.timezone, r.tools),
    greeting:
      b.greetings[language] ??
      b.greetings["en-IN"] ??
      `Hello, thanks for calling ${b.name}. How can I help you today?`,
    instructions: b.instructions,
    voiceId: b.voiceId,
    speakingPace: b.speakingPace,
  };
}

/** For local development without klyro: an accept decision over the in-memory backend. */
export function developmentDecision(
  callId: string,
  callerNumber: string | null,
  services: ServiceRow[],
): CallDecision {
  return {
    kind: "accept",
    callId,
    state: newConversation({ callId, callerId: callerNumber, primaryLanguage: "en-IN" }),
    business: {
      businessName: "Development Clinic",
      timeZone: "Asia/Kolkata",
      services,
      now: () => new Date(),
    },
    backend: new InMemoryBookingBackend({
      timeZoneOffset: "+05:30",
      openHours: ["10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00"],
      callId,
    }),
    greeting: "Hello, thanks for calling. How can I help you today?",
    instructions: "",
    voiceId: "priya",
    speakingPace: 1,
  };
}

/** Steps 2–4 for an accepted call, around an AgentSession the worker built. */
export function attachCallGuards(p: {
  session: voice.AgentSession;
  agent: ReceptionistAgent;
  telemetry: CallTelemetry;
  io: CallIO;
  maxCallSeconds: number;
  events: typeof voice.AgentSessionEventTypes;
}): { finished: Promise<{ reason: string }> } {
  const { session, agent, telemetry, io, events } = p;
  let away = 0;
  let resolveDone!: (v: { reason: string }) => void;
  const finished = new Promise<{ reason: string }>((r) => (resolveDone = r));
  const end = async (reason: string) => {
    clearTimeout(maxTimer);
    telemetry.emit("call.ending", { reason });
    await io.hangup(reason).catch(() => undefined);
    resolveDone({ reason });
  };
  // Not unref'd: it is always cleared when the call ends (end() / Close).
  const maxTimer = setTimeout(() => void end("max_duration"), p.maxCallSeconds * 1000);

  session.on(events.UserInputTranscribed, (ev) => {
    if (ev.isFinal) {
      agent.setSttLanguage(ev.language ?? null);
      telemetry.emit("turn.user_final", {
        language: ev.language ?? null,
        transcript: ev.transcript,
      });
    }
  });
  session.on(events.ConversationItemAdded, (ev) => {
    const item = ev.item;
    if (item.type === "message" && item.role === "assistant") {
      agent.recordSpoken(item.interrupted);
      if (item.interrupted) telemetry.emit("turn.interrupted");
    }
  });
  session.on(events.MetricsCollected, (ev) => {
    const m = ev.metrics as unknown as Record<string, unknown>;
    const pick = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : undefined);
    telemetry.emit(`metrics.${String(m["type"] ?? "unknown")}`, {
      ttft: pick("ttftMs") ?? pick("ttft"),
      ttfb: pick("ttfbMs") ?? pick("ttfb"),
      duration: pick("durationMs") ?? pick("duration"),
      eou_delay: pick("endOfUtteranceDelayMs") ?? pick("endOfUtteranceDelay"),
      transcription_delay: pick("transcriptionDelayMs") ?? pick("transcriptionDelay"),
    });
  });
  session.on(events.UserStateChanged, (ev) => {
    if (ev.newState !== "away") return;
    away++;
    telemetry.emit("call.silence", { count: away });
    if (away === 1) {
      void session.say(PHRASE_STILL_THERE[agent.deps.state.language.current], {
        allowInterruptions: true,
      });
    } else {
      void session
        .say(PHRASE_GOODBYE[agent.deps.state.language.current], { allowInterruptions: false })
        .waitForPlayout()
        .then(() => end("silence"));
    }
  });
  session.on(events.Error, (ev) => {
    const err = ev.error as unknown as { type?: string; recoverable?: boolean; error?: Error };
    telemetry.emit("provider.error", {
      provider: err.type ?? "unknown",
      recoverable: err.recoverable ?? null,
      error: err.error?.message ?? "",
    });
  });
  session.on(events.Close, (ev) => {
    clearTimeout(maxTimer);
    resolveDone({ reason: String(ev.reason) });
  });
  return { finished };
}

const PHRASE_STILL_THERE: Record<LanguageCode, string> = {
  "en-IN": "Are you still there?",
  "hi-IN": "क्या आप लाइन पर हैं?",
  "te-IN": "మీరు లైన్‌లో ఉన్నారా?",
};
const PHRASE_GOODBYE: Record<LanguageCode, string> = {
  "en-IN": "I can't hear you, so I'll end the call now. Please call back anytime. Goodbye.",
  "hi-IN":
    "आपकी आवाज़ नहीं आ रही, इसलिए मैं कॉल समाप्त कर रही हूँ। कृपया दोबारा कॉल करें। धन्यवाद।",
  "te-IN":
    "మీ మాట వినిపించడం లేదు, కాబట్టి కాల్ ముగిస్తున్నాను. దయచేసి మళ్ళీ కాల్ చేయండి. ధన్యవాదాలు.",
};

/** Step 4: tell klyro what happened (codes only), never the transcript. */
export async function reportEnd(
  client: KlyroClient | null,
  callId: string,
  reason: string,
  state: ConversationState,
  telemetry: CallTelemetry,
): Promise<void> {
  const outcome =
    state.booking.status === "confirmed"
      ? "booked"
      : state.booking.status === "held_pending_sync"
        ? "booked_pending_sync"
        : (state.intent?.value ?? "no_intent");
  const summary = `intent=${state.intent?.value ?? "none"}; booking=${state.booking.status}; turns=${state.turn}; language=${state.language.current}; switches=${state.language.switches}`;
  telemetry.emit("call.ended", {
    reason,
    outcome,
    turns: state.turn,
    interruptions: telemetry.counters.interruptions,
    tool_failures: telemetry.counters.toolFailures,
  });
  if (!client) return;
  await endSession(client, {
    callId,
    reason,
    summary,
    language: state.language.current,
    outcome,
  }).catch((e) =>
    telemetry.emit("provider.error", {
      provider: "klyro",
      stage: "session_end",
      error: (e as Error).message,
    }),
  );
}

export { DENIED, UNAVAILABLE };
