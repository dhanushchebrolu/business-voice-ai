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
  type OutboundClaim,
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
import {
  localizedFallback,
  type FallbackMessageKey,
} from "../../../../src/lib/voice-fallback-messages.ts";
import { personalizeGreeting } from "../../../../src/lib/voice-greeting.ts";
import {
  resolvePrimaryLanguage,
  VOICE_LANGUAGE_CODES,
} from "../../../../src/lib/voice-languages.ts";
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
  /** Normal end of the call: close the agent session (the room is removed by disconnect()). */
  hangup(reason: string): Promise<void>;
  /**
   * After an abnormal session close: speak a short apology on a separate,
   * TTS-only path (the conversation session is already closed). Bounded by
   * the caller with a timeout; may reject.
   */
  apologize(language: LanguageCode): Promise<void>;
  /**
   * Disconnect the SIP caller: delete the room, falling back to removing the
   * caller. Must be safe to call more than once (idempotent on LiveKit).
   */
  disconnect(): Promise<void>;
}

/** Timings for ending a call; overridable in tests. */
export interface CallCleanupOptions {
  /** Upper bound for the apology (TTS may be the thing that failed). */
  apologyTimeoutMs?: number;
  /** Waits before each disconnect attempt; the length is the number of attempts. */
  disconnectBackoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}
export const APOLOGY_TIMEOUT_MS = 6_000;
export const DISCONNECT_BACKOFF_MS = [0, 1_000, 3_000, 8_000];

/**
 * One fixed line per supported language: the hand-written English, Hindi
 * and Telugu lines, and the production runtime's own line for the other
 * languages (voice-fallback-messages.ts), never a translation made here.
 */
function everyLanguage(
  core: Record<"en-IN" | "hi-IN" | "te-IN", string>,
  production: FallbackMessageKey,
): Record<LanguageCode, string> {
  return Object.fromEntries(
    VOICE_LANGUAGE_CODES.map((code) => [
      code,
      code === "en-IN" || code === "hi-IN" || code === "te-IN"
        ? core[code]
        : localizedFallback(production, code),
    ]),
  ) as Record<LanguageCode, string>;
}

const DENIED = everyLanguage(
  {
    "en-IN": "Sorry, this number cannot take calls right now. Please try again later.",
    "hi-IN": "क्षमा करें, यह नंबर अभी कॉल नहीं ले सकता। कृपया बाद में प्रयास करें।",
    "te-IN": "క్షమించండి, ఈ నంబర్ ఇప్పుడు కాల్స్ తీసుకోలేదు. దయచేసి తర్వాత ప్రయత్నించండి.",
  },
  "repeatedErrors",
);
const UNAVAILABLE = everyLanguage(
  {
    "en-IN": "Sorry, we are having a technical problem. Please call again in a few minutes.",
    "hi-IN": "क्षमा करें, तकनीकी समस्या है। कृपया कुछ मिनट बाद फिर से कॉल करें।",
    "te-IN": "క్షమించండి, సాంకేతిక సమస్య ఉంది. దయచేసి కొన్ని నిమిషాల తర్వాత మళ్ళీ కాల్ చేయండి.",
  },
  "repeatedErrors",
);

/**
 * A configured language as one of the 11 (the production runtime's own
 * resolution, voice-languages.ts): every supported language is kept; only
 * a code outside the list falls back to English.
 */
export function asLanguage(code: string | null | undefined): LanguageCode {
  return resolvePrimaryLanguage(code);
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
      /** klyro's maximum call duration for this call, when it sent a valid one. */
      maxCallSeconds: number | null;
    };

/**
 * The call's duration limit: the smaller of the agent's MAX_CALL_SECONDS
 * and klyro's limit. klyro's room sweep deletes the room of an inbound call
 * that is still up 5 min after klyro's limit, so the agent must never run a
 * call longer than klyro allows. An invalid klyro value is ignored.
 */
export function effectiveMaxCallSeconds(agentMax: number, klyroMax: number | null): number {
  return klyroMax !== null && Number.isInteger(klyroMax) && klyroMax >= 60
    ? Math.min(agentMax, klyroMax)
    : agentMax;
}

