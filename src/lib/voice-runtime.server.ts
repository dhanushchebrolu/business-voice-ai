/**
 * Phase E voice runtime — the conversation orchestrator that sits between
 * a live call's audio (Phase D's `AudioMediaBridge`, see
 * ./telephony/audio-bridge.ts) and Sarvam's STT/TTS/LLM. This module owns
 * runtime/session state only (§12 of the Phase E brief) — the canonical
 * call lifecycle (initiated/ringing/answered/.../completed) stays entirely
 * owned by Phase D's `call_logs` state machine in telephony-guard.server.ts;
 * this file never writes `call_logs.status` and never calls
 * `finalizeCallBilling` — that remains driven exclusively by the provider's
 * own call-status webhook events, so billing has exactly one trigger path.
 *
 * State is intentionally call-scoped and in-memory only (§7): there is no
 * database table of runtime sessions, and nothing here creates persistent
 * customer memory across calls.
 *
 * PROVIDER-NEUTRAL BY CONSTRUCTION: everything below programs against
 * `AudioMediaBridge` (./telephony/audio-bridge.ts) and `RuntimeDeps`
 * (below) only — it never imports or references anything Exotel-specific
 * (no CallSid, no stream_sid, no Exotel event names). Exotel is one
 * concrete `AudioMediaBridge` implementation (ExotelMediaBridge, see
 * ./telephony/exotel-media-bridge.server.ts); a Twilio/Plivo/SIP/test-
 * harness bridge is a drop-in replacement with zero changes here.
 *
 * TESTABILITY (`RuntimeDeps`): `startRuntimeSession` takes an optional
 * second `deps` argument — the STT/TTS connectors, the LLM call, and
 * transcript persistence, defaulting to the real implementations
 * (`defaultRuntimeDeps`): Sarvam's realtime STT/TTS always, the LLM call
 * itself resolved by llm-provider.server.ts (Sarvam or Claude, by
 * VOICE_LLM_PROVIDER), and the real `call_logs` write. A test can supply a
 * deterministic fake for all four and drive this exact orchestration/
 * state-machine/persistence code end-to-end without a real network call or
 * a live database — see ./telephony/voice-runtime-test-harness.ts and
 * voice-runtime-harness.test.ts. Production code paths never pass `deps`
 * explicitly, so they always get the real implementations; nothing about
 * the live behavior changes.
 *
 * RUNTIME CONTRACT (the provider-neutral responsibilities this module
 * owns, whatever they end up being called at each call site):
 *   startSession        -> startRuntimeSession
 *   receiveAudio         -> the onInboundFrame callback registered in
 *                            startRuntimeSession, feeding deps.connectStt's
 *                            session
 *   receiveCallerEvent   -> onSttEvent (speech_start/speech_end/
 *                            partial_transcript/final_transcript/...)
 *   generateResponse     -> handleUserUtterance, via deps.generateReply
 *   synthesizeAudio      -> speak(), via deps.connectTts's session
 *   sendAudio            -> onTtsEvent's "audio" case, via
 *                            bridge.sendOutboundFrame
 *   interruptResponse    -> onSttEvent's barge-in branch (generation++,
 *                            bridge.clearOutboundBuffer(), tts.flush())
 *   endSession           -> terminateRuntimeSession
 *   persistTranscript    -> persistTranscript (this file), via
 *                            deps.persistTranscript
 *   persistCallLog       -> deliberately NOT in this file — the call_logs
 *                            row itself (organization/agent/phone_number/
 *                            provider/timestamps/direction/status) is
 *                            created and status-transitioned by
 *                            src/routes/api/public/webhooks/telephony.ts,
 *                            driven exclusively by the provider's own
 *                            call-status webhook events (see this file's
 *                            first paragraph). Duplicating that write here
 *                            would be a second, competing call-lifecycle
 *                            owner — exactly what this module's opening
 *                            paragraph already rules out. This file's own
 *                            contribution to that same row is narrower and
 *                            AI-specific: transcript/summary/language/
 *                            agent_version, via deps.persistTranscript.
 */

import type { AudioMediaBridge, AudioFrame } from "./telephony/audio-bridge.ts";
import {
  connectSarvamStt,
  connectSarvamTts,
  type SttSession,
  type TtsSession,
  type ConnectSttOptions,
  type ConnectTtsOptions,
  type SttEvent,
  type TtsEvent,
} from "./sarvam-realtime.server.ts";
import { ProviderError, type ChatMessage } from "./sarvam.server.ts";
import { resolveGenerateReply } from "./llm-provider.server.ts";
import { resolveGenerateReplyWithTools } from "./llm-provider.server.ts";
import { SUPPORTED_VOICE_LANGUAGES, type AgentSnapshot } from "./agent-instructions.ts";
import type { ClaudeTool } from "./claude.server.ts";
import { zonedWallTimeToUtc } from "./calendar/timezone.ts";

/**
 * Whether `code` is in the TTS/LLM common supported set (SUPPORTED_VOICE_LANGUAGES
 * in agent-instructions.ts) — NOT Sarvam STT's own larger recognition set, which
 * can detect languages this pipeline cannot respond in end to end.
 */
export function isSupportedVoiceLanguage(code: string): boolean {
  return (SUPPORTED_VOICE_LANGUAGES as readonly { code: string }[]).some((l) => l.code === code);
}

/**
 * Resolves which language to treat a turn as being in: the detected
 * language if it's one the LLM/TTS pair actually supports end to end,
 * otherwise the agent's own configured default — never an unsupported
 * code (e.g. one of Saaras STT's languages outside the common set), and
 * never null/undefined. Exported as a pure function so both "a detected
 * supported language is used" and "an unsupported one falls back" are
 * directly unit-testable without driving a whole session.
 */
export function resolveResponseLanguage(detected: string | null, primaryLanguage: string): string {
  if (detected && isSupportedVoiceLanguage(detected)) return detected;
  return primaryLanguage;
}

/**
 * Explicit runtime states. `created` -> `connecting` -> `greeting` ->
 * `listening` is the normal happy-path startup; `listening` <->
 * `transcribing` <-> `thinking` <-> `speaking` is the normal turn-taking
 * cycle; `interrupted` is the barge-in state (caller spoke while the agent
 * was greeting/thinking/speaking); `ending`/`ended`/`failed` are terminal
 * (`failed` distinguishes "the runtime never worked" from "the call ended
 * normally" — see terminateRuntimeSession).
 */
export type RuntimeState =
  | "created"
  | "connecting"
  | "greeting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  // Phase 4: entered right after a turn whose AI tool call successfully
  // requested a payment (request_payment) — the caller can still speak
  // normally (treated like "listening" for STT/barge-in purposes; see
  // isAwaitingCaller), but a separate, bounded payment-wait timer is also
  // running (see armPaymentWaitTimer). It resolves one of three ways: a
  // PaymentCaptured/Failed/Expired domain event is injected
  // (injectPaymentEvent, from the Razorpay webhook via the voice domain-
  // event consumer), the bounded timeout elapses (a graceful "still
  // waiting" fallback is spoken and the runtime returns to listening), or
  // the caller simply keeps talking (cancels the wait like any other
  // utterance).
  | "waiting_on_payment"
  | "ending"
  | "ended"
  | "failed";

/**
 * Every transition this runtime actually performs. `setState` (below)
 * refuses — logs and no-ops, never throws — any transition not listed
 * here, so a bug that tries to move the state machine somewhere
 * unreachable degrades to "nothing happened, logged" rather than
 * corrupting session state or crashing the call.
 */
const RUNTIME_TRANSITIONS: Record<RuntimeState, RuntimeState[]> = {
  created: ["connecting", "failed", "ending"],
  connecting: ["greeting", "failed", "ending"],
  // greeting -> speaking: the rare case where a PaymentCaptured/Failed/
  // Expired event is injected (injectPaymentEvent) while the initial
  // greeting is still being spoken — the injected message takes over as
  // an ordinary "speaking" turn rather than being dropped.
  greeting: ["listening", "speaking", "interrupted", "failed", "ending"],
  // listening/transcribing/interrupted -> speaking: not only via an LLM
  // turn (thinking -> speaking) — the silence-prompt ("are you still
  // there?") and silence-goodbye messages are canned speech spoken
  // directly from whichever of these three states the runtime was waiting
  // on the caller in (see speakSilencePrompt/endDueToSilence), with no
  // LLM call involved.
  listening: [
    "transcribing",
    "thinking",
    "interrupted",
    "speaking",
    "waiting_on_payment",
    "failed",
    "ending",
  ],
  transcribing: ["thinking", "listening", "speaking", "failed", "ending"],
  thinking: ["speaking", "listening", "interrupted", "failed", "ending"],
  // speaking -> waiting_on_payment: handleUserUtterance's own post-speak
  // transition when the turn just spoken included a successful
  // request_payment tool call (see getReply's enteredPaymentWait).
  speaking: ["listening", "waiting_on_payment", "interrupted", "failed", "ending"],
  interrupted: ["thinking", "listening", "transcribing", "speaking", "failed", "ending"],
  // waiting_on_payment behaves like listening for caller-speech purposes
  // (isAwaitingCaller includes it) — same onward transitions listening
  // itself allows, plus back to listening once the bounded wait resolves
  // one way or another (armPaymentWaitTimer's own timeout, or
  // injectPaymentEvent).
  waiting_on_payment: [
    "transcribing",
    "thinking",
    "interrupted",
    "speaking",
    "listening",
    "failed",
    "ending",
  ],
  ending: ["ended", "failed"],
  ended: [],
  failed: [],
};

/** Pure, directly unit-testable transition check — same convention as telephony-guard.server.ts's checkCallTransition. */
export function isValidRuntimeTransition(from: RuntimeState, to: RuntimeState): boolean {
  if (from === to) return true;
  return (RUNTIME_TRANSITIONS[from] ?? []).includes(to);
}

interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
}

/**
 * Structured appointment fields the runtime owns and persists across turns
 * — NOT the LLM's own free-text conversational memory (which
 * CONVERSATION_HISTORY_TURNS already bounds, and which can still push early
 * details out of the window on a long call). The LLM proposes updates to
 * this every turn (see APPT_STATE_MARKER), but the runtime is the single
 * source of truth: a turn that doesn't mention a field leaves it
 * untouched, so information already given is never silently forgotten, and
 * a turn that DOES restate a field overwrites it, so a correction
 * ("actually, make that 4 PM") takes effect the same way a first-time
 * answer does.
 */
export interface AppointmentState {
  service: string | null;
  customerName: string | null;
  phone: string | null;
  /** YYYY-MM-DD, resolved by the LLM from whatever the caller said ("tomorrow", "next Friday") against the CURRENT DATE the agent's own instructions are built with — see agent-instructions.ts. */
  preferredDate: string | null;
  /** 24-hour HH:mm, local to the business's own timezone. Null when the caller gave only an approximate period (preferredPeriod) or no time preference at all (e.g. "any slots today", "book me at the next available time"). */
  preferredTime: string | null;
  /** An approximate time-of-day the caller gave instead of an exact time ("any slots this afternoon") — used to filter check_calendar_availability's real results; never itself a source of an invented time. Only meaningful when preferredTime is null. */
  preferredPeriod: "morning" | "afternoon" | "evening" | null;
  /** The caller explicitly asked for the next/earliest open slot ("book me at the next available time") rather than naming one — see attemptBooking/attemptAvailabilityCheck. Only meaningful when preferredTime is null. */
  wantsNextAvailable: boolean;
  /**
   * "checking_availability" (new): the caller asked whether a specific
   * date/time is free, but hasn't confirmed they want to book it yet — see
   * attemptAvailabilityCheck. Distinct from "ready_to_book" (an explicit
   * confirmation to actually book) so the two deterministic tool paths
   * never fire for the same turn.
   */
  bookingStatus:
    "collecting" | "checking_availability" | "ready_to_book" | "booked" | "unavailable";
  /**
   * The REAL outcome of the most recently run check_calendar_availability
   * call for preferredDate/preferredTime — set ONLY by
   * attemptAvailabilityCheck/attemptBooking from an actual tool result,
   * never proposed by the model (see parseApptStateMarker: this field is
   * deliberately not part of what the LLM's marker can set) — the
   * mechanism behind "never invent availability". Invalidated back to
   * "unknown" by mergeAppointmentState whenever preferredDate/preferredTime
   * changes, since a stale result would otherwise describe a slot the
   * caller is no longer asking about.
   */
  availabilityStatus: "unknown" | "available" | "unavailable";
  /**
   * The exact real slot (ISO 8601 UTC start/end, as returned by
   * check_calendar_availability) that availabilityStatus describes — "that
   * slot" (the caller referring back to a time the agent just offered,
   * including an ALTERNATIVE the caller didn't originally ask for) resolves
   * against this, not by re-deriving it from preferredDate/preferredTime.
   * Same provenance rule as availabilityStatus: only ever set from a real
   * tool result, never model-proposed.
   */
  selectedSlot: { start: string; end: string } | null;
}

function emptyAppointmentState(): AppointmentState {
  return {
    service: null,
    customerName: null,
    phone: null,
    preferredDate: null,
    preferredTime: null,
    preferredPeriod: null,
    wantsNextAvailable: false,
    bookingStatus: "collecting",
    availabilityStatus: "unknown",
    selectedSlot: null,
  };
}

export interface StartRuntimeSessionInput {
  callId: string;
  organizationId: string;
  businessId: string;
  agentConfigId: string | null;
  agentVersion: number | null;
  instructions: string;
  snapshotAgent: AgentSnapshot["agent"];
  businessName: string;
  bridge: AudioMediaBridge;
}

export interface RuntimeSessionHandle {
  callId: string;
  runtimeSessionId: string;
  state: RuntimeState;
  terminate(reason: string): Promise<void>;
}

/** What persistTranscript writes — a plain data shape, not the internal Session, so a test can assert on it without reaching into runtime internals. */
export interface TranscriptRecord {
  callId: string;
  turns: ConversationTurn[];
  summary: string;
  language: string;
  agentVersion: number | null;
}

/**
 * The runtime's only dependencies on external systems — the AI provider
 * (connect STT, connect TTS, generate one LLM reply) and transcript
 * persistence — deliberately narrow so a test can substitute all of them
 * with deterministic fakes. `defaultRuntimeDeps` (below) wires these to the
 * real Sarvam clients and the real `call_logs` write; that is the only
 * production wiring, and it is exactly what `startRuntimeSession` uses
 * when no `deps` argument is passed.
 */
/** Context a tool execution needs, resolved server-side from the session — never from the model's own tool-call input. See ai-tools.server.ts's header comment for why. */
export interface ToolExecContext {
  organizationId: string;
  businessId: string;
  agentConfigId: string | null;
  callId: string;
}

export interface RuntimeDeps {
  connectStt: (opts: ConnectSttOptions) => Promise<SttSession>;
  connectTts: (opts: ConnectTtsOptions) => Promise<TtsSession>;
  generateReply: (messages: ChatMessage[]) => Promise<{ reply: string }>;
  persistTranscript: (record: TranscriptRecord) => Promise<void>;
  /**
   * Phase 4 AI tool-calling — all three optional and all-or-nothing by
   * convention (see getReply below): when present, a turn resolves the
   * agent's permitted tools and, if any exist, runs the single-tool-
   * call-round path instead of plain generateReply. Absent (the case for
   * every non-Claude provider today, and for any test harness that
   * doesn't opt in), a session behaves exactly as it did before tools
   * existed — this is what keeps the change backward-compatible.
   */
  generateReplyWithTools?: (
    messages: ChatMessage[],
    tools: ClaudeTool[],
    executeTool: (
      name: string,
      input: Record<string, unknown>,
    ) => Promise<{ content: string; isError?: boolean }>,
  ) => Promise<{
    reply: string;
    toolCalls: { name: string; input: Record<string, unknown>; isError: boolean }[];
  }>;
  resolveAvailableTools?: (organizationId: string, businessId: string) => Promise<ClaudeTool[]>;
  executeTool?: (
    name: string,
    input: Record<string, unknown>,
    ctx: ToolExecContext,
  ) => Promise<{ content: string; isError?: boolean }>;
}

async function persistTranscriptToCallLogs(record: TranscriptRecord): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("call_logs")
    .update({
      transcript: record.turns as never,
      summary: record.summary,
      language: record.language,
      agent_version: record.agentVersion,
    })
    .eq("id", record.callId);
}