/** Step 1: ask klyro whether and how to take this call. */
export async function decideCall(
  client: KlyroClient,
  info: SipCallInfo,
  telemetry: CallTelemetry,
  now: () => Date = () => new Date(),
  agentMaxCallSeconds?: number,
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
      ...(agentMaxCallSeconds !== undefined ? { maxCallSeconds: agentMaxCallSeconds } : {}),
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
    // The configured greeting (the production default when none is set),
    // with a returning caller's first name exactly as the Worker runtime
    // adds it (voice-greeting.ts).
    greeting: personalizeGreeting(
      b.greetings[language] ??
        b.greetings["en-IN"] ??
        localizedFallback("defaultGreeting", language, b.name),
      r.callerFirstName ?? null,
      language,
    ),
    instructions: b.instructions,
    voiceId: b.voiceId,
    speakingPace: b.speakingPace,
    maxCallSeconds: typeof r.maxCallSeconds === "number" ? r.maxCallSeconds : null,
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
    maxCallSeconds: null,
  };
}

/**
 * Steps 2–4 for an accepted call, around an AgentSession the worker built.
 *
 * How a call ends:
 *  - normal end we initiate (silence, maximum length): close the session,
 *    disconnect the caller;
 *  - the caller hangs up (CloseReason participant_disconnected): nothing to
 *    clean up, not an error;
 *  - any other session close (CloseReason error after repeated STT/LLM/TTS
 *    failures, job_shutdown, unknown): the caller is still on the line ->
 *    a short apology in their language (skipped when TTS is what failed,
 *    bounded by APOLOGY_TIMEOUT_MS), then disconnect.
 * Disconnect is retried with backoff; if every attempt fails,
 * "call.cleanup_failed" is emitted (alert) and the call still finishes, so
 * the job never hangs on cleanup. Duplicate close events are ignored.
 */
export function attachCallGuards(p: {
  session: voice.AgentSession;
  agent: ReceptionistAgent;
  telemetry: CallTelemetry;
  io: CallIO;
  maxCallSeconds: number;
  events: typeof voice.AgentSessionEventTypes;
  cleanup?: CallCleanupOptions;
}): { finished: Promise<{ reason: string }> } {
  const { session, agent, telemetry, io, events } = p;
  const apologyTimeoutMs = p.cleanup?.apologyTimeoutMs ?? APOLOGY_TIMEOUT_MS;
  const backoff = p.cleanup?.disconnectBackoffMs ?? DISCONNECT_BACKOFF_MS;
  const sleep = p.cleanup?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let away = 0;
  let settled = false; // `finished` resolved
  let closing = false; // we started ending the call (normal or abnormal)
  let resolveDone!: (v: { reason: string }) => void;
  const finished = new Promise<{ reason: string }>((r) => (resolveDone = r));
  const settle = (reason: string) => {
    if (settled) return;
    settled = true;
    resolveDone({ reason });
  };
  const disconnect = async (reason: string) => {
    for (let attempt = 0; attempt < backoff.length; attempt++) {
      if (backoff[attempt]! > 0) await sleep(backoff[attempt]!);
      try {
        await io.disconnect();
        return;
      } catch (e) {
        telemetry.emit("room.disconnect_failed", {
          reason,
          attempt: attempt + 1,
          error: (e as Error).message,
        });
      }
    }
    telemetry.emit("call.cleanup_failed", { reason, attempts: backoff.length });
  };
  const end = async (reason: string) => {
    if (closing || settled) return;
    closing = true;
    clearTimeout(maxTimer);
    telemetry.emit("call.ending", { reason });
    await io.hangup(reason).catch(() => undefined);
    await disconnect(reason);
    settle(reason);
  };
  const abort = async (reason: string, errorType: string | null) => {
    closing = true;
    clearTimeout(maxTimer);
    telemetry.emit("call.aborted", { reason, error_type: errorType });
    if (!errorType || !/tts/i.test(errorType)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          io.apologize(agent.deps.state.language.current),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("apology_timeout")), apologyTimeoutMs);
          }),
        ]);
      } catch (e) {
        telemetry.emit("call.apology_failed", { reason, error: (e as Error).message });
      } finally {
        clearTimeout(timer);
      }
    }
    await disconnect(reason);
    settle(reason);
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
    const reason = String(ev.reason);
    // Our own end() (closes with user_initiated), or a duplicate event.
    if (closing || settled) return;
    clearTimeout(maxTimer);
    if (reason === "participant_disconnected") {
      settle(reason); // the caller hung up: normal, nothing to clean up
      return;
    }
    if (reason === "user_initiated") {
      // Our own code closed the session outside end(): not an error, no
      // apology, but make sure the caller is not left on the line.
      closing = true;
      void disconnect(reason).then(() => settle(reason));
      return;
    }
    const err = (ev as { error?: { type?: string } | null }).error;
    void abort(reason, err?.type ?? null);
  });
  return { finished };
}

const PHRASE_STILL_THERE = everyLanguage(
  {
    "en-IN": "Are you still there?",
    "hi-IN": "क्या आप लाइन पर हैं?",
    "te-IN": "మీరు లైన్‌లో ఉన్నారా?",
  },
  "silencePrompt",
);
const PHRASE_GOODBYE = everyLanguage(
  {
    "en-IN": "I can't hear you, so I'll end the call now. Please call back anytime. Goodbye.",
    "hi-IN":
      "आपकी आवाज़ नहीं आ रही, इसलिए मैं कॉल समाप्त कर रही हूँ। कृपया दोबारा कॉल करें। धन्यवाद।",
    "te-IN":
      "మీ మాట వినిపించడం లేదు, కాబట్టి కాల్ ముగిస్తున్నాను. దయచేసి మళ్ళీ కాల్ చేయండి. ధన్యవాదాలు.",
  },
  "silenceHangup",
);

/** One turn of the call transcript, in klyro's call_logs.transcript shape. */
export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
}
/** The chat-history items the transcript is built from (LiveKit ChatContext items). */
export interface HistoryItem {
  type: string;
  role?: string;
  textContent?: string | undefined;
  createdAt?: number;
}
/** klyro accepts session-end bodies up to 256 KiB (http.server.ts); the transcript stays well inside. */
export const TRANSCRIPT_BUDGET_BYTES = 200 * 1024;
export const MAX_TRANSCRIPT_TURNS = 400;

/**
 * The conversation as the caller heard it: caller and agent speech only, in
 * order, with each turn's time. System instructions, the per-turn directive
 * (never added to the history), tool calls and tool results are left out.
 * An interrupted agent turn keeps the text LiveKit recorded for it. If the
 * call is very long, turns are shortened (never dropped or invented) until
 * the report fits klyro's limit.
 */
export function transcriptFrom(items: readonly HistoryItem[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const it of items) {
    if (it.type !== "message" || (it.role !== "user" && it.role !== "assistant")) continue;
    const text = (it.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const ms =
      typeof it.createdAt === "number" && Number.isFinite(it.createdAt)
        ? it.createdAt < 1e12
          ? it.createdAt * 1000
          : it.createdAt
        : Date.now();
    turns.push({ role: it.role, text, at: new Date(ms).toISOString() });
  }
  let kept = turns.slice(0, MAX_TRANSCRIPT_TURNS);
  for (const cap of [4000, 1000, 400, 160]) {
    kept = kept.map((t) =>
      t.text.length > cap ? { ...t, text: `${t.text.slice(0, cap - 1)}…` } : t,
    );
    if (new TextEncoder().encode(JSON.stringify(kept)).length <= TRANSCRIPT_BUDGET_BYTES) break;
  }
  return kept;
}

/**
 * A transcript checkpoint to klyro during the call (crash safety; see
 * runtime/transcript-checkpoint.ts). Bound to the call's room and SIP id;
 * klyro changes nothing but the transcript. Rejects on failure (retried).
 */
export async function checkpointTranscript(
  client: KlyroClient,
  p: {
    callId: string;
    binding: { roomName: string; sipCallId: string };
    segment: string;
    language: string;
    transcript: TranscriptTurn[];
  },
): Promise<void> {
  await endSession(client, {
    callId: p.callId,
    reason: "checkpoint",
    checkpoint: true,
    segment: p.segment,
    language: p.language,
    roomName: p.binding.roomName,
    sipCallId: p.binding.sipCallId,
    transcript: p.transcript,
  });
}

/**
 * Step 4: tell klyro what happened: outcome codes, the language, and the
 * transcript (stored in call_logs for the calls dashboard, as the Worker
 * runtime stores it). The summary is the Worker's own "<n> turns · <lang>".
 */
export async function reportEnd(
  client: KlyroClient | null,
  callId: string,
  reason: string,
  state: ConversationState,
  telemetry: CallTelemetry,
  /** The call's room and sip.callID: klyro binds the report to the call (F1). */
  binding?: { roomName: string; sipCallId: string },
  transcript?: TranscriptTurn[],
  /** This agent job (LiveKit job id): the transcript segment checkpoints were stored under. */
  segment?: string,
): Promise<void> {
  const outcome =
    state.booking.status === "confirmed"
      ? "booked"
      : state.booking.status === "held_pending_sync"
        ? "booked_pending_sync"
        : (state.intent?.value ?? "no_intent");
  const turns = transcript?.length ?? 0;
  const summary = turns
    ? `${turns} turns · ${state.language.current}`
    : "No conversation recorded.";
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
    ...(binding ? { roomName: binding.roomName, sipCallId: binding.sipCallId } : {}),
    ...(transcript ? { transcript } : {}),
    ...(segment ? { segment } : {}),
  }).catch((e) =>
    telemetry.emit("provider.error", {
      provider: "klyro",
      stage: "session_end",
      error: (e as Error).message,
    }),
  );
}