async function resolveAvailableToolsFromDb(
  organizationId: string,
  businessId: string,
): Promise<ClaudeTool[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { resolveAvailableTools } = await import("./ai-tools.server.ts");
  return resolveAvailableTools(supabaseAdmin, organizationId, businessId);
}

async function executeToolViaRegistry(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<{ content: string; isError?: boolean }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { executeAiTool } = await import("./ai-tools.server.ts");
  return executeAiTool(
    supabaseAdmin,
    {
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      agentConfigId: ctx.agentConfigId,
      callId: ctx.callId,
      source: "voice",
    },
    name,
    input,
  );
}

const generateReplyWithTools = resolveGenerateReplyWithTools();

export const defaultRuntimeDeps: RuntimeDeps = {
  connectStt: connectSarvamStt,
  connectTts: connectSarvamTts,
  // Sarvam or Claude, chosen by VOICE_LLM_PROVIDER — see
  // llm-provider.server.ts's own doc comment. STT/TTS above are always
  // Sarvam's realtime clients regardless of this choice; only the
  // text-in/text-out reasoning step changes.
  generateReply: resolveGenerateReply(),
  persistTranscript: persistTranscriptToCallLogs,
  // Always present, regardless of LLM provider — handleUserUtterance's
  // deterministic booking flow (attemptBooking) calls this directly, not
  // through an LLM-initiated tool_use round trip, so it works identically
  // whether the turn's reply came from Sarvam or Claude. executeToolViaRegistry
  // itself has no dependency on which LLM is selected; it's a plain
  // tenant-validated calendar/payment dispatcher.
  executeTool: executeToolViaRegistry,
  // generateReplyWithTools/resolveAvailableTools remain all-or-nothing and
  // Claude-only (see getReply): an agent running on Sarvam never gets the
  // LLM-initiated tool-use path half-wired, only the separate deterministic
  // booking path above, which needs no LLM-side tool-calling support at all.
  ...(generateReplyWithTools
    ? {
        generateReplyWithTools,
        resolveAvailableTools: resolveAvailableToolsFromDb,
      }
    : {}),
};

interface Session {
  handle: RuntimeSessionHandle;
  input: StartRuntimeSessionInput;
  deps: RuntimeDeps;
  turns: ConversationTurn[];
  detectedLanguage: string | null;
  generation: number;
  startedAt: number;
  stt: SttSession | null;
  tts: TtsSession | null;
  accumulatingUserText: string;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  silencePromptSent: boolean;
  /** Bounded wait for a PaymentCaptured/Failed/Expired event, armed only while state is "waiting_on_payment" — see armPaymentWaitTimer. */
  paymentWaitTimer: ReturnType<typeof setTimeout> | null;
  /** Frames arriving after the bridge exists but before STT has connected — see startRuntimeSession. */
  pendingInboundFrames: AudioFrame[];
  /** Guards against a provider redelivering the exact same final_transcript event — see onSttEvent. */
  lastFinalTranscript: { text: string; at: number } | null;
  /** Logged once, the first time caller audio actually arrives — see startRuntimeSession's onInboundFrame registration. */
  firstInboundFrameLogged: boolean;
  /** Bytes of synthesized audio received for the current utterance, reset per speak() call, logged (and reset) on Sarvam's "flushed" event — see onTtsEvent. */
  ttsBytesInFlight: number;
  /**
   * Monotonic counts of TTS chunks sent (speak()) vs. acknowledged as fully
   * delivered by Sarvam (onTtsEvent's "flushed" case) — see ttsAudioInFlight.
   * Deliberately NOT reset per speak() call (unlike ttsBytesInFlight, which
   * is a per-utterance byte total for logging): these only ever need to
   * answer "is there still audio Sarvam owes us, from any speak() call",
   * which a difference of two ever-increasing counters tells you without
   * caring which specific call a given chunk belonged to.
   */
  ttsChunksSent: number;
  ttsChunksFlushed: number;
  /** The output codec/sample rate this session told Sarvam to synthesize into (from connectTts's options) — compared against Sarvam's actual first audio chunk in onTtsEvent's first_outbound_audio_frame diagnostic, so a provider that silently ignores the declared format is visible rather than assumed. */
  declaredTtsOutputCodec: "mulaw" | "linear16" | "wav" | null;
  declaredTtsOutputSampleRateHz: number | null;
  /** Logged once, the first synthesized audio frame actually forwarded to the telephony bridge — see onTtsEvent. */
  firstOutboundAudioFrameLogged: boolean;
  /**
   * The generation `speak()` was called under for whatever TTS audio is
   * currently valid to forward to the caller — see speak() and onTtsEvent's
   * "audio" case. Sarvam's realtime TTS protocol has no per-request
   * correlation id, so this is how a barge-in's `session.generation++`
   * (onSttEvent's "speech_start" case) actually stops audio for the
   * interrupted reply from reaching the caller: once generation has moved
   * on, any audio chunk whose speech is still tagged with the OLD
   * generation is dropped instead of forwarded, no matter how many more
   * chunks Sarvam streams back for that abandoned request.
   */
  activeSpeechGeneration: number;
  /** One stale-audio-dropped log per interruption, not one per dropped chunk — see onTtsEvent. */
  staleAudioDropLogged: boolean;
  /**
   * Serializes handleUserUtterance calls so two final_transcript events
   * arriving close together (a provider redelivery, or a new utterance
   * landing while the previous one's LLM call is still in flight) can
   * never push competing "user" turns or fire concurrent LLM requests —
   * see enqueueUserUtterance. Each call's whole body (turn push, LLM call,
   * reply push-or-discard) fully completes before the next one starts.
   */
  utteranceQueue: Promise<void>;
  /** Runtime-owned appointment fields, persisted across turns independent of the LLM's own conversational memory — see AppointmentState's own doc comment. */
  appointmentState: AppointmentState;
  /** The language_code the current TTS connection was opened with — see maybeSwitchTtsLanguage. Starts at the agent's primary_language (what startRuntimeSession connects with). */
  ttsLanguage: string;
  /**
   * Latency diagnostics (response_start_latency_ms / total_response_latency_ms):
   * set the moment a final_transcript is actually forwarded to
   * handleUserUtterance (onSttEvent), read back in onTtsEvent once this
   * turn's first/last audio arrives. Null between turns (and while the
   * agent itself is speaking unprompted, e.g. the greeting or a silence
   * prompt) so those calls to speak() never get attributed a misleading
   * "response latency" that was never measuring a reply to caller speech.
   */
  currentTurnTranscriptFinalAt: number | null;
  /** One response_start_latency_ms log per turn, not one per audio chunk — see onTtsEvent. */
  currentTurnFirstAudioLogged: boolean;
  /** Task 4: the full correlated per-turn timing record, built up as each stage completes and emitted once as voice_runtime:response_timing — see onTtsEvent's "flushed" case. Null between turns, same lifetime rule as currentTurnTranscriptFinalAt. */
  currentTurn: CurrentTurnTiming | null;
  /** Most recent Sarvam VAD timestamps — read into currentTurn when a final_transcript is forwarded, since they describe the utterance that produced it. Not reset between utterances; always "most recent so far". */
  lastSpeechStartAt: number | null;
  lastSpeechEndAt: number | null;
  lastPartialTranscriptAt: number | null;
  /** When the CURRENT TTS connection (initial or after maybeSwitchTtsLanguage) finished connecting — see ttsConnectedAt's own use in currentTurn. */
  ttsConnectedAt: number | null;
  /**
   * Task 2/7: a fresh id minted at the start of every speak() call —
   * greeting, replies, silence prompts, fallbacks — so diagnostics (the
   * greeting_attempt/greeting_sent trio, barge_in's cancelled_utterance_id)
   * can show definitively whether the SAME utterance was ever sent more
   * than once, rather than inferring it from log order alone.
   */
  currentUtteranceId: string | null;
  /** Task 2: set exactly once, the first time the initial greeting is actually spoken — guards every greeting call site (today just one) against ever re-sending it, including across a TTS reconnect (maybeSwitchTtsLanguage never re-calls speak() for the greeting text at all — this flag is defense in depth, not the only thing preventing a replay). */
  initialGreetingSent: boolean;
  /**
   * Task 6: identifies which TTS connection is CURRENTLY authoritative for
   * writing audio to the telephony bridge — see onTtsEvent's "audio" case.
   * `ttsConnectionIdSeq` is a separate, ever-incrementing counter (never
   * decremented, never reused) that mints a new id for every connectTts
   * call (initial connect and every maybeSwitchTtsLanguage reconnect);
   * `activeTtsConnectionId` is updated to that new id only once the new
   * connection is actually live. A chunk tagged with any OTHER id — e.g.
   * one still in flight from a socket that's since been replaced — is
   * dropped, so at most one TTS connection can ever write audio to Vobiz
   * at a time, even if the old socket's underlying network connection
   * hasn't finished closing yet.
   */
  ttsConnectionIdSeq: number;
  activeTtsConnectionId: number;
}

/** Task 4: one correlated timing record per caller turn — see Session.currentTurn's own doc comment. */
interface CurrentTurnTiming {
  audioFirstSeenAt: number | null;
  speechStartAt: number | null;
  speechEndAt: number | null;
  transcriptPartialAt: number | null;
  transcriptFinalAt: number;
  llmRequestAt: number | null;
  llmCompletedAt: number | null;
  ttsTextSentAt: number | null;
  ttsConnectedAt: number | null;
  firstTtsAudioAt: number | null;
  responseAudioEndAt: number | null;
}

const activeSessions = new Map<string, Session>();

/** Bounds memory if STT never connects (or connects very slowly) while the caller is already talking — approximate, not a guaranteed-lossless buffer. At ~20ms/frame this is roughly 5s of audio. */
const MAX_PENDING_INBOUND_FRAMES = 250;

/** A provider (or the network) redelivering the identical final_transcript within this window is treated as a duplicate event, not a second utterance — see onSttEvent's "final_transcript" case. */
const DUPLICATE_TRANSCRIPT_WINDOW_MS = 2_000;

/**
 * How many of the most recent turns (user + assistant combined) are sent
 * to the LLM as conversation history — see handleUserUtterance. Previously
 * 20 (only 10 full exchanges), which could push a caller's early-given
 * details (name, phone number) out of the window well before a real
 * receptionist call is done, making the agent appear to "forget" and
 * re-ask for information it already received. 40 is still a bounded,
 * deliberately-chosen cap (not unbounded history) — just one generous
 * enough for a real multi-topic booking conversation.
 */
const CONVERSATION_HISTORY_TURNS = 40;

/**
 * Silence handling: while waiting on the caller (listening, transcribing,
 * or interrupted — the caller cut the agent off but hasn't said anything
 * since), a caller who goes quiet is prompted once ("are you still
 * there?"), then hung up on gracefully if the silence continues. Any
 * caller speech (speech_start — the earliest signal, not final_transcript)
 * cancels the pending timer and resets the prompt flag: only genuine
 * silence accumulates toward either threshold. Never armed while the
 * agent itself is talking or thinking — that's not caller silence.
 */
const SILENCE_PROMPT_MS = 12_000;
const SILENCE_HANGUP_MS = 10_000;

/**
 * How long the runtime waits, after successfully requesting a payment,
 * before giving up on hearing back from a PaymentCaptured/Failed/Expired
 * event and speaking a graceful fallback instead. A conservative default,
 * not validated against live customer payment-completion latency (UPI
 * app switches, OTP entry, etc.) — deliberately configurable rather than
 * hardcoded elsewhere, but not yet exposed as its own env var since no
 * other per-call timeout in this file is either (see SILENCE_PROMPT_MS/
 * SILENCE_HANGUP_MS for the existing precedent this follows).
 */
const PAYMENT_WAIT_TIMEOUT_MS = 90_000;

/**
 * Whether Sarvam still owes this session audio for something already sent
 * to TTS (speak()'s sendText/flush) that hasn't been acknowledged as fully
 * delivered yet (onTtsEvent's "flushed" case). This is NOT the same
 * question as `stateOf(session) === "speaking"`: speak() returns — and the
 * state machine moves on to "listening" — as soon as the reply TEXT has
 * been sent, which can be well before the synthesized AUDIO has actually
 * finished streaming/playing for a long reply. onSttEvent's barge-in
 * branch uses this to recognize caller speech that starts during that
 * still-playing tail as a genuine interruption, even though the state has
 * already nominally moved past "speaking".
 */
function ttsAudioInFlight(session: Session): boolean {
  return session.ttsChunksSent > session.ttsChunksFlushed;
}

function isAwaitingCaller(state: RuntimeState): boolean {
  return (
    state === "listening" ||
    state === "transcribing" ||
    state === "interrupted" ||
    state === "waiting_on_payment"
  );
}

/** Reads current state through a function boundary so a stale narrowing from before an `await` can't linger. */
function stateOf(session: Session): RuntimeState {
  return session.handle.state;
}

/** The only place session.handle.state is ever assigned — see RUNTIME_TRANSITIONS. */
function setState(session: Session, next: RuntimeState) {
  const current = session.handle.state;
  if (current === next) return;
  if (!isValidRuntimeTransition(current, next)) {
    log("illegal_state_transition_blocked", session, { from: current, to: next });
    return;
  }
  session.handle.state = next;
}

function clearSilenceTimer(session: Session) {
  if (session.silenceTimer) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }
}

function armSilenceTimer(session: Session) {
  clearSilenceTimer(session);
  const state = session.handle.state;
  if (!isAwaitingCaller(state)) return;
  // The previous reply's audio can still be trickling out even after the
  // state machine has already moved on to "listening"/"waiting_on_payment"
  // (see ttsAudioInFlight's own doc comment) — the caller cannot be
  // "silent" while still being spoken to. Deliberately not armed here;
  // onTtsEvent's "flushed" case re-calls armSilenceTimer once the audio
  // actually catches up, which is the only thing that can turn this back
  // into a real wait-on-the-caller window.
  if ((state === "listening" || state === "waiting_on_payment") && ttsAudioInFlight(session)) {
    return;
  }
  const delay = session.silencePromptSent ? SILENCE_HANGUP_MS : SILENCE_PROMPT_MS;
  // Bound to the generation active right now, at arm time — belt-and-
  // suspenders alongside clearSilenceTimer: every call site that starts
  // caller/assistant activity (speech_start, handleUserUtterance,
  // terminateRuntimeSession, injectPaymentEvent) already clears the
  // pending timer outright, so in today's code this check should never
  // actually trip. It exists so a FUTURE code path that bumps
  // session.generation without remembering to also clear the silence
  // timer degrades to "this fired callback silently does nothing" rather
  // than a stale prompt/hangup reaching a caller mid-turn.
  const armedGeneration = session.generation;
  session.silenceTimer = setTimeout(() => {
    if (session.generation !== armedGeneration) {
      log("silence_timer_stale_generation_ignored", session, {
        armedGeneration,
        currentGeneration: session.generation,
      });
      return;
    }
    if (session.silencePromptSent) void endDueToSilence(session);
    else void speakSilencePrompt(session);
  }, delay);
}

function clearPaymentWaitTimer(session: Session) {
  if (session.paymentWaitTimer) {
    clearTimeout(session.paymentWaitTimer);
    session.paymentWaitTimer = null;
  }
}

/** Armed only right after entering "waiting_on_payment" (see handleUserUtterance). Fires the bounded fallback exactly once; a PaymentCaptured/Failed/Expired injection (injectPaymentEvent) or any further caller speech clears this timer first, so it never fires after the wait has already resolved another way. */
function armPaymentWaitTimer(session: Session) {
  clearPaymentWaitTimer(session);
  session.paymentWaitTimer = setTimeout(() => {
    void speakPaymentWaitTimeout(session);
  }, PAYMENT_WAIT_TIMEOUT_MS);
}

async function speakPaymentWaitTimeout(session: Session) {
  if (stateOf(session) !== "waiting_on_payment") return; // already resolved another way
  log("payment_wait_timeout", session);
  try {
    await speak(
      session,
      "I haven't received confirmation of your payment yet. I'll text you as soon as it comes through — is there anything else I can help with in the meantime?",
    );
  } catch (err) {
    log("payment_wait_timeout_speech_failed", session, { message: (err as Error).message });
  }
  if (stateOf(session) === "speaking") setState(session, "listening");
  armSilenceTimer(session);
}

async function speakSilencePrompt(session: Session) {
  if (!isAwaitingCaller(session.handle.state)) return;
  session.silencePromptSent = true;
  try {
    await speak(session, "Are you still there? I can stay on the line if you need a moment.");
  } catch (err) {
    log("silence_prompt_failed", session, { message: (err as Error).message });
  }
  // Only settle back to listening if nothing else moved the state on while
  // this prompt was being spoken (e.g. the caller barged in mid-prompt,
  // which already transitions to interrupted and will be handled there).
  if (stateOf(session) === "speaking") setState(session, "listening");
  armSilenceTimer(session);
}

async function endDueToSilence(session: Session) {
  if (!isAwaitingCaller(session.handle.state)) return;
  log("silence_hangup", session);
  try {
    await speak(
      session,
      "I haven't heard anything, so I'll end the call here. Feel free to call back anytime.",
    );
  } catch (err) {
    log("silence_goodbye_failed", session, { message: (err as Error).message });
  }
  await terminateRuntimeSession(session.input.callId, "caller_silence_timeout");
}

/**
 * Every structured log line this file emits carries these five fields
 * (call_id, runtime_session_id, organization_id, agent_config_id,
 * provider) so a single call's logs can be correlated end to end and the
 * organization/agent responsible for any given line is always visible —
 * never an API key, auth header, or the caller's spoken words/transcript
 * content (only counts/lengths/language, where logged at all).
 */
function log(
  event: string,
  session: Pick<Session, "input"> & { handle: { runtimeSessionId: string } },
  extra?: Record<string, unknown>,
) {
  console.info(`voice_runtime:${event}`, {
    call_id: session.input.callId,
    runtime_session_id: session.handle.runtimeSessionId,
    organization_id: session.input.organizationId,
    agent_config_id: session.input.agentConfigId,
    ...extra,
  });
}

/**
 * Same correlation fields as log() above, but the event name is emitted
 * bare — no "voice_runtime:" prefix — for the small set of diagnostics
 * meant to be grepped/dashboarded under their own namespace (calendar_tool:*,
 * matching the tts:/stt: namespaced events in sarvam-realtime.server.ts and
 * tts:connection_replaced elsewhere in this file). Same redaction discipline as log(): never an API
 * key, token, or the caller's actual words — only counts/lengths/codes.
 */
function namedLog(
  event: string,
  session: Pick<Session, "input"> & { handle: { runtimeSessionId: string } },
  extra?: Record<string, unknown>,
) {
  console.info(event, {
    call_id: session.input.callId,
    runtime_session_id: session.handle.runtimeSessionId,
    organization_id: session.input.organizationId,
    agent_config_id: session.input.agentConfigId,
    ...extra,
  });
}

/**
 * Task 1 (production incident: a real call showed ~20.4s between
 * runtime_started/first_inbound_audio_frame and tts_connected, with
 * stt_connected arriving only ~183ms after that): wraps one awaited
 * startup operation with a single voice_runtime:startup_step log —
 * step/started_at/completed_at/duration_ms, plus outcome/message on
 * failure — so the NEXT occurrence of a startup delay shows definitively
 * which specific operation (DO/runtime init, TTS connect, STT connect,
 * greeting) actually took the time, rather than being inferred from gaps
 * between unrelated log lines. Rethrows on failure unchanged — this is
 * purely an observability wrapper, never a retry or a behavior change.
 */