/**
 * Explicit dispatch metadata klyro sets for an outbound call
 * (outbound.server.ts): only the call row id. Destination, caller ID and
 * trunk are deliberately NOT taken from metadata; the destination and
 * caller ID come from klyro's claim, the trunk from this agent's config.
 */
export interface OutboundDispatch {
  outboundCallLogId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Parses job metadata. Anything malformed is "not outbound" (null): the job
 * is then handled as an inbound SIP call, which klyro still has to
 * authorise at session start. Any other field (toNumber, fromNumber,
 * outboundTrunkId, ...) is ignored.
 */
export function parseOutboundDispatch(raw: string | undefined): OutboundDispatch | null {
  let m: unknown;
  try {
    m = JSON.parse(raw || "{}");
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const id = (m as Record<string, unknown>)["outboundCallLogId"];
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  return { outboundCallLogId: id };
}

export interface DialOptions {
  fromNumber: string;
  participantIdentity: string;
  waitUntilAnswered: boolean;
  ringingTimeout: number;
  maxCallDuration: number;
  participantAttributes: Record<string, string>;
}

export type DialResult =
  | { ok: true; toNumber: string; fromNumber: string }
  /** owned=false: another job owns (or may own) this call; touch nothing. */
  | { ok: false; reason: string; owned: boolean };

/**
 * Claim, then dial. Order matters:
 *  1. Claim the row from klyro (signed; idempotent for this job). Refused or
 *     unreachable -> do NOT dial and do NOT touch the room: a duplicate
 *     dispatch shares the room with the job that owns the call.
 *  2. Dial the destination klyro returned, with the caller ID klyro
 *     returned, through this agent's own configured trunk.
 *  3. Dial failed (busy, no answer, rejected) or no trunk configured: tell
 *     klyro (the row is closed as failed, never billed) and delete the room
 *     so no stray SIP leg is left in it.
 */
export async function dialOutbound(p: {
  dispatch: OutboundDispatch;
  jobId: string;
  trunkId: string | undefined;
  roomName: string;
  maxCallSeconds: number;
  ringingTimeoutSeconds?: number;
  claim: (p: { callId: string; roomName: string; jobId: string }) => Promise<OutboundClaim>;
  dial: (trunkId: string, to: string, room: string, opts: DialOptions) => Promise<unknown>;
  deleteRoom: () => Promise<void>;
  client: KlyroClient;
  telemetry: CallTelemetry;
}): Promise<DialResult> {
  const callId = p.dispatch.outboundCallLogId;
  let claimed: OutboundClaim;
  try {
    claimed = await p.claim({ callId, roomName: p.roomName, jobId: p.jobId });
    if (!E164_RE.test(claimed.toNumber) || !E164_RE.test(claimed.fromNumber))
      throw new Error("claim_returned_invalid_numbers");
  } catch (err) {
    const reason = `claim_refused:${String((err as { code?: unknown }).code ?? "error")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 40)}`;
    p.telemetry.emit("call.claim_refused", { reason });
    return { ok: false, reason, owned: false };
  }
  let reason: string;
  if (!p.trunkId) {
    reason = "dial_failed:no_outbound_trunk";
  } else {
    try {
      await p.dial(p.trunkId, claimed.toNumber, p.roomName, {
        fromNumber: claimed.fromNumber,
        participantIdentity: "callee",
        waitUntilAnswered: true,
        ringingTimeout: p.ringingTimeoutSeconds ?? 30,
        maxCallDuration: p.maxCallSeconds,
        participantAttributes: { "clickai.callLogId": callId },
      });
      return { ok: true, toNumber: claimed.toNumber, fromNumber: claimed.fromNumber };
    } catch (err) {
      const code = String((err as { code?: unknown }).code ?? "error")
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .slice(0, 40);
      reason = `dial_failed:${code}`;
    }
  }
  p.telemetry.emit("call.dial_failed", { reason });
  await endSession(p.client, { callId, reason, jobId: p.jobId }).catch(() =>
    p.telemetry.emit("klyro.end_failed", { reason }),
  );
  await p.deleteRoom().catch(() => p.telemetry.emit("room.delete_failed", { reason }));
  return { ok: false, reason, owned: true };
}

export { DENIED, UNAVAILABLE };