async function timedStep<T>(
  session: Pick<Session, "input"> & { handle: { runtimeSessionId: string } },
  step: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const completedAt = Date.now();
    log("startup_step", session, {
      step,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: completedAt - startedAt,
      outcome: "success",
    });
    return result;
  } catch (err) {
    const completedAt = Date.now();
    log("startup_step", session, {
      step,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: completedAt - startedAt,
      outcome: "error",
      message: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Problem 3 (production incident: a caller's turn sometimes produced total
 * silence — no reply, no fallback, ever, until the caller gave up — because
 * a downstream step in handleUserUtterance's reply pipeline had no timeout
 * of its own and simply hung): getReply's own provider call is already
 * bounded (REQUEST_TIMEOUT_MS, 15s — see sarvam.server.ts/claude.server.ts's
 * AbortSignal.timeout), but attemptBooking's calendar/tool round trips
 * (check_calendar_availability/book_appointment, ultimately real Supabase
 * queries) are NOT — a stuck query there would hang handleUserUtterance
 * forever, past the point where EITHER its success path (speak the reply)
 * OR its existing catch block (speak a fallback) ever runs, so the silence
 * timer (cleared the moment this turn was accepted, at the top of
 * handleUserUtterance) never gets re-armed either. withTurnDeadline bounds
 * the ENTIRE per-turn pipeline — not just the LLM call — so no matter which
 * stage is the slow/hung one, this turn always resolves one way or another
 * within TURN_DEADLINE_MS: either a real reply, or a TurnTimeoutError that
 * the existing catch block turns into a spoken apology + a return to
 * "listening" + a fresh silence timer, exactly like any other turn error.
 */
class TurnTimeoutError extends Error {
  constructor(ms: number) {
    super(`Turn exceeded ${ms}ms without producing a reply`);
  }
}

const TURN_DEADLINE_MS = 25_000;

/**
 * Races `fn()` against a deadline. `fn` receives `isCancelled()`, which
 * flips to true the moment the deadline wins — so if `fn()`'s own hung work
 * eventually resolves anyway (a Supabase query that was merely slow, not
 * actually stuck forever), it can check `isCancelled()` before doing
 * anything caller-visible (pushing a turn, speaking) and discard itself
 * instead of racing with — or duplicating — whatever the timeout's own
 * fallback already spoke. Deliberately does NOT touch `session.generation`
 * (a genuine barge-in's own signal): the deadline firing must still let
 * handleUserUtterance's catch block speak an apology for THIS turn — it
 * doesn't own a replacement turn the way a real barge-in does.
 */
function withTurnDeadline<T>(
  ms: number,
  fn: (isCancelled: () => boolean) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let cancelled = false;
    const timer = setTimeout(() => {
      cancelled = true;
      reject(new TurnTimeoutError(ms));
    }, ms);
    fn(() => cancelled).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Splits accumulated assistant text into TTS-safe chunks at sentence boundaries. */
export function chunkIntoSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.match(/[^.!?\n]+[.!?\n]*/g) ?? [trimmed];
  const chunks: string[] = [];
  let buffer = "";
  for (const part of parts) {
    buffer += part;
    // Flush once a chunk is a complete-looking sentence and long enough to
    // be worth an independent TTS round trip, so we don't fire one request
    // per short fragment.
    if (buffer.trim().length >= 20 && /[.!?]\s*$/.test(buffer)) {
      chunks.push(buffer.trim());
      buffer = "";
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

/**
 * The delimiter the agent's own instructions (agent-instructions.ts's
 * "APPOINTMENT STATE TRACKING" section) tell the model to end every reply
 * with — a machine-readable summary of appointment fields known so far,
 * never spoken aloud. Chosen to be extremely unlikely to occur in natural
 * conversational text, so a plain substring search is enough; no need for
 * the model to escape anything inside ordinary sentences.
 */
const APPT_STATE_MARKER = "<<<APPT_STATE:";

/**
 * Splits a raw LLM reply into the text that should actually be spoken and
 * the trailing structured appointment-state block, if present — see
 * APPT_STATE_MARKER. Defensive by design: the split point is a plain
 * `indexOf`, so even a malformed or truncated marker is still fully
 * removed from `spokenText` (never partially spoken, never reaches TTS) —
 * only a well-formed JSON payload between the marker and its closing
 * `>>>` is parsed into `state`; anything else yields `state: null` and
 * the caller simply keeps whatever appointment state it already had.
 */
export function parseApptStateMarker(reply: string): {
  spokenText: string;
  state: Partial<AppointmentState> | null;
} {
  const markerIdx = reply.indexOf(APPT_STATE_MARKER);
  if (markerIdx === -1) return { spokenText: reply.trim(), state: null };

  const spokenText = reply.slice(0, markerIdx).trim();
  const tail = reply.slice(markerIdx + APPT_STATE_MARKER.length);
  const closeIdx = tail.indexOf(">>>");
  if (closeIdx === -1) return { spokenText, state: null };

  try {
    const parsed = JSON.parse(tail.slice(0, closeIdx)) as Record<string, unknown>;
    const state: Partial<AppointmentState> = {};
    if (typeof parsed["service"] === "string") state.service = parsed["service"];
    if (typeof parsed["customer_name"] === "string") state.customerName = parsed["customer_name"];
    if (typeof parsed["phone"] === "string") state.phone = parsed["phone"];
    if (typeof parsed["preferred_date"] === "string")
      state.preferredDate = parsed["preferred_date"];
    if (typeof parsed["preferred_time"] === "string")
      state.preferredTime = parsed["preferred_time"];
    if (
      parsed["preferred_period"] === "morning" ||
      parsed["preferred_period"] === "afternoon" ||
      parsed["preferred_period"] === "evening"
    ) {
      state.preferredPeriod = parsed["preferred_period"];
    }
    if (parsed["wants_next_available"] === true) state.wantsNextAvailable = true;
    // Deliberately never parses an "availability_status"/"selected_slot"
    // field from the model, even if one were ever present in `parsed` —
    // see AppointmentState's own doc comment: those two fields are
    // runtime-owned, set only from a real check_calendar_availability
    // result (attemptAvailabilityCheck/attemptBooking), never proposed by
    // the LLM. This is the mechanism behind "never invent availability".
    //
    // "ready_to_book" (an explicit confirmation to actually book) takes
    // priority over "checking_availability" (the caller merely asking
    // whether a time is free) if a reply somehow proposes both — an
    // explicit booking confirmation is the stronger signal.
    if (parsed["ready_to_book"] === true) state.bookingStatus = "ready_to_book";
    else if (parsed["checking_availability"] === true)
      state.bookingStatus = "checking_availability";
    return { spokenText, state };
  } catch {
    return { spokenText, state: null };
  }
}

/** Merges a turn's proposed appointment-state fields into the session's persistent state — only fields the model actually provided this turn are overwritten; everything else (including a field the current turn didn't mention) is left exactly as it was. */
function mergeAppointmentState(
  current: AppointmentState,
  proposed: Partial<AppointmentState> | null,
): AppointmentState {
  if (!proposed) return current;
  const preferredDate = proposed.preferredDate ?? current.preferredDate;
  // preferredTime and preferredPeriod are each independently sticky (a
  // given value persists until the caller gives a new one) — see
  // attemptAvailabilityCheck/attemptBooking for why an exact preferredTime
  // always takes priority over preferredPeriod when, unusually, both end
  // up set at once, rather than this merge trying to clear one in favor of
  // the other.
  const preferredTime = proposed.preferredTime ?? current.preferredTime;
  const preferredPeriod = proposed.preferredPeriod ?? current.preferredPeriod;
  // The requested slot itself changed this turn (a new date/time/period, or
  // a correction to one already given) — any availabilityStatus/selectedSlot
  // carried over from a PREVIOUS check now describes a slot the caller is
  // no longer asking about, so it must not keep being treated as current
  // (e.g. silently booking the OLD time as "already confirmed available").
  const slotChanged =
    preferredDate !== current.preferredDate ||
    preferredTime !== current.preferredTime ||
    preferredPeriod !== current.preferredPeriod;
  return {
    service: proposed.service ?? current.service,
    customerName: proposed.customerName ?? current.customerName,
    phone: proposed.phone ?? current.phone,
    preferredDate,
    preferredTime,
    preferredPeriod,
    // Deliberately NOT sticky, same reasoning as bookingStatus below: "the
    // caller wants the next/earliest open slot" is a proposal for THIS
    // turn's attempt, not a durable fact — carrying it forward would risk
    // silently resolving a LATER, unrelated booking request (with its own
    // explicit time) as "next available" instead.
    wantsNextAvailable: proposed.wantsNextAvailable === true,
    // bookingStatus is deliberately NOT sticky across turns the way the
    // other fields are: "ready_to_book"/"checking_availability" are only a
    // proposal for THIS turn's attempt (handleUserUtterance resolves it
    // immediately — to "booked"/"unavailable" for a booking attempt, or
    // back to "collecting"/"unavailable" for an availability check) —
    // carrying either forward would re-trigger a tool call on a later,
    // unrelated turn.
    bookingStatus: proposed.bookingStatus ?? "collecting",
    availabilityStatus: slotChanged ? "unknown" : current.availabilityStatus,
    selectedSlot: slotChanged ? null : current.selectedSlot,
  };
}

/** Required to attempt a real booking — see attemptBooking. An exact time is required UNLESS the caller explicitly asked for the next/earliest available slot (wantsNextAvailable), in which case attemptBooking resolves the actual time itself from the real calendar. */
function appointmentStateIsComplete(s: AppointmentState): boolean {
  return Boolean(
    s.service &&
    s.customerName &&
    s.phone &&
    s.preferredDate &&
    (s.preferredTime || s.wantsNextAvailable),
  );
}

/** Required to check availability — unlike a booking attempt, the caller's name/phone are not needed merely to ask "is this slot free" or "what's available". A specific time is NOT required either — an open "any slots today"/"this afternoon" query is checked and listed by attemptAvailabilityCheck just as validly as an exact-time check. */
function appointmentSlotIsKnown(s: AppointmentState): boolean {
  return Boolean(s.preferredDate);
}

/** Renders the runtime-owned appointment state into a system message the LLM can read as ground truth, instead of relying on it re-deriving the same facts from (possibly truncated) conversation history. Returns null when nothing is known yet, so a fresh call's messages array isn't padded with an all-null block. */
function describeKnownAppointmentState(s: AppointmentState): string | null {
  const known: string[] = [];
  if (s.service) known.push(`service: ${s.service}`);
  if (s.customerName) known.push(`customer name: ${s.customerName}`);
  if (s.phone) known.push(`phone: ${s.phone}`);
  if (s.preferredDate) known.push(`preferred date: ${s.preferredDate}`);
  if (s.preferredTime) known.push(`preferred time: ${s.preferredTime}`);
  else if (s.preferredPeriod) known.push(`preferred time of day: ${s.preferredPeriod}`);
  // Task 9 ("that slot" resolution): surfaces the REAL outcome of the most
  // recent availability check, if any, so a later "check that slot" or
  // "book that slot" has enough context to resolve without re-asking —
  // and so the model never contradicts a result the runtime already gave
  // the caller out loud.
  if (s.availabilityStatus === "available" && s.selectedSlot) {
    known.push(
      `availability: the requested time IS available (confirmed by the calendar) — "that slot" refers to this time`,
    );
  } else if (s.availabilityStatus === "unavailable") {
    known.push(
      `availability: the requested time is NOT available — if the caller accepts an alternative you offered, update preferred_time to match it`,
    );
  }
  if (!known.length) return null;
  return `CURRENT APPOINTMENT STATE (already confirmed by the caller — do not ask for these again):\n${known.join("\n")}`;
}

/**
 * Production incident: a real Vobiz call showed the model's own
 * APPT_STATE_MARKER emission is NOT reliably followed turn to turn — "Is
 * there any slot available today?" produced no `checking_availability`
 * marker at all (the agent asked "what time works best" instead of
 * dispatching a real calendar check), and a later "please confirm" that
 * also mentioned an unrelated reminder request was treated as NOT a
 * confirmation at all. Relying solely on the LLM to self-report caller
 * intent via the marker is therefore not robust enough on its own.
 *
 * This is a plain, deterministic, directly-testable pattern match over the
 * caller's own raw words — independent of whatever the model's marker
 * says this turn — used in handleUserUtterance as a BACKSTOP: it only ever
 * fills in a field the marker left unset, or forces a dispatch the marker
 * should have proposed but didn't; it never overrides a marker value that
 * IS present. Deliberately simple keyword/phrase matching, not an NLU
 * model — scoped to exactly the phrasings this incident and the task's
 * own requirements call out, and unit-tested against them directly (see
 * voice-runtime.server.test.ts).
 */
export interface CallerIntentSignals {
  /** The caller is asking what's open/free — with or without a specific time. */
  availabilityRequested: boolean;
  /** The caller explicitly asked for the next/earliest/soonest open slot. */
  wantsNextAvailable: boolean;
  /** An approximate time-of-day the caller gave, if any ("this afternoon"). */
  preferredPeriod: "morning" | "afternoon" | "evening" | null;
  /** "today"/"tomorrow", if the caller said either literally — resolved to an actual date by the caller (via resolveRelativeDateInTimezone), never here (no timezone available at plain-text-parsing time). */
  relativeDate: "today" | "tomorrow" | null;
  /** The caller affirmatively confirmed a booking ("yes", "please confirm", "that works", "go ahead", "book it") — only meaningful where the runtime already knows a specific slot is being discussed (see handleUserUtterance's own gating). */
  bookingConfirmed: boolean;
  /** The caller asked for a reminder/alert — a capability this codebase does not implement (see REMINDERS_NOT_IMPLEMENTED_NOTICE). */
  reminderRequested: boolean;
}

const AVAILABILITY_KEYWORDS =
  /\b(available|availability|availabl[ey]|slots?|openings?|free|anything open|any time|what time)\b/i;
const AVAILABILITY_QUESTION_SHAPE =
  /\b(any|anything|do you have|what('s| is)|is there|are there|what times?)\b/i;
const NEXT_AVAILABLE_PATTERN =
  /\b(next available|earliest|soonest|first available|as soon as possible|asap)\b/i;
const PERIOD_PATTERNS: [RegExp, "morning" | "afternoon" | "evening"][] = [
  [/\bmorning\b/i, "morning"],
  [/\bafternoon\b/i, "afternoon"],
  [/\b(evening|tonight)\b/i, "evening"],
];
const RELATIVE_DATE_PATTERNS: [RegExp, "today" | "tomorrow"][] = [
  // "tomorrow" checked before "today" below (order of the returned array,
  // not this regex) only matters if a sentence absurdly contained both;
  // realistically mutually exclusive in one utterance.
  [/\btomorrow\b/i, "tomorrow"],
  [/\btoday\b/i, "today"],
];
// Deliberately requires a standalone affirmative word/phrase, not just any
// sentence containing "confirm" — e.g. "can you confirm the address" is
// not a booking confirmation. Still intentionally broad (matches real
// speech variants: "yeah", "yep", "sure", "go ahead", "sounds good",
// "that works", "please confirm", "book it", "please book it"), and
// explicitly excludes an immediately-preceding negation ("no", "don't",
// "not yet") so "no, don't confirm that" is never misread as a yes.
const BOOKING_CONFIRMATION_PATTERN =
  /\b(yes|yeah|yep|yup|sure|confirm(ed)?|go ahead|sounds good|that works|book it|please book)\b/i;
const BOOKING_NEGATION_PATTERN = /\b(no|not|don't|do not|never ?mind|cancel|wait)\b/i;
const REMINDER_PATTERN =
  /\b(remind(er)?|alert) me\b|\bset (a |an )?remind(er)?\b|\bsend me a remind(er)?\b/i;

export function parseCallerIntentFromText(text: string): CallerIntentSignals {
  const availabilityRequested =
    AVAILABILITY_KEYWORDS.test(text) &&
    (AVAILABILITY_QUESTION_SHAPE.test(text) ||
      /\?/.test(text) ||
      NEXT_AVAILABLE_PATTERN.test(text));
  const wantsNextAvailable = NEXT_AVAILABLE_PATTERN.test(text);
  const preferredPeriod = PERIOD_PATTERNS.find(([re]) => re.test(text))?.[1] ?? null;
  const relativeDate = RELATIVE_DATE_PATTERNS.find(([re]) => re.test(text))?.[1] ?? null;
  const bookingConfirmed =
    BOOKING_CONFIRMATION_PATTERN.test(text) && !BOOKING_NEGATION_PATTERN.test(text);
  const reminderRequested = REMINDER_PATTERN.test(text);
  return {
    availabilityRequested,
    wantsNextAvailable,
    preferredPeriod,
    relativeDate,
    bookingConfirmed,
    reminderRequested,
  };
}

/** Resolves "today"/"tomorrow" to an actual YYYY-MM-DD in the business's own timezone — noon-anchored (zonedWallTimeToUtc) before adding 24h for "tomorrow", the same DST-transition-safe technique calendar/timezone.ts's own dayOfWeekInTimezone uses, rather than naive UTC day arithmetic (never the server's own local time, never UTC). */
function resolveRelativeDateInTimezone(
  relative: "today" | "tomorrow",
  timeZone: string,
  now: Date = new Date(),
): string {
  const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayYmd = ymdFormatter.format(now);
  if (relative === "today") return todayYmd;
  const tomorrowInstant = new Date(
    zonedWallTimeToUtc(todayYmd, "12:00", timeZone).getTime() + 24 * 60 * 60 * 1000,
  );
  return ymdFormatter.format(tomorrowInstant);
}

/** This codebase has no reminder/alert-scheduling tool or service — see ai-tools.server.ts's TOOL_REGISTRY, which has none. Injected as grounding context for the turn the caller asks for one, so the model's own reply is honest about it instead of inventing a promise nothing will ever fulfill — see handleUserUtterance. */
const REMINDERS_NOT_IMPLEMENTED_NOTICE =
  "The caller just asked for a reminder, alert, or callback to be scheduled for a specific time. This system has NO reminder-scheduling capability of any kind — there is no way to actually set one. Tell the caller honestly and briefly that you can't set a reminder on this line. Do not say a reminder will be sent, scheduled, or created. This does not change anything else you were asked in the same turn (e.g. still address a booking request normally).";

function pickGreeting(agent: AgentSnapshot["agent"], businessName: string): string {
  const language = agent.primary_language;
  return (
    agent.greetings?.[language]?.trim() ||
    `Hello, thanks for calling ${businessName}. How can I help you today?`
  );
}

function outputCodecFor(bridge: AudioMediaBridge): "mulaw" | "linear16" | "wav" {
  const enc = bridge.outboundFormat.encoding;
  return enc === "mulaw" ? "mulaw" : enc === "linear16" ? "linear16" : "wav";
}

async function markAgentLive(agentConfigId: string | null) {
  if (!agentConfigId) return;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("agent_configs")
      .update({ status: "live" })
      .eq("id", agentConfigId)
      .neq("status", "live");
  } catch (err) {
    console.error("voice_runtime:mark_live_failed", (err as Error).message);
  }
}

async function persistTranscript(session: Session) {
  try {
    const summary = session.turns.length
      ? `${session.turns.length} turns · ${session.detectedLanguage ?? session.input.snapshotAgent.primary_language}`
      : "No conversation recorded.";
    await session.deps.persistTranscript({
      callId: session.input.callId,
      turns: session.turns,
      summary,
      language: resolveResponseLanguage(
        session.detectedLanguage,
        session.input.snapshotAgent.primary_language,
      ),
      agentVersion: session.input.agentVersion,
    });
    log("persist_transcript_succeeded", session, { turn_count: session.turns.length });
  } catch (err) {
    log("persist_transcript_failed", session, { message: (err as Error).message });
  }
}

/**
 * Reconnects TTS with a different language_code when the turn about to be
 * spoken needs one the current connection wasn't opened with — see
 * ttsLanguage's own doc comment. Sarvam's realtime TTS protocol has no
 * documented way to change language_code on an already-open connection
 * (it is sent once, in the connect-time config message — see
 * sarvam-realtime.server.ts's connectSarvamTts); guessing an undocumented
 * per-message field is exactly what this codebase's own standing
 * convention refuses to do (see sarvam.server.ts's and sarvam-realtime.
 * server.ts's module docs), so this reuses the one confirmed-working
 * mechanism — connect, with a config message — a second time instead.
 * Same voice_id/pace/codec/sample rate; only language_code changes. A
 * no-op (no await, no reconnect) whenever the target language already
 * matches, which is every turn in a monolingual call.
 */
async function maybeSwitchTtsLanguage(session: Session): Promise<void> {
  const targetLanguage = resolveResponseLanguage(
    session.detectedLanguage,
    session.input.snapshotAgent.primary_language,
  );
  if (targetLanguage === session.ttsLanguage || !session.tts) return;
  log("tts_language_switch_started", session, { from: session.ttsLanguage, to: targetLanguage });
  try {
    const oldTts = session.tts;
    const oldConnectionId = session.activeTtsConnectionId;
    // Task 6: mint this new connection's id BEFORE connecting, and
    // deliberately do NOT make it the active one until the connection has
    // actually succeeded — if connectTts throws, the OLD connection (and
    // its id) stays authoritative, exactly as the catch block below
    // expects. onTtsEvent's "audio" case checks this id on every chunk,
    // so a chunk still in flight from `oldTts` at the moment of the swap
    // is dropped rather than forwarded twice.
    const newConnectionId = ++session.ttsConnectionIdSeq;
    const newTts = await session.deps.connectTts({
      voiceId: session.input.snapshotAgent.voice_id,
      language: targetLanguage,
      pace: session.input.snapshotAgent.speaking_pace,
      outputCodec: session.declaredTtsOutputCodec ?? "mulaw",
      outputSampleRateHz: session.declaredTtsOutputSampleRateHz ?? 8000,
      onEvent: (e) => onTtsEvent(session, e, newConnectionId),
    });
    session.tts = newTts;
    session.ttsLanguage = targetLanguage;
    session.ttsConnectedAt = Date.now();
    session.activeTtsConnectionId = newConnectionId;
    console.info("tts:connection_replaced", {
      call_id: session.input.callId,
      old_connection_id: oldConnectionId,
      new_connection_id: newConnectionId,
      reason: "language_switch",
    });
    try {
      oldTts.close();
    } catch {
      /* best-effort */
    }
    log("tts_language_switch_succeeded", session, { language: targetLanguage });
  } catch (err) {
    // Keep speaking in whatever language TTS is still connected with
    // rather than leaving the caller with no audio at all.
    log("tts_language_switch_failed", session, {
      message: (err as Error).message,
      attempted: targetLanguage,
    });
  }
}

async function speak(
  session: Session,
  text: string,
  asState: "greeting" | "speaking" = "speaking",
): Promise<void> {
  if (asState !== "greeting") await maybeSwitchTtsLanguage(session);
  if (!session.tts) return;
  setState(session, asState);
  // Task 2/7: a fresh id for THIS specific utterance, so diagnostics can
  // prove whether the same one was ever sent twice (greeting_sent /
  // greeting_skipped_duplicate) or show exactly which one barge-in
  // cancelled (barge_in's cancelled_utterance_id).
  session.currentUtteranceId = crypto.randomUUID();
  // Tags whatever audio Sarvam streams back for this text as belonging to
  // the CURRENT generation — see onTtsEvent's "audio" case and the
  // activeSpeechGeneration field's own doc comment. If a barge-in bumps
  // session.generation before all of this text's audio has arrived, those
  // later chunks stop matching and get dropped instead of reaching the
  // caller.
  session.activeSpeechGeneration = session.generation;
  session.staleAudioDropLogged = false;
  const ttsTextSentAt = Date.now();
  if (session.currentTurn) session.currentTurn.ttsTextSentAt = ttsTextSentAt;
  let chunkCount = 0;
  for (const chunk of chunkIntoSentences(text)) {
    session.tts.sendText(chunk);
    session.tts.flush();
    // See ttsAudioInFlight — paired with onTtsEvent's "flushed" case
    // incrementing ttsChunksFlushed once Sarvam confirms this chunk's
    // audio was fully delivered.
    session.ttsChunksSent += 1;
    chunkCount += 1;
  }
  if (chunkCount > 0) {
    log("tts_text_sent", session, { tts_text_sent_at: ttsTextSentAt, chunkCount });
    // Requested diagnostic naming (distinct from the voice_runtime:* namespace
    // above) — the moment the final spoken reply for this turn is actually
    // handed to TTS, paired with tts:completed once its audio has fully
    // played out (onTtsEvent's "flushed" case) — so latency from "tool
    // result ready" (voice:final_response) to "caller can hear something"
    // is directly measurable from logs alone.
    namedLog("tts:start", session, { at: ttsTextSentAt, chunkCount });
  }
}

/**
 * Resolves one turn's reply — plain generateReply, or the single-tool-
 * call-round path when the runtime's deps support it AND the agent has
 * at least one permitted tool. An agent with tool-calling deps wired but
 * zero permitted tools (the common case: no capabilities granted) still
 * takes the exact same plain-generateReply path as before tools existed.
 */
async function getReply(
  session: Session,
  messages: ChatMessage[],
): Promise<{ reply: string; enteredPaymentWait: boolean; usedToolCalling: boolean }> {
  const { generateReplyWithTools, resolveAvailableTools, executeTool } = session.deps;
  if (generateReplyWithTools && resolveAvailableTools && executeTool) {
    const tools = await resolveAvailableTools(
      session.input.organizationId,
      session.input.businessId,
    );
    if (tools.length > 0) {
      const toolCtx: ToolExecContext = {
        organizationId: session.input.organizationId,
        businessId: session.input.businessId,
        agentConfigId: session.input.agentConfigId,
        callId: session.input.callId,
      };
      const result = await generateReplyWithTools(messages, tools, (name, input) =>
        executeTool(name, input, toolCtx),
      );
      if (result.toolCalls.length) {
        log("tool_calls_executed", session, {
          tools: result.toolCalls.map((t) => ({ name: t.name, is_error: t.isError })),
        });
      }
      // A successful request_payment call means the runtime should switch
      // to the bounded waiting_on_payment state after this reply is
      // spoken, rather than plain listening — see handleUserUtterance.
      const enteredPaymentWait = result.toolCalls.some(
        (t) => t.name === "request_payment" && !t.isError,
      );
      return { reply: result.reply, enteredPaymentWait, usedToolCalling: true };
    }
  }
  const { reply } = await session.deps.generateReply(messages);
  return { reply, enteredPaymentWait: false, usedToolCalling: false };
}

/** Appointment length assumed when the caller's requested service has no known duration — this flow doesn't attempt to match the free-text service name the caller used against the business's configured services list, so a per-service duration isn't available here. */
const DEFAULT_APPOINTMENT_DURATION_MINUTES = 30;

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Looked up fresh for each booking attempt rather than threaded through StartRuntimeSessionInput — see attemptBooking's own doc comment for why. */
async function resolveBusinessTimezone(businessId: string): Promise<string> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("businesses")
      .select("timezone")
      .eq("id", businessId)
      .maybeSingle();
    return data?.timezone ?? "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Phrases a short, honest, caller-language-appropriate reply describing
 * the REAL outcome of a booking attempt — a second, separate, narrowly-
 * scoped LLM call (not the main conversational one) so the wording always
 * reflects `facts` (which states plainly whether the booking actually
 * succeeded) rather than whatever the model's own main-conversation reply
 * speculatively claimed before the real tool result was known. This is
 * the mechanism behind "never claim booked unless it actually succeeded"
 * — see attemptBooking. Only invoked once per call at most (the one turn
 * that actually finalizes a booking attempt), so the extra round trip
 * this costs is a deliberate, bounded exception to the "no extra LLM
 * calls per turn" latency goal — not a regression of it.
 */
async function composeHonestBookingReply(session: Session, facts: string): Promise<string> {
  const language = resolveResponseLanguage(
    session.detectedLanguage,
    session.input.snapshotAgent.primary_language,
  );
  // Requested diagnostic naming: every call into this function follows a
  // real calendar tool result (or the "no tool executor configured"
  // degenerate case) — this is the "tool result -> final LLM response"
  // hop Task 11 requires be provably present, not just "tool invocation ->
  // tool result -> return -> silence". Never logs `facts` itself (it can
  // embed the caller's name/phone — see attemptBooking's own facts
  // strings), only that a result arrived and how long composing the final
  // spoken reply from it took.
  const startedAt = Date.now();
  namedLog("voice:tool_result", session, { at: startedAt });
  try {
    const { reply } = await session.deps.generateReply([
      {
        role: "system",
        content: `You are ${session.input.snapshotAgent.agent_name}, a phone receptionist. Respond in language code ${language}. One or two short sentences, phone-conversation style. State only what the facts below say — never claim a booking succeeded unless the facts say it did. Never mention a support ticket, a callback, or a reminder being created/scheduled/sent unless the facts below explicitly say one was. Do not add any JSON, markers, or notes.`,
      },
      { role: "user", content: facts },
    ]);
    const spoken = reply.trim();
    namedLog("voice:final_response", session, {
      latency_ms: Date.now() - startedAt,
      replyLength: spoken.length,
    });
    return spoken;
  } catch (err) {
    log("booking_reply_composition_failed", session, { message: (err as Error).message });
    const fallback = facts.toLowerCase().includes("succeeded")
      ? "Your appointment is confirmed."
      : "I'm sorry, I couldn't confirm that booking. Someone from our team will follow up with you shortly.";
    namedLog("voice:final_response", session, {
      latency_ms: Date.now() - startedAt,
      replyLength: fallback.length,
      fellBackToCannedReply: true,
    });
    return fallback;
  }
}

/**
 * Production incident: callers asking "can you check if that slot is
 * available?" or "book me tomorrow at 3pm" got total silence. Root cause
 * (see this file's and llm-provider.server.ts's own module docs): Sarvam —
 * the default/production LLM provider — has no native function/tool-
 * calling wired at all (resolveGenerateReplyWithTools returns undefined
 * for it), so a calendar operation here is never bounded by the provider's
 * own request timeout the way an LLM call is (REQUEST_TIMEOUT_MS in
 * sarvam.server.ts/claude.server.ts). The underlying Google Calendar
 * provider does have its own retry/timeout (DEFAULT_TIMEOUT_MS=15s,
 * up to MAX_RETRIES=2 — google-calendar-provider.server.ts), but that can
 * still take up to ~45s in the worst case — comfortably longer than is
 * acceptable for a live phone call. CALENDAR_TOOL_TIMEOUT_MS bounds each
 * individual calendar tool call (availability check, booking) from the
 * voice runtime's side specifically, so a slow/hung Google Calendar call
 * degrades to a spoken "I'm having trouble reaching the calendar" apology
 * instead of silence — on top of (not instead of) the whole-turn
 * TURN_DEADLINE_MS safety net above, which still protects every other
 * stage of the turn.
 */
const CALENDAR_TOOL_TIMEOUT_MS = 10_000;

class ToolTimeoutError extends Error {
  constructor(ms: number) {
    super(`Calendar tool call exceeded ${ms}ms`);
  }
}

function withToolDeadline<T>(ms: number, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Converts a ToolTimeoutError into the exact same `{content, isError}` shape a real tool result has (see ai-tools.server.ts's ToolDefinition['execute']), so downstream code (safeJsonParse, error-code branching, calendar_tool:error logging) handles a timeout identically to any other structured tool failure — never a special case. Anything that is NOT a ToolTimeoutError is rethrown unchanged: this must never mask a genuine bug as a timeout. */
function timeoutToolResult(err: unknown): { content: string; isError: boolean } {
  if (!(err instanceof ToolTimeoutError)) throw err;
  return {
    content: JSON.stringify({
      success: false,
      error: { code: "CALENDAR_TIMEOUT", message: "Google Calendar did not respond in time." },
    }),
    isError: true,
  };
}

/** Phrases a calendar tool failure's structured error code into plain facts for composeHonestBookingReply — same "state only what really happened" discipline as the booking-outcome facts strings below, just for the availability/connection-failure branch specifically (Task 3/6: the caller must hear something useful, never silence, when the calendar itself is the problem rather than the requested time being taken). */
function calendarErrorFacts(errorCode: string): string {
  switch (errorCode) {
    case "GOOGLE_AUTH_REQUIRED":
    case "NEEDS_REAUTH":
    case "NOT_CONFIGURED":
      return "The calendar is not connected for this business right now, so availability cannot be checked or confirmed. Apologize briefly, say you're unable to access the calendar right now so you can't confirm that slot yet, and offer to have someone call back.";
    case "CALENDAR_TIMEOUT":
      return "The calendar did not respond in time. Apologize briefly and say you're having trouble reaching the calendar right now, so you couldn't confirm that slot.";
    default:
      return "The calendar could not be reached right now, so availability cannot be confirmed. Apologize briefly and offer a callback.";
  }
}

/** Formats a UTC ISO instant as a plain local HH:mm-style time in the business's own timezone, for phrasing real alternative slots naturally — never a manual UTC-offset calculation (see this file's and calendar/timezone.ts's own convention of using Intl.DateTimeFormat for IANA-timezone-aware formatting, which is DST-safe). */
function formatSlotTimeLocal(isoUtc: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(isoUtc));
  } catch {
    return isoUtc;
  }
}

/** Same conversion as formatSlotTimeLocal, but in the 24-hour "HH:mm" shape AppointmentState.preferredTime is documented to hold (what zonedWallTimeToUtc expects back) — used when WRITING a real resolved slot time into state (e.g. after booking "the next available" slot), never for what's actually spoken to the caller. */
function formatSlotTime24h(isoUtc: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(isoUtc));
  } catch {
    return isoUtc;
  }
}

type AvailabilityPeriod = "morning" | "afternoon" | "evening";

/** The local hour-of-day (0-23) a UTC instant falls on in the business's timezone — used only to filter real returned slots by an approximate period the caller gave ("this afternoon"), never to compute or invent a time itself. */
function localHourOf(isoUtc: string, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(new Date(isoUtc));
    const raw = parts.find((p) => p.type === "hour")?.value;
    const hour = raw ? Number(raw) : NaN;
    return hour === 24 ? 0 : hour;
  } catch {
    return NaN;
  }
}

/** Half-open [start, end) local-hour ranges for each approximate period — a plain, documented convention (not a calendar/business-hours concept), used only to narrow which of the REAL slots check_calendar_availability returned get read out for an approximate request like "this afternoon". */
const PERIOD_HOUR_RANGES: Record<AvailabilityPeriod, readonly [number, number]> = {
  morning: [0, 12],
  afternoon: [12, 17],
  evening: [17, 24],
};

function filterSlotsByPeriod<T extends { start: string }>(
  slots: T[],
  period: AvailabilityPeriod | null,
  timeZone: string,
): T[] {
  if (!period) return slots;
  const [lo, hi] = PERIOD_HOUR_RANGES[period];
  return slots.filter((slot) => {
    const hour = localHourOf(slot.start, timeZone);
    return hour >= lo && hour < hi;
  });
}

/**
 * Attempts to check (never book) whether the caller's requested date is
 * free, when the model has proposed "checking_availability" (see
 * parseApptStateMarker) and at least a date is known — unlike attemptBooking,
 * the caller's name/phone are not required merely to check. Handles three
 * shapes of request against the exact same real check_calendar_availability
 * call:
 *   - an exact time ("is 3pm available?") — reports yes/no for that exact
 *     instant, with real alternatives on no;
 *   - an approximate period ("any slots this afternoon?") — lists the real
 *     returned slots filtered to that period;
 *   - fully open ("any slots available today?") — lists the real returned
 *     slots for the day, unfiltered.
 * Calls the real check_calendar_availability tool directly, same
 * deterministic-dispatch rationale as attemptBooking's own doc comment
 * (Sarvam has no native tool-calling to dispatch through). Never reports a
 * slot as available/unavailable, and never offers a time, except exactly
 * what this real tool call returned — the mechanism behind "never invent
 * availability".
 */
async function attemptAvailabilityCheck(
  session: Session,
): Promise<{ spoken: string; state: AppointmentState }> {
  const state = session.appointmentState;
  const executeTool = session.deps.executeTool;
  const callId = session.input.callId;
  const businessId = session.input.businessId;

  if (!executeTool || !state.preferredDate) {
    namedLog("calendar_tool:error", session, {
      tool: "check_calendar_availability",
      code: "NOT_CONFIGURED",
    });
    return {
      spoken: await composeHonestBookingReply(
        session,
        "Availability could not be checked because this line isn't configured for live calendar access. Tell the caller you'll have someone confirm and call them back.",
      ),
      state: { ...state, bookingStatus: "collecting", availabilityStatus: "unknown" },
    };
  }

  const ctx: ToolExecContext = {
    organizationId: session.input.organizationId,
    businessId,
    agentConfigId: session.input.agentConfigId,
    callId,
  };
  const timezone = await resolveBusinessTimezone(businessId);
  const exactStartIso = state.preferredTime
    ? zonedWallTimeToUtc(state.preferredDate, state.preferredTime, timezone).toISOString()
    : null;

  namedLog("calendar_tool:start", session, {
    tool: "check_calendar_availability",
    call_id: callId,
    business_id: businessId,
    date: state.preferredDate,
    requested_time: state.preferredTime ?? state.preferredPeriod ?? "any",
  });
  const startedAt = Date.now();
  namedLog("calendar_tool:provider_request", session, { tool: "check_calendar_availability" });

  const availability = await withToolDeadline(
    CALENDAR_TOOL_TIMEOUT_MS,
    executeTool(
      "check_calendar_availability",
      { dateIso: state.preferredDate, durationMinutes: DEFAULT_APPOINTMENT_DURATION_MINUTES },
      ctx,
    ),
  ).catch(timeoutToolResult);

  const latencyMs = Date.now() - startedAt;
  const availabilityResult = safeJsonParse(availability.content);
  const slots = Array.isArray((availabilityResult?.["data"] as { slots?: unknown })?.["slots"])
    ? ((availabilityResult?.["data"] as { slots: { start: string; end: string }[] }).slots ?? [])
    : [];
  namedLog("calendar_tool:provider_response", session, {
    latency_ms: latencyMs,
    success: !availability.isError,
    available_count: slots.length,
  });

  if (availability.isError) {
    const errorCode =
      (availabilityResult?.["error"] as { code?: string } | undefined)?.code ?? "UNKNOWN";
    namedLog("calendar_tool:error", session, {
      tool: "check_calendar_availability",
      code: errorCode,
      latency_ms: latencyMs,
    });
    return {
      spoken: await composeHonestBookingReply(session, calendarErrorFacts(errorCode)),
      state: { ...state, bookingStatus: "collecting", availabilityStatus: "unknown" },
    };
  }

  namedLog("calendar_tool:completed", session, { tool: "check_calendar_availability" });

  // Exact-time request: report yes/no for that one instant specifically.
  if (exactStartIso) {
    const requestedSlot = slots.find((slot) => slot.start === exactStartIso);
    if (requestedSlot) {
      return {
        spoken: await composeHonestBookingReply(
          session,
          `The requested slot (${state.preferredTime} on ${state.preferredDate}) IS available, confirmed by the calendar. Tell the caller it's available and ask if they'd like you to book it now.`,
        ),
        state: {
          ...state,
          bookingStatus: "collecting",
          availabilityStatus: "available",
          selectedSlot: requestedSlot,
        },
      };
    }
    // Never invents alternatives — exactly the next real slots the
    // calendar itself returned for that day, nothing else.
    const alternatives = slots.slice(0, 2).map((slot) => formatSlotTimeLocal(slot.start, timezone));
    return {
      spoken: await composeHonestBookingReply(
        session,
        alternatives.length
          ? `The requested slot (${state.preferredTime} on ${state.preferredDate}) is NOT available. The only real alternative times open that day are: ${alternatives.join(" and ")}. Offer exactly these, nothing else, and ask which they'd prefer. Never invent a time not in this list.`
          : `The requested slot (${state.preferredTime} on ${state.preferredDate}) is NOT available, and there are no other open slots that day. Say so honestly and offer to check a different day.`,
      ),
      state: {
        ...state,
        bookingStatus: "collecting",
        availabilityStatus: "unavailable",
        selectedSlot: alternatives.length ? (slots[0] ?? null) : null,
      },
    };
  }

  // Open ("any slots today?") or approximate-period ("this afternoon?")
  // request: list the real returned slots, filtered to the period if one
  // was given — never a single yes/no, and never a time outside this list.
  const filtered = filterSlotsByPeriod(slots, state.preferredPeriod, timezone);
  const periodLabel = state.preferredPeriod ? ` in the ${state.preferredPeriod}` : "";

  if (filtered.length === 0) {
    return {
      spoken: await composeHonestBookingReply(
        session,
        `There are no open slots on ${state.preferredDate}${periodLabel}. Say so honestly in one short sentence${
          state.preferredPeriod
            ? ", and offer to check a different time of day or a different day"
            : ", and offer to check a different day"
        }. Never say a time is available.`,
      ),
      state: {
        ...state,
        bookingStatus: "collecting",
        availabilityStatus: "unavailable",
        selectedSlot: null,
      },
    };
  }

  const listed = filtered.slice(0, 4).map((slot) => formatSlotTimeLocal(slot.start, timezone));
  return {
    spoken: await composeHonestBookingReply(
      session,
      `These real times are open on ${state.preferredDate}${periodLabel}: ${listed.join(", ")}. List exactly these times, nothing else, and ask if they'd like to book one. Never invent a time not in this list.`,
    ),
    state: {
      ...state,
      bookingStatus: "collecting",
      availabilityStatus: "available",
      // Only unambiguous when exactly one real slot came back — with
      // several, "that slot" cannot resolve to any one of them until the
      // caller actually picks.
      selectedSlot: filtered.length === 1 ? (filtered[0] ?? null) : null,
    },
  };
}

/**
 * Attempts to actually book the appointment once AppointmentState reports
 * every required field and the model has proposed "ready_to_book" (see
 * parseApptStateMarker) — the fix for "the agent kept talking instead of
 * actually completing the booking". Calls the exact same real, already-
 * tenant-validated, already-tested calendar tools the Claude tool-calling
 * path would use (check_calendar_availability / book_appointment — see
 * ai-tools.server.ts), but DIRECTLY from the runtime rather than via an
 * LLM-initiated tool_use round trip: Sarvam's function-calling request/
 * response wire format is not documented anywhere this sandbox can reach
 * (see llm-provider.server.ts's own doc comment on why
 * resolveGenerateReplyWithTools only implements Claude today), and
 * guessing it is exactly what this codebase's standing convention refuses
 * to do for any provider wire format (see sarvam.server.ts's and
 * sarvam-realtime.server.ts's own module docs). This deterministic path
 * works identically regardless of which LLM provider is selected.
 *
 * Never returns a success message unless book_appointment itself reports
 * success — an unavailable slot, a missing calendar connection, or any
 * other tool failure all resolve to an honest decline
 * (composeHonestBookingReply), never a fabricated confirmation.
 */
async function attemptBooking(
  session: Session,
): Promise<{ spoken: string; state: AppointmentState }> {
  const state = session.appointmentState;
  const executeTool = session.deps.executeTool;
  // An exact time is not required when the caller explicitly asked for the
  // next/earliest open slot (wantsNextAvailable) — see
  // appointmentStateIsComplete's own doc comment. The actual target slot is
  // resolved below, once the real availability list is in hand.
  if (!executeTool || !state.preferredDate || !(state.preferredTime || state.wantsNextAvailable)) {
    log("booking_attempt_skipped_no_tool_executor", session);
    return {
      spoken: await composeHonestBookingReply(
        session,
        "The booking could not be attempted because this line isn't configured for live booking. Tell the caller you'll have someone confirm the appointment and call them back.",
      ),
      state: { ...state, bookingStatus: "unavailable" },
    };
  }

  const ctx: ToolExecContext = {
    organizationId: session.input.organizationId,
    businessId: session.input.businessId,
    agentConfigId: session.input.agentConfigId,
    callId: session.input.callId,
  };
  const timezone = await resolveBusinessTimezone(session.input.businessId);
  // Only computable when the caller gave an exact time — when they asked
  // for "the next available slot" instead, the target start/end is
  // resolved from the real slots list below (slots[0]), never guessed.
  const requestedStartIso = state.preferredTime
    ? zonedWallTimeToUtc(state.preferredDate, state.preferredTime, timezone).toISOString()
    : null;

  log("booking_attempt_started", session, {
    preferredDate: state.preferredDate,
    preferredTime: state.preferredTime,
    wantsNextAvailable: state.wantsNextAvailable,
  });
  namedLog("calendar_tool:start", session, {
    tool: "check_calendar_availability",
    call_id: session.input.callId,
    business_id: session.input.businessId,
    date: state.preferredDate,
    requested_time: state.preferredTime,
  });
  const availabilityStartedAt = Date.now();
  namedLog("calendar_tool:provider_request", session, { tool: "check_calendar_availability" });

  const availability = await withToolDeadline(
    CALENDAR_TOOL_TIMEOUT_MS,
    executeTool(
      "check_calendar_availability",
      { dateIso: state.preferredDate, durationMinutes: DEFAULT_APPOINTMENT_DURATION_MINUTES },
      ctx,
    ),
  ).catch(timeoutToolResult);
  const availabilityLatencyMs = Date.now() - availabilityStartedAt;
  const availabilityResult = safeJsonParse(availability.content);
  const slots = Array.isArray((availabilityResult?.["data"] as { slots?: unknown })?.["slots"])
    ? ((availabilityResult?.["data"] as { slots: { start: string; end: string }[] }).slots ?? [])
    : [];
  namedLog("calendar_tool:provider_response", session, {
    latency_ms: availabilityLatencyMs,
    success: !availability.isError,
    available_count: slots.length,
  });

  // Genuine tool/calendar FAILURE (no connection, timeout, Google error) is
  // a DIFFERENT outcome from "the tool worked fine but this specific time
  // is taken" — conflating the two (the previous behavior) told the caller
  // their requested time was unavailable even when the real reason was the
  // calendar being unreachable, which is both misleading and exactly the
  // kind of silent-failure-dressed-as-an-answer this fix targets.
  if (availability.isError) {
    const errorCode =
      (availabilityResult?.["error"] as { code?: string } | undefined)?.code ?? "UNKNOWN";
    namedLog("calendar_tool:error", session, {
      tool: "check_calendar_availability",
      code: errorCode,
      latency_ms: availabilityLatencyMs,
    });
    return {
      spoken: await composeHonestBookingReply(session, calendarErrorFacts(errorCode)),
      state: { ...state, bookingStatus: "collecting" },
    };
  }
  namedLog("calendar_tool:completed", session, { tool: "check_calendar_availability" });

  // Target slot resolution: an exact caller-given time must match one of
  // the real returned slots precisely (AvailabilitySlot's own fields are
  // `start`/`end` — calendar-service.server.ts — not startIso/endIso,
  // those names belong to create_calendar_event's input); "next available"
  // takes the earliest real slot the calendar itself returned (computeAvailability
  // already generates slots in chronological order) — never a guessed or
  // rounded time.
  const targetSlot = requestedStartIso
    ? (slots.find((slot) => slot.start === requestedStartIso) ?? null)
    : (slots[0] ?? null);

  if (!targetSlot) {
    log("booking_attempt_unavailable", session, { toolSucceeded: true });
    // Never invents alternatives — exactly the next real slots the
    // calendar itself returned for that day, same discipline as
    // attemptAvailabilityCheck.
    const alternatives = slots.slice(0, 2).map((slot) => formatSlotTimeLocal(slot.start, timezone));
    const requestedLabel = state.preferredTime
      ? `${state.preferredTime} on ${state.preferredDate}`
      : `${state.preferredDate}`;
    return {
      spoken: await composeHonestBookingReply(
        session,
        alternatives.length
          ? `The requested slot (${requestedLabel}) is NOT available. The only real alternative times open that day are: ${alternatives.join(" and ")}. Offer exactly these, nothing else, and ask which they'd prefer. Do not say it was booked.`
          : `There are no open slots available for ${requestedLabel}${state.preferredTime ? "" : " at all"}. Say so honestly and offer to check a different day. Do not say it was booked.`,
      ),
      state: {
        ...state,
        bookingStatus: "unavailable",
        availabilityStatus: "unavailable",
        selectedSlot: alternatives.length ? (slots[0] ?? null) : null,
      },
    };
  }
  const startIso = targetSlot.start;
  const endIso = targetSlot.end;
  // The REAL time being booked — for an exact-time request this equals
  // what the caller already said; for "next available" it's the actual
  // resolved slot. bookedLocalTime (human-readable, spoken to the caller)
  // and bookedTime24h (24-hour "HH:mm", the shape preferredTime is
  // documented to hold and zonedWallTimeToUtc expects back) are kept
  // separate so a later "that slot" reference can still be re-resolved
  // correctly — storing the 12-hour spoken form in preferredTime would
  // silently break that.
  const bookedLocalTime = formatSlotTimeLocal(startIso, timezone);
  const bookedTime24h = formatSlotTime24h(startIso, timezone);

  namedLog("calendar_tool:start", session, {
    tool: "book_appointment",
    call_id: session.input.callId,
    business_id: session.input.businessId,
    date: state.preferredDate,
    requested_time: state.preferredTime ?? "next_available",
  });
  const bookingStartedAt = Date.now();
  namedLog("calendar_tool:provider_request", session, { tool: "book_appointment" });

  const booking = await withToolDeadline(
    CALENDAR_TOOL_TIMEOUT_MS,
    executeTool(
      "book_appointment",
      {
        customerName: state.customerName,
        customerPhone: state.phone,
        startIso,
        endIso,
        notes: state.service,
      },
      ctx,
    ),
  ).catch(timeoutToolResult);
  const bookingLatencyMs = Date.now() - bookingStartedAt;
  const bookingResult = safeJsonParse(booking.content);
  namedLog("calendar_tool:provider_response", session, {
    latency_ms: bookingLatencyMs,
    success: !booking.isError && bookingResult?.["success"] === true,
    available_count: null,
  });

  if (booking.isError || bookingResult?.["success"] !== true) {
    const errorCode = (bookingResult?.["error"] as { code?: string } | undefined)?.code ?? null;
    log("booking_attempt_failed", session, { errorCode });
    namedLog("calendar_tool:error", session, {
      tool: "book_appointment",
      code: errorCode ?? "UNKNOWN",
      latency_ms: bookingLatencyMs,
    });
    return {
      spoken: await composeHonestBookingReply(
        session,
        errorCode === "CALENDAR_TIMEOUT"
          ? calendarErrorFacts("CALENDAR_TIMEOUT")
          : "The booking attempt failed on our end. Apologize briefly and say someone will follow up to confirm. Do not say it was booked.",
      ),
      state: { ...state, bookingStatus: "unavailable" },
    };
  }

  log("booking_attempt_succeeded", session);
  namedLog("calendar_tool:completed", session, { tool: "book_appointment" });
  return {
    spoken: await composeHonestBookingReply(
      session,
      `The booking succeeded: ${state.service ?? "the appointment"} for ${state.customerName ?? "the caller"} on ${state.preferredDate} at ${bookedLocalTime}. Confirm this briefly.`,
    ),
    state: {
      ...state,
      // The REAL booked time, even for a "next available" request where
      // preferredTime started out null — see bookedTime24h's own comment.
      preferredTime: bookedTime24h,
      wantsNextAvailable: false,
      bookingStatus: "booked",
      availabilityStatus: "unknown",
      selectedSlot: null,
    },
  };
}

/**
 * Serializes handleUserUtterance calls onto session.utteranceQueue — see
 * that field's own doc comment for why. onSttEvent's "final_transcript"
 * case calls this instead of invoking handleUserUtterance directly, so two
 * final_transcript events landing close together (a provider redelivery,
 * or a new utterance arriving while the previous one's LLM call is still
 * in flight) can never race: the first call's entire body — its own "user"
 * turn push, its LLM call, and its reply push-or-discard — always finishes
 * before the next one's "user" turn is pushed.
 */
function enqueueUserUtterance(session: Session, text: string) {
  session.utteranceQueue = session.utteranceQueue.then(() =>
    handleUserUtterance(session, text).catch((err: unknown) => {
      log("utterance_queue_error", session, { message: (err as Error).message });
    }),
  );
}

async function handleUserUtterance(session: Session, text: string) {
  session.turns.push({ role: "user", text, at: new Date().toISOString() });
  // Deterministic backstop over the caller's own raw words — see
  // parseCallerIntentFromText's own doc comment for the production
  // incident this responds to (the model's own marker emission is not
  // reliably followed every turn). Computed once, up front, so both the
  // pre-reply system-message grounding below (reminders) and the
  // post-reply state enrichment further down use the exact same read of
  // this turn's caller text.
  const callerIntent = parseCallerIntentFromText(text);
  // Defensive: speech_end (onSttEvent) already arms a fresh silence timer
  // the moment the caller stops talking, before final_transcript has even
  // arrived. That timer is only otherwise cleared by a subsequent
  // speech_start — so a slow STT finalization + LLM + TTS round trip for
  // THIS turn could otherwise race it and speak a false "are you still
  // there?" over a caller who was never actually silent. Clearing it here,
  // the moment this turn is accepted, removes that race regardless of how
  // long the rest of this turn takes.
  clearSilenceTimer(session);
  // Whatever payment wait was pending no longer applies — the caller is
  // actively talking again now, and this turn will address whatever they
  // said (possibly re-arming a fresh wait itself, if it results in another
  // request_payment call).
  clearPaymentWaitTimer(session);
  setState(session, "thinking");
  const generation = ++session.generation;
  const requestStarted = Date.now();
  const llmRequestAt = requestStarted;

  // The runtime's own ground truth for what the caller has already
  // confirmed — see AppointmentState's own doc comment. Built from state
  // BEFORE this turn, so the model is told what's already known without
  // depending on it still being visible in the (bounded)
  // CONVERSATION_HISTORY_TURNS window.
  const knownAppointmentState = describeKnownAppointmentState(session.appointmentState);
  const messages: ChatMessage[] = [
    { role: "system", content: session.input.instructions },
    ...(knownAppointmentState
      ? [{ role: "system", content: knownAppointmentState } as ChatMessage]
      : []),
    // Grounds the model with the truth about reminder scheduling (not
    // implemented — see REMINDERS_NOT_IMPLEMENTED_NOTICE) BEFORE it
    // replies, rather than trying to catch/correct a fabricated promise
    // after the fact — the fix for a real call where the agent promised
    // "you will receive a reminder at 1pm tomorrow" with no such mechanism
    // existing anywhere in this codebase.
    ...(callerIntent.reminderRequested
      ? [{ role: "system", content: REMINDERS_NOT_IMPLEMENTED_NOTICE } as ChatMessage]
      : []),
    ...session.turns
      .slice(-CONVERSATION_HISTORY_TURNS)
      .map((t) => ({ role: t.role, content: t.text }) as ChatMessage),
  ];
  // Safe metadata only — message count and roles, never any message's
  // actual content (the caller's words or the agent's own reply text).
  if (session.currentTurn) session.currentTurn.llmRequestAt = llmRequestAt;
  log("llm_request", session, {
    generation,
    messageCount: messages.length,
    roles: messages.map((m) => m.role),
    llm_request_at: llmRequestAt,
  });

  try {
    await withTurnDeadline(TURN_DEADLINE_MS, async (isCancelled) => {
      const {
        reply: rawReply,
        enteredPaymentWait,
        usedToolCalling,
      } = await getReply(session, messages);
      const llmCompletedAt = Date.now();
      if (session.currentTurn) session.currentTurn.llmCompletedAt = llmCompletedAt;
      log("llm_completed", session, {
        latency_ms: llmCompletedAt - requestStarted,
        llm_completed_at: llmCompletedAt,
      });

      // Soft cancellation: if the caller interrupted (or spoke again) while
      // this request was in flight, `generation` has already advanced — the
      // stale reply is discarded instead of being spoken over the new turn.
      // (There is no request-cancellation signal to abort the call outright —
      // this is the honest, documented limitation; see the Phase E report.)
      if (isCancelled() || generation !== session.generation) {
        log("llm_response_discarded_stale", session);
        return;
      }
      if (!rawReply) {
        log("llm_empty_reply", session);
        setState(session, "listening");
        armSilenceTimer(session);
        return;
      }

      // The marker-based deterministic backstop below exists only for the
      // plain-conversational Sarvam path (no native tool-calling — see
      // parseCallerIntentFromText's own doc comment). When this turn went
      // through the real AI tool-calling path instead (getReply's
      // usedToolCalling), the model already executed real tools via
      // generateReplyWithTools/executeTool with server-derived context —
      // dispatching attemptBooking/attemptAvailabilityCheck AGAIN here
      // would silently replace that already-correct, already-honest reply
      // with a second, redundant tool round trip the caller never asked
      // this code path to run twice.
      let reply = rawReply;
      if (!usedToolCalling) {
        // Strip and parse the trailing structured appointment-state block
        // (see parseApptStateMarker/APPT_STATE_MARKER) — spokenText is what
        // the caller actually hears; the marker itself never reaches TTS or
        // the persisted transcript.
        const { spokenText, state: proposedAppointmentState } = parseApptStateMarker(rawReply);
        let appointmentState = mergeAppointmentState(
          session.appointmentState,
          proposedAppointmentState,
        );

        // Deterministic backstop (production incident: the model's marker
        // did not reliably propose checking_availability/ready_to_book every
        // turn it should have — see parseCallerIntentFromText's own doc
        // comment). Only ever FILLS IN what the marker left unset, or
        // escalates bookingStatus the marker should have proposed — never
        // overrides a value the marker DID set this turn.
        if (
          callerIntent.availabilityRequested &&
          appointmentState.bookingStatus !== "ready_to_book"
        ) {
          let resolvedDate = appointmentState.preferredDate;
          if (!resolvedDate && callerIntent.relativeDate) {
            const timezone = await resolveBusinessTimezone(session.input.businessId);
            resolvedDate = resolveRelativeDateInTimezone(callerIntent.relativeDate, timezone);
          }
          if (resolvedDate) {
            appointmentState = {
              ...appointmentState,
              preferredDate: resolvedDate,
              preferredPeriod: appointmentState.preferredPeriod ?? callerIntent.preferredPeriod,
              wantsNextAvailable:
                appointmentState.wantsNextAvailable || callerIntent.wantsNextAvailable,
              bookingStatus: "checking_availability",
            };
          }
        }
        // Only applies once a specific slot is already clearly on the table
        // (a date, and either a time or an explicit "next available") — never
        // lets a stray "yes"/"sure" earlier in an unrelated exchange misfire
        // into booking something.
        if (
          callerIntent.bookingConfirmed &&
          appointmentState.bookingStatus !== "ready_to_book" &&
          appointmentState.preferredDate &&
          (appointmentState.preferredTime || appointmentState.wantsNextAvailable)
        ) {
          appointmentState = { ...appointmentState, bookingStatus: "ready_to_book" };
        }
        session.appointmentState = appointmentState;

        reply = spokenText;
        // Once every required field is known AND this turn's model proposed
        // moving to booking, the RUNTIME — not the model — performs the real
        // booking attempt and decides what's actually said. See attemptBooking
        // for why this is deterministic rather than an LLM tool-use round
        // trip, and for why it's the fix for "never claim booked unless it
        // actually succeeded". Exactly one of these two deterministic tool
        // paths can fire per turn (ready_to_book takes priority — see
        // parseApptStateMarker) — never both, and never neither when the
        // caller has asked a calendar question the model can't honestly
        // answer on its own: that gap (a caller asking "is that slot free?"
        // with no deterministic hook to answer it) is what previously left
        // the model's own plain-text reply — sometimes empty — as the ONLY
        // response, which is the direct cause of the reported "goes silent
        // when checking availability" production incident.
        if (
          session.appointmentState.bookingStatus === "ready_to_book" &&
          appointmentStateIsComplete(session.appointmentState)
        ) {
          // Production incident: real calendar+LLM round trips left the
          // caller in dead air long enough to say "hello? are you there?".
          // A short, immediate, honest acknowledgement — spoken BEFORE the
          // slower real operation, never claiming an outcome yet — fills
          // that gap with controlled sound instead of silence.
          await speak(session, "Give me just a moment to confirm that.");
          const outcome = await attemptBooking(session);
          reply = outcome.spoken;
          session.appointmentState = outcome.state;
        } else if (
          session.appointmentState.bookingStatus === "checking_availability" &&
          appointmentSlotIsKnown(session.appointmentState)
        ) {
          await speak(session, "Let me check that for you.");
          const outcome = await attemptAvailabilityCheck(session);
          reply = outcome.spoken;
          session.appointmentState = outcome.state;
        }
      }

      if (!reply) {
        log("llm_empty_reply", session);
        setState(session, "listening");
        armSilenceTimer(session);
        return;
      }

      // Deterministic, code-level — never LLM-composed — so this is never
      // itself at risk of fabricating what it describes. Covers EVERY path
      // `reply` can come from (the plain conversational spokenText, or
      // either tool-outcome's composed text) — the earlier
      // REMINDERS_NOT_IMPLEMENTED_NOTICE system message already steers the
      // model's own spokenText honestly in the common case, but when
      // ready_to_book/checking_availability fires in the SAME turn, `reply`
      // is replaced entirely by attemptBooking's/attemptAvailabilityCheck's
      // own composed text, which knows nothing about the reminder — this
      // guarantees the topic is still addressed honestly either way.
      if (callerIntent.reminderRequested && !/remind/i.test(reply)) {
        reply = `${reply} By the way, I'm not able to set reminders on this line.`;
      }

      // Re-checked here (not just after getReply above): attemptBooking is
      // itself an extra await — a barge-in, or this same turn-deadline
      // firing while attemptBooking's own tool calls were still pending,
      // can advance `session.generation` during that call just as easily
      // as during getReply. Without this check, a stale reply computed
      // from before either event could still be pushed/spoken afterwards.
      if (isCancelled() || generation !== session.generation) {
        log("llm_response_discarded_stale", session, { afterBooking: true });
        return;
      }

      session.turns.push({ role: "assistant", text: reply, at: new Date().toISOString() });
      await speak(session, reply);
      if (generation === session.generation) {
        if (enteredPaymentWait) {
          setState(session, "waiting_on_payment");
          armPaymentWaitTimer(session);
        } else {
          setState(session, "listening");
          armSilenceTimer(session);
        }
      }
    });
  } catch (err) {
    // category/status turn a bare message string into something a log
    // line alone can distinguish: a rate limit and a timeout and an
    // outright outage all currently surface as the same caller-facing
    // "having trouble understanding" apology (see speakFallback), but they
    // are very different underlying conditions. errorCategory also makes
    // "this wasn't even a ProviderError" (a genuine code bug, not a
    // provider failure) visible rather than indistinguishable from one.
    const status = err instanceof ProviderError ? err.status : null;
    const errorCategory =
      err instanceof TurnTimeoutError
        ? "turn_deadline_exceeded"
        : err instanceof ProviderError
          ? status === 504
            ? "llm_timeout"
            : status === 429
              ? "llm_rate_limited"
              : status === 401 || status === 403
                ? "llm_auth_error"
                : "llm_provider_error"
          : "llm_unexpected_error";
    log("llm_error", session, {
      message: (err as Error).message,
      status,
      errorCategory,
      latency_ms: Date.now() - requestStarted,
    });
    if (generation === session.generation) {
      await speakFallback(session, err, "llm_error");
      setState(session, "listening");
      armSilenceTimer(session);
    }
  }
}

async function speakFallback(session: Session, error: unknown, trigger: string) {
  const message =
    error instanceof ProviderError
      ? "I'm sorry, I'm having trouble understanding right now. Please hold for a moment or call back shortly."
      : "I'm sorry, something went wrong on my end. Please try again in a moment.";
  log("fallback_spoken", session, {
    trigger,
    status: error instanceof ProviderError ? error.status : null,
    isProviderError: error instanceof ProviderError,
  });
  try {
    await speak(session, message);
  } catch (err) {
    console.error("voice_runtime:fallback_speech_failed", (err as Error).message);
  }
}

function onSttEvent(session: Session, event: SttEvent) {
  switch (event.type) {
    case "speech_start": {
      // The caller is audibly speaking — whatever silence has accumulated
      // so far no longer counts, regardless of which state this arrives in.
      // Same for a pending payment wait: the caller is engaging again, so
      // the bounded wait no longer applies as-is (this turn's own reply
      // may re-arm a fresh one via enteredPaymentWait).
      clearSilenceTimer(session);
      clearPaymentWaitTimer(session);
      session.silencePromptSent = false;
      const state = stateOf(session);
      // Also treated as a barge-in while nominally "listening"/
      // "waiting_on_payment" if TTS audio is still actually playing out —
      // see ttsAudioInFlight's own doc comment: the state machine moves
      // past "speaking" as soon as the reply TEXT has been sent, which for
      // a long reply can be well before its audio has finished streaming.
      // Without this, caller speech during that still-playing tail took
      // the plain "start transcribing" branch below and nothing stopped
      // the old audio from continuing to reach the caller.
      session.lastSpeechStartAt = Date.now();
      const audioStillPlaying =
        (state === "listening" || state === "waiting_on_payment") && ttsAudioInFlight(session);
      if (
        state === "greeting" ||
        state === "speaking" ||
        state === "thinking" ||
        audioStillPlaying
      ) {
        // Barge-in: stop talking immediately, discard the audio already
        // queued for the caller, and soft-cancel any in-flight LLM turn.
        const oldGeneration = session.generation;
        session.generation++;
        session.input.bridge.clearOutboundBuffer();
        session.tts?.flush();
        setState(session, "interrupted");
        log("interruption", session, { audioStillPlaying });
        // Task 7: explicit, dedicated barge-in diagnostic — old/new
        // generation and which utterance was cancelled, so a live call can
        // be checked for "did the caller's next turn actually proceed"
        // without having to cross-reference the generic interruption log.
        log("barge_in", session, {
          old_generation: oldGeneration,
          new_generation: session.generation,
          cancelled_utterance_id: session.currentUtteranceId,
        });
      } else if (state === "listening" || state === "waiting_on_payment") {
        setState(session, "transcribing");
      }
      break;
    }
    case "speech_end":
      session.lastSpeechEndAt = Date.now();
      // The caller just stopped talking. Re-arm from here rather than from
      // speech_start, so the silence window doesn't start counting down
      // while they're still mid-utterance — a no-op unless the state is
      // one of the "waiting on the caller" states (e.g. does nothing while
      // the agent is thinking/speaking, which isn't caller silence).
      armSilenceTimer(session);
      break;
    case "partial_transcript":
      // A partial means the caller is still actively mid-utterance — just
      // as much "caller interaction" as speech_start, even if a provider
      // ever redelivers partials without a clean speech_start of its own.
      // Only cleared here, not re-armed: speech_end is what starts the
      // real "waiting on the caller" countdown once they've actually
      // stopped, not every partial along the way.
      clearSilenceTimer(session);
      session.lastPartialTranscriptAt = Date.now();
      session.accumulatingUserText = event.text;
      break;
    case "final_transcript": {
      session.accumulatingUserText = "";
      if (event.language) session.detectedLanguage = event.language;

      // Duplicate-delivery guard: a provider (or the transport) redelivering
      // the exact same final_transcript event within DUPLICATE_TRANSCRIPT_WINDOW_MS
      // must not be treated as the caller saying the same thing twice — that
      // would push a duplicate transcript entry and fire a second, redundant
      // LLM turn. A genuine repeat after the window has passed (the caller
      // actually saying the same words again) is not affected.
      const last = session.lastFinalTranscript;
      if (
        last &&
        last.text === event.text &&
        Date.now() - last.at < DUPLICATE_TRANSCRIPT_WINDOW_MS
      ) {
        log("duplicate_final_transcript_ignored", session, { text: event.text });
        log("stt:transcript_final_forwarded", session, {
          textLength: event.text.length,
          forwarded: false,
          reason: "duplicate_within_window",
        });
        break;
      }
      session.lastFinalTranscript = { text: event.text, at: Date.now() };

      log("transcript_final", session, { language: event.language });

      // An empty extracted transcript (e.g. a malformed or genuinely empty
      // final_transcript event) must not reach the LLM — pushing an empty
      // user turn would waste a round trip on nothing the caller actually
      // said. This is also what makes the diagnostic below's `reason` field
      // meaningful rather than always "ok".
      if (!event.text) {
        log("stt:transcript_final_forwarded", session, {
          textLength: 0,
          forwarded: false,
          reason: "empty_text",
        });
        break;
      }

      // Latency diagnostics: the moment this turn's trigger actually
      // reached handleUserUtterance, so onTtsEvent can later compute how
      // long the caller waited to hear anything — see
      // currentTurnTranscriptFinalAt's own doc comment.
      const transcriptFinalAt = Date.now();
      session.currentTurnTranscriptFinalAt = transcriptFinalAt;
      session.currentTurnFirstAudioLogged = false;
      // Task 4: seed the correlated per-turn timing record from the most
      // recent VAD timestamps — see CurrentTurnTiming's own doc comment.
      // handleUserUtterance/speak()/onTtsEvent fill in the remaining
      // fields as the turn actually progresses.
      session.currentTurn = {
        audioFirstSeenAt: session.lastSpeechStartAt,
        speechStartAt: session.lastSpeechStartAt,
        speechEndAt: session.lastSpeechEndAt,
        transcriptPartialAt: session.lastPartialTranscriptAt,
        transcriptFinalAt,
        llmRequestAt: null,
        llmCompletedAt: null,
        ttsTextSentAt: null,
        ttsConnectedAt: session.ttsConnectedAt,
        firstTtsAudioAt: null,
        responseAudioEndAt: null,
      };
      log("stt:transcript_final_forwarded", session, {
        textLength: event.text.length,
        forwarded: true,
        reason: "ok",
        transcript_final_at: transcriptFinalAt,
      });
      enqueueUserUtterance(session, event.text);
      break;
    }
    case "language_detected":
      session.detectedLanguage = event.language;
      log("language_detected", session, { language: event.language });
      break;
    case "error":
      // event.raw is Sarvam's own inbound error payload (never our outgoing
      // API key, which is only ever sent as a WS auth subprotocol) — safe
      // to log in full so a rejection's real detail is never silently
      // reduced to the generic fallback message.
      log("stt_error", session, { message: event.message, raw: event.raw });
      break;
    case "closed":
      log("stt_disconnected", session, { code: event.code, reason: event.reason });
      break;
    case "unknown":
      break;
  }
}

function onTtsEvent(session: Session, event: TtsEvent, connectionId: number) {
  switch (event.type) {
    case "audio": {
      // Task 6: only the connection currently in charge may write audio to
      // the telephony bridge — see activeTtsConnectionId's own doc
      // comment. A chunk arriving from a connection maybeSwitchTtsLanguage
      // has since replaced (including one still in flight from the OLD
      // socket at the moment of replacement) is dropped here, before any
      // other bookkeeping, same discipline as the generation check below.
      if (connectionId !== session.activeTtsConnectionId) {
        log("tts_audio_dropped_stale_connection", session, {
          eventConnectionId: connectionId,
          activeConnectionId: session.activeTtsConnectionId,
        });
        break;
      }
      // Drop audio belonging to a reply that's since been barged in on —
      // see activeSpeechGeneration's own doc comment. Sarvam's realtime TTS
      // connection is a single, long-lived stream with no per-request
      // correlation id, so once generation has moved on, any chunk still
      // tagged with the OLD generation must never reach the caller, no
      // matter how many more Sarvam streams back for that abandoned reply.
      // Dropped BEFORE any of the existing bookkeeping below — a stale
      // chunk must not count toward ttsBytesInFlight or the first-frame
      // format diagnostic either.
      if (session.activeSpeechGeneration !== session.generation) {
        if (!session.staleAudioDropLogged) {
          session.staleAudioDropLogged = true;
          log("tts_audio_dropped_stale", session, {
            staleGeneration: session.activeSpeechGeneration,
            currentGeneration: session.generation,
          });
        }
        break;
      }
      if (!session.firstOutboundAudioFrameLogged) {
        session.firstOutboundAudioFrameLogged = true;
        // VERIFICATION ONLY — this log does not itself guarantee the audio
        // format is correct, and fixing a mismatch here would be the wrong
        // place: that's connectSarvamTts's job (output_audio_codec +
        // speech_sample_rate in the config message actually sent to
        // Sarvam; see sarvam-realtime.server.ts's module doc for why both
        // are required, not just the codec). All this does is make a
        // mismatch *visible* after the fact: declaredCodec/
        // declaredSampleRateHz are what this session told Sarvam to
        // synthesize into (connectTts's options); sarvamMeta is whatever
        // else — if anything — Sarvam's own audio event carried alongside
        // the payload (e.g. a sample rate/codec field), surfaced as-is
        // rather than guessed at. The bridge (e.g. Vobiz's
        // sendOutboundFrame) declares this same codec/sample rate to the
        // telephony provider and forwards these bytes verbatim without any
        // resampling, so if Sarvam silently honored a different format,
        // this log — not a connection error — is the only place it would
        // show up before a caller hears garbled/silent audio.
        log("first_outbound_audio_frame", session, {
          bytes: event.data.length,
          declaredCodec: session.declaredTtsOutputCodec,
          declaredSampleRateHz: session.declaredTtsOutputSampleRateHz,
          sarvamMeta: event.meta,
        });
      }
      // Latency diagnostics: the first audio byte of THIS turn's reply is
      // the moment the caller actually starts hearing a response — the
      // perceived delay that matters, not when the LLM call resolved or
      // speak() returned (both can be well before any audio exists). Only
      // meaningful when currentTurnTranscriptFinalAt is set (a real reply
      // to caller speech, not the greeting/a silence prompt/etc. — see its
      // own doc comment) and only logged once per turn.
      if (session.currentTurnTranscriptFinalAt !== null && !session.currentTurnFirstAudioLogged) {
        session.currentTurnFirstAudioLogged = true;
        const firstTtsAudioAt = Date.now();
        if (session.currentTurn) session.currentTurn.firstTtsAudioAt = firstTtsAudioAt;
        log("response_latency", session, {
          first_tts_audio_at: firstTtsAudioAt,
          response_start_latency_ms: firstTtsAudioAt - session.currentTurnTranscriptFinalAt,
        });
      }
      session.ttsBytesInFlight += event.data.length;
      const frame: AudioFrame = { data: event.data, timestampMs: Date.now() - session.startedAt };
      session.input.bridge.sendOutboundFrame(frame);
      break;
    }
    case "error":
      // event.raw is Sarvam's own inbound error payload (never our outgoing
      // API key, which is only ever sent as a WS auth subprotocol) — safe
      // to log in full so a rejection's real detail is never silently
      // reduced to the generic fallback message.
      log("tts_error", session, { message: event.message, raw: event.raw });
      break;
    case "closed":
      log("tts_disconnected", session, { code: event.code, reason: event.reason });
      break;
    case "flushed":
      // One TTS output summary per flushed chunk — bytes only, never the
      // spoken text itself (already logged, where relevant, at the point
      // the reply/prompt text was decided).
      log("tts_output", session, { bytes: session.ttsBytesInFlight });
      session.ttsBytesInFlight = 0;
      // See ttsAudioInFlight — this is what lets onSttEvent's barge-in
      // check recognize caller speech during a still-playing reply's tail
      // even after the state machine has already moved on to "listening".
      session.ttsChunksFlushed += 1;
      // Requested diagnostic naming (distinct from the voice_runtime:*
      // namespace) — pairs with tts:start above: fires once THIS speak()
      // call's audio has fully played out (ttsAudioInFlight false again),
      // not per-chunk, so a single log line per utterance (not per flush
      // event) actually answers "how long did synthesis+delivery take".
      if (!ttsAudioInFlight(session)) {
        namedLog("tts:completed", session, { at: Date.now() });
      }
      // Latency diagnostics: once every chunk sent so far has been fully
      // delivered, this turn's reply audio is completely done — the
      // caller has now heard all of it. Logged once per turn, then the
      // basis timestamp is cleared so an unrelated later speak() call
      // (a silence prompt, a fallback for the NEXT turn) never reuses it.
      if (
        session.currentTurnTranscriptFinalAt !== null &&
        session.currentTurnFirstAudioLogged &&
        !ttsAudioInFlight(session)
      ) {
        const responseAudioEndAt = Date.now();
        const totalResponseLatencyMs = responseAudioEndAt - session.currentTurnTranscriptFinalAt;
        log("response_latency_complete", session, {
          total_response_latency_ms: totalResponseLatencyMs,
        });
        // Task 4: the full correlated per-turn timing record, emitted once
        // this turn's reply audio is completely done — the last point at
        // which every field in CurrentTurnTiming can possibly be known.
        // Each delta is null whenever either of its two timestamps is
        // null (e.g. no speech_start was ever recorded for this turn),
        // rather than a misleading number computed against a missing
        // value.
        if (session.currentTurn) {
          const t = session.currentTurn;
          t.responseAudioEndAt = responseAudioEndAt;
          const delta = (a: number | null, b: number | null) =>
            a !== null && b !== null ? b - a : null;
          log("response_timing", session, {
            audio_first_seen_at: t.audioFirstSeenAt,
            speech_start_at: t.speechStartAt,
            speech_end_at: t.speechEndAt,
            transcript_partial_at: t.transcriptPartialAt,
            transcript_final_at: t.transcriptFinalAt,
            llm_request_at: t.llmRequestAt,
            llm_completed_at: t.llmCompletedAt,
            tts_text_sent_at: t.ttsTextSentAt,
            tts_connected_at: t.ttsConnectedAt,
            first_tts_audio_at: t.firstTtsAudioAt,
            response_audio_end_at: t.responseAudioEndAt,
            speech_to_final_ms: delta(t.speechStartAt, t.transcriptFinalAt),
            final_to_llm_start_ms: delta(t.transcriptFinalAt, t.llmRequestAt),
            llm_latency_ms: delta(t.llmRequestAt, t.llmCompletedAt),
            llm_to_tts_ms: delta(t.llmCompletedAt, t.ttsTextSentAt),
            tts_first_audio_ms: delta(t.ttsTextSentAt, t.firstTtsAudioAt),
            total_response_latency_ms: delta(t.transcriptFinalAt, t.responseAudioEndAt),
          });
          session.currentTurn = null;
        }
        session.currentTurnTranscriptFinalAt = null;
      }
      // The audio that armSilenceTimer deferred on (still in flight at the
      // time) may have just finished — if so, and nothing else has moved
      // the state on since, this is the actual moment the caller starts
      // being genuinely silent, so the wait-on-the-caller window starts
      // counting down now rather than never.
      if (!ttsAudioInFlight(session) && isAwaitingCaller(stateOf(session))) {
        armSilenceTimer(session);
      }
      break;
    case "unknown":
      break;
  }
}

export function getActiveSession(callId: string): RuntimeSessionHandle | null {
  return activeSessions.get(callId)?.handle ?? null;
}

/**
 * Starts (or, idempotently, returns the already-running) runtime session
 * for a call. Never throws — connection failures resolve to a session in
 * the `failed` state with a clear reason, so a Sarvam outage degrades the
 * call gracefully instead of crashing the webhook that invoked this.
 *
 * `deps` defaults to the real Sarvam implementations (`defaultRuntimeDeps`)
 * — production callers never pass this argument. Tests pass a deterministic
 * fake to drive this exact function through a full call without a network
 * call — see voice-runtime-harness.test.ts.
 */
export async function startRuntimeSession(
  input: StartRuntimeSessionInput,
  deps: RuntimeDeps = defaultRuntimeDeps,
): Promise<RuntimeSessionHandle> {
  const existing = activeSessions.get(input.callId);
  if (existing) {
    console.info("voice_runtime:duplicate_start_suppressed", { call_id: input.callId });
    return existing.handle;
  }

  const runtimeSessionId = crypto.randomUUID();
  const handle: RuntimeSessionHandle = {
    callId: input.callId,
    runtimeSessionId,
    state: "created",
    terminate: async (reason: string) => terminateRuntimeSession(input.callId, reason),
  };
  const session: Session = {
    handle,
    input,
    deps,
    turns: [],
    detectedLanguage: null,
    generation: 0,
    startedAt: Date.now(),
    stt: null,
    tts: null,
    accumulatingUserText: "",
    silenceTimer: null,
    silencePromptSent: false,
    paymentWaitTimer: null,
    pendingInboundFrames: [],
    lastFinalTranscript: null,
    firstInboundFrameLogged: false,
    ttsBytesInFlight: 0,
    ttsChunksSent: 0,
    ttsChunksFlushed: 0,
    declaredTtsOutputCodec: null,
    declaredTtsOutputSampleRateHz: null,
    firstOutboundAudioFrameLogged: false,
    activeSpeechGeneration: 0,
    staleAudioDropLogged: false,
    utteranceQueue: Promise.resolve(),
    appointmentState: emptyAppointmentState(),
    ttsLanguage: input.snapshotAgent.primary_language,
    currentTurnTranscriptFinalAt: null,
    currentTurnFirstAudioLogged: false,
    currentTurn: null,
    lastSpeechStartAt: null,
    lastSpeechEndAt: null,
    lastPartialTranscriptAt: null,
    ttsConnectedAt: null,
    currentUtteranceId: null,
    initialGreetingSent: false,
    ttsConnectionIdSeq: 0,
    activeTtsConnectionId: 0,
  };
  activeSessions.set(input.callId, session);
  log("runtime_started", session);

  input.bridge.onClose((reason) => {
    log("bridge_closed", session, { reason });
    void terminateRuntimeSession(input.callId, `bridge closed: ${reason}`);
  });

  // Registered immediately, before either provider connection — not after,
  // like a naive implementation would. STT/TTS connect are two real network
  // round trips; a caller whose audio starts flowing while those are still
  // in flight must not lose it. Frames are buffered here (bounded by
  // MAX_PENDING_INBOUND_FRAMES) and flushed into STT the moment it connects.
  input.bridge.onInboundFrame((frame) => {
    if (!session.firstInboundFrameLogged) {
      session.firstInboundFrameLogged = true;
      log("first_inbound_audio_frame", session, { bytes: frame.data.length });
    }
    if (session.stt) {
      session.stt.sendAudioFrame(frame.data);
      return;
    }
    session.pendingInboundFrames.push(frame);
    if (session.pendingInboundFrames.length > MAX_PENDING_INBOUND_FRAMES) {
      session.pendingInboundFrames.shift();
    }
  });

  setState(session, "connecting");

  // Task 1 FIX (production incident: ~20.4s between runtime_started and
  // tts_connected, with stt_connected arriving only ~183ms after that):
  // this used to `await deps.connectTts(...)` and only THEN start
  // `deps.connectStt(...)` — a slow TTS handshake fully serialized in
  // front of STT even though the two connections are completely
  // independent network round trips. Connecting them concurrently (both
  // promises started before either is awaited) means a slow TTS provider
  // connection can no longer delay STT from coming up — the caller's
  // audio (already being buffered into pendingInboundFrames by the
  // onInboundFrame handler registered above, regardless of either
  // connection's state) reaches STT as soon as STT itself is ready,
  // independent of how long TTS takes. Each connection keeps its own
  // timedStep timing and its own independent error handling — a TTS
  // failure no longer prevents STT from having been attempted, and
  // vice versa.
  const outputCodec = outputCodecFor(input.bridge);
  const outputSampleRateHz = input.bridge.outboundFormat.sampleRateHz;
  session.declaredTtsOutputCodec = outputCodec;
  session.declaredTtsOutputSampleRateHz = outputSampleRateHz;
  const sttSampleRateHz = input.bridge.inboundFormat.sampleRateHz;
  const sttEncoding = input.bridge.inboundFormat.encoding === "mulaw" ? "mulaw" : "linear16";
  const connectionId = ++session.ttsConnectionIdSeq;

  const ttsConnectPromise = timedStep(session, "tts_connect", () =>
    deps.connectTts({
      voiceId: input.snapshotAgent.voice_id,
      language: input.snapshotAgent.primary_language,
      pace: input.snapshotAgent.speaking_pace,
      outputCodec,
      outputSampleRateHz,
      onEvent: (e) => onTtsEvent(session, e, connectionId),
    }),
  );
  const sttConnectPromise = timedStep(session, "stt_connect", () =>
    deps.connectStt({
      // Always auto-detect (Sarvam's "auto" language code — already
      // proven in production for multilingual agents) rather than pinning
      // recognition to the agent's single primary_language. Previously
      // gated behind the agent's own `multilingual` toggle, which meant a
      // caller speaking anything other than the configured primary
      // language on a non-multilingual agent was never even given a
      // chance to be recognized correctly in the first place — see
      // resolveResponseLanguage for how the LLM/TTS side falls back to
      // primary_language if STT detects something outside the common
      // supported set.
      //
      // BUGFIX (production incident): "unknown" is not a value Sarvam's
      // realtime STT recognizes — it rejected every connection with a
      // fatal 400 ("Unsupported language_code 'unknown'. Supported
      // values: auto, hi-IN, ...") and immediately closed the WebSocket
      // with code 4000, so STT never connected for any call using this
      // value. "auto" is Sarvam's actual documented auto-detect code.
      language: "auto",
      sampleRateHz: sttSampleRateHz,
      encoding: sttEncoding,
      onEvent: (e) => onSttEvent(session, e),
    }),
  );

  const [ttsOutcome, sttOutcome] = await Promise.allSettled([ttsConnectPromise, sttConnectPromise]);

  if (ttsOutcome.status === "fulfilled") {
    session.tts = ttsOutcome.value;
    session.activeTtsConnectionId = connectionId;
    session.ttsConnectedAt = Date.now();
    /**
     * Diagnostic (audio format tracing): the exact codec/sample rate this
     * session told the AI voice provider to synthesize into, derived
     * entirely from the bridge's own declared outboundFormat — never a
     * hardcoded assumption here. If the telephony leg's actual configured
     * sample rate on the provider's own dashboard doesn't match this
     * value, that mismatch is the first thing to check against a live
     * "audio never reaches the caller" report.
     */
    log("tts_connected", session, { outputCodec, outputSampleRateHz });
  } else {
    log("tts_connect_failed", session, { message: (ttsOutcome.reason as Error).message });
  }

  if (sttOutcome.status === "fulfilled") {
    session.stt = sttOutcome.value;
    /**
     * Diagnostic (audio format tracing): the exact format this session
     * told the AI voice provider inbound audio would arrive in, derived
     * entirely from the bridge's own declared inboundFormat — never a
     * hardcoded assumption here. Compare against the telephony provider's
     * own configured format if STT connects but never produces a
     * transcript for audio that is clearly being sent.
     */
    log("stt_connected", session, { sttSampleRateHz, sttEncoding });
    // Task 1: the caller's audio must never be silently lost while STT is
    // still connecting (it can take a while — see timedStep's own doc
    // comment on the ~20.4s production incident this responds to).
    // onInboundFrame above already buffers every frame into
    // pendingInboundFrames (bounded by MAX_PENDING_INBOUND_FRAMES) for
    // exactly this reason; this just makes that buffering's outcome
    // visible — how much was buffered, and that all of it (bounded) was
    // actually flushed into STT the moment it connected, not discarded.
    log("startup_step", session, {
      step: "initial_audio_buffering",
      bufferedFrameCount: session.pendingInboundFrames.length,
      bufferCapacity: MAX_PENDING_INBOUND_FRAMES,
      outcome: "flushed_to_stt",
    });
    // Flush whatever arrived on the bridge while STT was still connecting —
    // see the onInboundFrame registration above.
    for (const frame of session.pendingInboundFrames) session.stt.sendAudioFrame(frame.data);
    session.pendingInboundFrames = [];
  } else {
    log("stt_connect_failed", session, { message: (sttOutcome.reason as Error).message });
  }

  // The call cannot proceed without BOTH a way to speak and a way to
  // listen. Either connection failing independently is fatal to the
  // session — but (unlike the old serial code) the OTHER connection was
  // still attempted and, if it succeeded, is used here: a working TTS
  // session speaks an honest apology before the call ends if STT is what
  // failed; a working STT session is simply closed below if TTS is what
  // failed (there is nothing to speak the apology with).
  if (ttsOutcome.status === "rejected" || sttOutcome.status === "rejected") {
    if (sttOutcome.status === "rejected" && session.tts) {
      await speakFallback(session, sttOutcome.reason, "stt_connect_failed");
    }
    setState(session, "failed");
    await terminateRuntimeSession(
      input.callId,
      ttsOutcome.status === "rejected" ? "tts_connect_failed" : "stt_connect_failed",
    );
    return handle;
  }

  // Task 2: the initial greeting must be spoken exactly once per call.
  // This is the ONLY call site that ever speaks it — startRuntimeSession
  // itself is guarded against re-entry for an existing callId (the
  // activeSessions.get check at the very top of this function), so this
  // flag is defense in depth, not the sole protection: even a future code
  // path that somehow reached this point twice for the same session
  // object would still be blocked here.
  log("greeting_attempt", session, { generation: session.generation });
  if (session.initialGreetingSent) {
    log("greeting_skipped_duplicate", session, {
      generation: session.generation,
      utterance_id: session.currentUtteranceId,
    });
    return handle;
  }
  try {
    const greeting = pickGreeting(input.snapshotAgent, input.businessName);
    session.turns.push({ role: "assistant", text: greeting, at: new Date().toISOString() });
    await timedStep(session, "greeting_speak", () => speak(session, greeting, "greeting"));
    session.initialGreetingSent = true;
    setState(session, "listening");
    armSilenceTimer(session);
    log("greeting_sent", session, {
      generation: session.generation,
      utterance_id: session.currentUtteranceId,
    });
    log("greeting_played", session);
    void markAgentLive(input.agentConfigId);
  } catch (err) {
    // BUGFIX: previously this only set the visible state to ERROR and
    // returned, without ever calling terminateRuntimeSession — the session
    // stayed in activeSessions forever, the STT/TTS sockets stayed open,
    // and the transcript was never persisted. Every other failure path in
    // this function (TTS connect, STT connect) already terminates properly;
    // a greeting failure must too.
    log("greeting_failed", session, { message: (err as Error).message });
    setState(session, "failed");
    await terminateRuntimeSession(input.callId, "greeting_failed");
    return handle;
  }

  return handle;
}

/** Idempotent: a second call for an already-ending/ended session is a no-op. */
export async function terminateRuntimeSession(callId: string, reason: string): Promise<void> {
  const session = activeSessions.get(callId);
  if (!session) return;
  if (session.handle.state === "ending" || session.handle.state === "ended") return;

  // A session that failed to start/run (state === "failed") still needs the
  // full cleanup below, but its visible final state should stay "failed"
  // rather than being overwritten with a "normal" ending/ended — callers
  // (and logs) need to be able to tell "the call ended" from "the runtime
  // never worked" apart.
  const hadError = session.handle.state === "failed";
  if (!hadError) setState(session, "ending");
  log("runtime_terminating", session, { reason });

  session.generation++; // discard any in-flight LLM work
  clearSilenceTimer(session);
  clearPaymentWaitTimer(session);
  try {
    session.stt?.close();
  } catch {
    /* best-effort */
  }
  try {
    session.tts?.close();
  } catch {
    /* best-effort */
  }
  try {
    session.input.bridge.close();
  } catch {
    /* best-effort */
  }

  await persistTranscript(session);

  if (!hadError) setState(session, "ended");
  activeSessions.delete(callId);
  log("runtime_terminated", session, { reason });
}

export interface InjectPaymentEventResult {
  /** false means "this call has no active voice session" (already ended, or never started) — the ended-call fallback: expected, not an error. Payment/booking truth never depends on this. */
  handled: boolean;
}

/**
 * Speaks an already-composed payment-event message (confirmation,
 * failure, or expiration) into a still-active call, if one exists for
 * `callId` — the "Durable Object RPC -> voice runtime -> PAYMENT_CAPTURED
 * event -> AI/voice layer -> customer hears confirmation" leg of the
 * event architecture. Called from payment-voice-consumer.server.ts, never
 * directly from the Razorpay webhook (see that module's own doc comment
 * for the full dispatch chain).
 *
 * Composing the message text is deliberately NOT this function's job —
 * it takes a plain string, exactly like speakFallback/speakSilencePrompt
 * do for their own canned messages, so this file stays free of any
 * payment-domain knowledge (event types, amounts, currencies).
 *
 * If the call has already ended (handled: false), this is a no-op by
 * design — payment/booking state is already durably correct via the
 * webhook regardless, and the WhatsApp consumer (a separate, independent
 * DispatchConsumers slot) still delivers its own confirmation.
 */
export async function injectPaymentEvent(
  callId: string,
  message: string,
): Promise<InjectPaymentEventResult> {
  const session = activeSessions.get(callId);
  if (!session) return { handled: false };

  const state = stateOf(session);
  if (state === "ended" || state === "failed" || state === "ending") return { handled: false };

  // Soft-cancel any in-flight LLM turn and stop whatever audio is queued —
  // same mechanism barge-in uses (onSttEvent's speech_start case) — so the
  // payment message is heard promptly rather than queued behind it.
  session.generation++;
  clearSilenceTimer(session);
  clearPaymentWaitTimer(session);
  if (state === "greeting" || state === "speaking" || state === "thinking") {
    try {
      session.input.bridge.clearOutboundBuffer();
      session.tts?.flush();
    } catch {
      /* best-effort */
    }
  }

  log("payment_event_injected", session);
  session.turns.push({ role: "assistant", text: message, at: new Date().toISOString() });
  await speak(session, message);

  const finalState = stateOf(session);
  if (finalState !== "ended" && finalState !== "failed" && finalState !== "ending") {
    setState(session, "listening");
    armSilenceTimer(session);
  }
  return { handled: true };
}
