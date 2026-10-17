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
import type { HangupOutcome } from "./telephony/adapter.ts";
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
import { zonedWallTimeToUtc, dayOfWeekInTimezone } from "./calendar/timezone.ts";
import { normalizeCallerId, normalizePhoneNumber, phoneLastFour } from "./phone-number.ts";
import { classifyBookingStatus, type BookingOutcome } from "./calendar/booking-outcome.ts";
import {
  CLOSING_MESSAGES,
  agentAskedAnythingElse,
  agentSaidGoodbye,
  classifyCallerClosingIntent,
  closingMessageFor,
  isTransientHangupError,
  lifecyclePhaseFor,
  normalizeReplyForRepeat,
  resolveCallLifecyclePolicy,
  type CallLifecyclePhase,
  type CallLifecyclePolicy,
} from "./call-lifecycle-policy.ts";
import {
  findConfiguredService,
  resolveServiceFromText,
  spokenServiceList,
  type ServiceRow,
} from "./service-matching.ts";

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
  /** Collected alongside phone for the final booking confirmation (see attemptBooking's book_appointment call) — never required to check availability (see appointmentReadyForAvailabilityCheck). */
  email: string | null;
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
  /**
   * Where `phone` came from: "caller_id" (the caller agreed to use the
   * number they're calling from — see CallerIdChoice) or "caller_provided"
   * (spoken by the caller). Runtime-owned, never model-proposed. A
   * caller-approved caller-ID number can only be replaced by a valid number
   * the caller explicitly gives as a phone number (see mergeAppointmentState).
   */
  phoneSource: "caller_id" | "caller_provided" | null;
  /** Progress of the "may I use the number you're calling from?" question — see resolveCallerIdAnswer. Runtime-owned. */
  callerIdChoice: CallerIdChoice;
  /** Set when the caller gave something that could not be normalized to a valid phone number (or the booking layer rejected it as INVALID_PHONE) — drives a targeted "please repeat just your phone number" clarification instead of restarting collection. Runtime-owned. */
  phoneIssue: "invalid" | "country_code_required" | null;
}

/**
 * "unavailable": no usable caller ID (withheld, malformed, or not provided by
 * the telephony webhook) — the agent asks for a number normally.
 * "not_offered": caller ID is usable but the caller hasn't been asked yet.
 * "offered": the agent asked whether to use it; the next caller turn is read
 * as the answer. "clarifying": the answer was ambiguous and one short
 * clarification was asked. "accepted"/"declined": settled.
 */
export type CallerIdChoice =
  "unavailable" | "not_offered" | "offered" | "clarifying" | "accepted" | "declined";

/** The exact question asked when a usable caller ID is available and the caller's phone number is needed. */
export const CALLER_ID_QUESTION =
  "May I use the phone number you're calling from for your appointment, or would you prefer to provide a different number?";

export function emptyAppointmentState(): AppointmentState {
  return {
    service: null,
    customerName: null,
    phone: null,
    email: null,
    preferredDate: null,
    preferredTime: null,
    preferredPeriod: null,
    wantsNextAvailable: false,
    bookingStatus: "collecting",
    availabilityStatus: "unknown",
    selectedSlot: null,
    phoneSource: null,
    callerIdChoice: "unavailable",
    phoneIssue: null,
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
  /**
   * The inbound caller's number exactly as the telephony provider's signed
   * webhook reported it (Vobiz/Exotel `From`, via NormalizedCallEvent.
   * fromE164) — trusted call metadata, never anything transcribed from the
   * caller's speech. Optional: absent for outbound calls, older callers of
   * this function, and withheld numbers. Normalized/validated once at
   * session start (normalizeCallerId); never logged in full.
   */
  callerNumber?: string | null;
  /**
   * The business's country (businesses.country, read live at call start) —
   * how a phone number given WITHOUT a country code is interpreted (see
   * phone-number.ts). Unknown/absent means only international-format
   * numbers are accepted; national numbers are never guessed.
   */
  businessCountry?: string | null;
  /**
   * The business's active configured services, when the caller already has
   * them. Optional: when absent, the runtime loads them on first need (see
   * Session.cachedServices). Used to map how the caller describes a service
   * ("clean my teeth") onto one of these rows.
   */
  services?: ServiceRow[] | null;
  /**
   * Ends the PSTN call through the telephony provider's own hang-up API
   * (e.g. Vobiz's DELETE /Call/{call_uuid}/) — supplied by the provider's
   * Durable Object, never serialized. Used after a closing message has
   * fully played. Absent when the provider has no documented hang-up API;
   * closing the media bridge (terminateRuntimeSession) is then the only
   * way the runtime can end the call.
   */
  requestProviderHangup?: () => Promise<HangupOutcome | void>;
  /**
   * Overrides for the call lifecycle policy (silence timings, repeat/error
   * limits, closing and hang-up deadlines, maximum call length) — see
   * call-lifecycle-policy.ts. Unset fields keep the conservative defaults;
   * numeric values are clamped to safe minimums.
   */
  lifecyclePolicy?: Partial<CallLifecyclePolicy>;
  /** When telephony routing for this call began (ms since epoch) — logged against the greeting's first audio frame (greeting_first_audio). */
  routingStartedAt?: number;
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
  /** The caller's number from trusted call metadata, normalized to E.164 — null when unavailable/withheld/invalid. See StartRuntimeSessionInput.callerNumber. */
  callerId: string | null;
  /**
   * Estimated wall-clock time (ms) at which the telephony provider finishes
   * PLAYING the outbound audio already handed to the bridge — each frame
   * forwarded in onTtsEvent's "audio" case extends it by that frame's own
   * duration. A TTS "flushed" event only means Sarvam finished sending audio
   * to us, not that the caller has heard it; waitForFinalAudio uses this so
   * a closing message is not cut off by an immediate disconnect. Reset to 0
   * whenever the outbound buffer is cleared (barge-in).
   */
  outboundPlayoutEndsAt: number;
  /**
   * Where the call is in closing (see finishCall):
   * - "awaiting_anything_else": the agent asked whether there's anything
   *   else (after a booking, an answered enquiry, or its own goodbye) — a
   *   closing reply or continued silence ends the call cleanly.
   * - "ending": the final message is being delivered (CLOSING).
   * - "terminating": provider hang-up has been initiated (TERMINATING).
   */
  callCompletion: "none" | "awaiting_anything_else" | "ending" | "terminating";
  /** Resolved call lifecycle policy for this call (call-lifecycle-policy.ts). */
  policy: CallLifecyclePolicy;
  /** The agent's last reply already said goodbye — a silence-ending need not say it again. */
  farewellSpoken: boolean;
  /** Turns in a row that failed (LLM/TTS/unexpected error); reset by any successful turn. */
  consecutiveTurnErrors: number;
  /** The previous agent reply (normalised) and how many times in a row it has been said. */
  lastReplyNorm: string | null;
  repeatedReplyCount: number;
  /** The single provider hang-up attempt for this call (shared by every path that ends it). */
  providerHangup: Promise<void> | null;
  /** Set just before the runtime itself closes the media bridge, so its own close isn't mistaken for a dropped connection. */
  closingBridge: boolean;
  /** terminateRuntimeSession has started for this session — every later call is a no-op (also for a session that failed). */
  terminationStarted: boolean;
  /** The maximum-call-length timer (policy.maxCallDurationMs), if armed. */
  maxDurationTimer: ReturnType<typeof setTimeout> | null;
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
  /** When text was last handed to TTS, and when TTS audio last arrived — the evidence ttsAudioInFlight falls back on when no completion event arrives. */
  ttsLastSendAt: number;
  ttsLastAudioAt: number;
  /** Whether any TTS audio has arrived since the last text was sent. */
  ttsAudioSinceSend: boolean;
  /** Logged once when an utterance is judged finished without TTS's completion event. */
  ttsCompletionFallbackLogged: boolean;
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
  /**
   * The lightweight sibling of utteranceQueue — serializes ONLY the
   * immediate-ack speak() calls fired from enqueueUserUtterance's fast
   * phase, which deliberately runs OUTSIDE utteranceQueue (see that
   * function's own doc comment for why). Exists purely so two rapid-fire
   * immediate acks can't interleave their own speak() calls (speak() has
   * one await suspension point before its synchronous chunk-sending
   * loop) — it has nothing to do with, and never substitutes for,
   * utteranceQueue's booking/TTS-race protection over the SLOW phase.
   */
  immediateAckQueue: Promise<void>;
  /**
   * Cached the first time tryEarlyDeterministicDispatch needs the
   * business's configured services (matchServiceInText) — null until
   * fetched. The configured list doesn't change mid-call, so caching it
   * on the session avoids repeating that DB round trip on every turn
   * before the caller's service becomes known (previously as wasteful as
   * refetching the business timezone on every turn — see
   * resolveBookingContext's own "combine, don't repeat" discipline).
   */
  cachedServices: { id: string; name: string; duration_minutes: number | null }[] | null;
  /**
   * Service-question loop guard (Smile Dental incident: the same "Which
   * service would you like to book?" was asked on every turn). Counts the
   * consecutive turns the runtime has had to ask for the service; resets
   * once a service is known. See serviceClarification.
   */
  serviceQuestionCount: number;
  /** Configured services the caller's latest wording matched equally well — asked as "A or B?". */
  serviceCandidates: ServiceRow[] | null;
  /** A service the model heard that matches none of the configured services — explained as unavailable. */
  unmatchedServiceRequest: string | null;
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
/** Sarvam has reported every chunk sent so far as synthesized (its completion event) — says nothing about playback. */
function ttsSynthesisComplete(session: Session): boolean {
  return session.ttsChunksSent <= session.ttsChunksFlushed;
}

function ttsAudioInFlight(session: Session): boolean {
  const now = Date.now();
  // Audio already forwarded to the provider is still playing to the caller
  // (estimated from its duration). Sarvam's completion event only means
  // synthesis finished — never that the caller has heard it — so this is
  // checked first, whatever the event said.
  if (now < session.outboundPlayoutEndsAt) return true;
  if (session.ttsChunksSent <= session.ttsChunksFlushed) return false;
  // Sarvam's completion event (send_completion_event — see
  // sarvam-realtime.server.ts) is the authoritative "synthesis finished"
  // signal. When it doesn't arrive (production: the connection never asked
  // for it, so "audio still playing" stayed true for the rest of the call —
  // the silence timer never armed, and a booked caller who went quiet was
  // never hung up on), fall back on what was observed, bounded: audio still
  // arriving, or the first audio of just-sent text not here yet.
  const stillArriving = session.ttsAudioSinceSend
    ? now - session.ttsLastAudioAt < TTS_DELIVERY_IDLE_MS
    : now - session.ttsLastSendAt < TTS_FIRST_AUDIO_MAX_WAIT_MS;
  if (stillArriving) return true;
  if (!session.ttsCompletionFallbackLogged) {
    session.ttsCompletionFallbackLogged = true;
    log("tts_completion_inferred", session, {
      chunks_sent: session.ttsChunksSent,
      chunks_flushed: session.ttsChunksFlushed,
      audio_received: session.ttsAudioSinceSend,
    });
  }
  return false;
}

/** No TTS audio for this long after the last chunk, with its playout over: the utterance is done. */
const TTS_DELIVERY_IDLE_MS = 1_500;
/** Longest the first audio of just-sent text is waited for before it counts as not coming. */
const TTS_FIRST_AUDIO_MAX_WAIT_MS = 8_000;
/** How often a silence timer deferred by still-playing audio re-checks. */
const SILENCE_DEFER_RECHECK_MS = 500;

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
    // Re-checked shortly (cleared like the timer itself), so the window
    // still opens when TTS never sends its completion event.
    session.silenceTimer = setTimeout(() => armSilenceTimer(session), SILENCE_DEFER_RECHECK_MS);
    return;
  }
  // SILENCE_PROMPT_MS / SILENCE_HANGUP_MS are the policy defaults; a call's
  // own policy (StartRuntimeSessionInput.lifecyclePolicy) may adjust them.
  const delay = session.silencePromptSent
    ? session.policy.silenceHangupMs
    : session.policy.silencePromptMs;
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
    // After a confirmed booking the conversation is complete — continued
    // silence ends the call with a farewell instead of "are you still
    // there?" (which would re-open a finished conversation).
    if (session.callCompletion === "awaiting_anything_else") {
      void endConversationGracefully(session, armedGeneration, "post_booking_silence");
    } else if (session.silencePromptSent) void endDueToSilence(session);
    else void speakSilencePrompt(session);
  }, delay);
}

function clearPaymentWaitTimer(session: Session) {
  if (session.paymentWaitTimer) {
    clearTimeout(session.paymentWaitTimer);
    session.paymentWaitTimer = null;
  }
}

function clearMaxDurationTimer(session: Session) {
  if (session.maxDurationTimer) {
    clearTimeout(session.maxDurationTimer);
    session.maxDurationTimer = null;
  }
}

/** A timer that never keeps the process alive on its own (Node); a no-op on Workers. */
function unrefTimer(timer: ReturnType<typeof setTimeout>) {
  (timer as { unref?: () => void }).unref?.();
}

/** Re-check interval while a maximum-length close waits for an in-flight turn to finish. */
const MAX_DURATION_RECHECK_MS = 2_000;

/**
 * Closes the call politely once policy.maxCallDurationMs has elapsed —
 * never in the middle of a legitimate operation: while the agent is
 * thinking, running a tool or speaking, it re-checks until the call is
 * waiting on the caller again, and only after
 * policy.maxCallDurationGraceMs closes regardless (discarding the
 * in-flight turn). 0 disables the limit.
 */
function armMaxDurationTimer(session: Session) {
  clearMaxDurationTimer(session);
  const limit = session.policy.maxCallDurationMs;
  if (limit <= 0) return;
  const forceAt = session.startedAt + limit + session.policy.maxCallDurationGraceMs;
  const check = () => {
    session.maxDurationTimer = null;
    const state = stateOf(session);
    if (state === "ending" || state === "ended" || state === "failed") return;
    const idle = isAwaitingCaller(state) && !ttsAudioInFlight(session);
    if (!idle && Date.now() < forceAt) {
      session.maxDurationTimer = setTimeout(check, MAX_DURATION_RECHECK_MS);
      unrefTimer(session.maxDurationTimer);
      return;
    }
    if (!idle) {
      log("max_call_duration_forced", session);
      session.generation++; // discard the in-flight turn
      session.input.bridge.clearOutboundBuffer();
    }
    void finishCall(session, {
      reason: "max_call_duration",
      message: CLOSING_MESSAGES.maxDuration(session.input.businessName),
    });
  };
  session.maxDurationTimer = setTimeout(check, limit);
  unrefTimer(session.maxDurationTimer);
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
  // Spoken, then provider hang-up once its audio has played, then the
  // session terminates as "caller_silence_timeout" — see finishCall.
  await finishCall(session, {
    reason: "caller_silence_timeout",
    message: CLOSING_MESSAGES.silence,
    generation: session.generation,
  });
}

/**
 * Asks the telephony provider to end the PSTN call (see
 * StartRuntimeSessionInput.requestProviderHangup) — after the closing
 * message has finished playing, or when the media connection disappeared
 * while the call may still be up. Shared per call: every path that ends the
 * call awaits the same attempt, so the provider is asked at most once
 * (plus policy.providerHangupRetries retries of a transient failure). Never
 * throws: a failure is logged and the caller of this function still
 * terminates the session, which closes the media bridge as the fallback.
 */
function requestProviderHangup(session: Session, reason: string): Promise<void> {
  if (session.providerHangup) {
    log("provider_hangup_already_requested", session, { reason });
    return session.providerHangup;
  }
  session.providerHangup = (async () => {
    const hangup = session.input.requestProviderHangup;
    if (!hangup) {
      log("provider_hangup_unavailable", session, { reason });
      return;
    }
    const attempts = 1 + session.policy.providerHangupRetries;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const outcome = await withToolDeadline(session.policy.providerHangupTimeoutMs, hangup());
        log("provider_hangup_requested", session, {
          reason,
          attempt,
          outcome: outcome ?? "unknown",
        });
        if (outcome === "call_not_found") {
          // The provider has no live call with this id. That is only proof
          // the call is over if the provider's own call-ended webhook says
          // so; otherwise it may be a wrong id and the call may still be up.
          log("provider_hangup_call_not_found", session, {
            reason,
            provider_reported_end: providerReportedCallEnded(session.input.callId),
          });
        }
        return;
      } catch (err) {
        const transient = isTransientHangupError(err);
        log("provider_hangup_failed", session, {
          reason,
          attempt,
          transient,
          status: (err as { status?: unknown }).status ?? null,
          message: (err as Error).message,
        });
        if (!transient) return;
      }
    }
  })();
  return session.providerHangup;
}

/** Asked after every confirmed booking — see Session.callCompletion. */
const ANYTHING_ELSE_QUESTION = "Is there anything else I can help you with?";

/** Extra margin after the estimated playout end, for provider-side jitter buffering. */
const FINAL_AUDIO_PLAYOUT_GRACE_MS = 400;
const FINAL_AUDIO_POLL_MS = 100;

/**
 * Resolves once the last thing spoken has actually finished playing to the
 * caller: Sarvam has delivered every chunk (no TTS audio in flight) AND the
 * estimated provider-side playout of every frame already forwarded has
 * elapsed (Session.outboundPlayoutEndsAt), plus a small grace. Bounded by
 * policy.closingAudioMaxWaitMs (a TTS stream that never reports "flushed",
 * or a wrong playout estimate, never keeps a finished call alive); returns
 * immediately if the session is already ending (the caller hung up first).
 */
async function waitForFinalAudio(session: Session): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const state = stateOf(session);
    if (state === "ending" || state === "ended" || state === "failed") return;
    const now = Date.now();
    if (
      !ttsAudioInFlight(session) &&
      now >= session.outboundPlayoutEndsAt + FINAL_AUDIO_PLAYOUT_GRACE_MS
    ) {
      log("final_audio_finished", session, { waited_ms: now - startedAt });
      return;
    }
    if (now - startedAt >= session.policy.closingAudioMaxWaitMs) {
      log("final_audio_wait_timed_out", session, {
        waited_ms: now - startedAt,
        tts_audio_in_flight: ttsAudioInFlight(session),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, FINAL_AUDIO_POLL_MS));
  }
}

/** Logs the call's lifecycle phase (call-lifecycle-policy.ts) at each closing transition. */
function logLifecycle(session: Session, phase: CallLifecyclePhase, reason: string) {
  log("call_lifecycle", session, { phase, reason });
}

/** The log-facing lifecycle phase for this session right now. */
function lifecyclePhaseOf(session: Session): CallLifecyclePhase {
  return lifecyclePhaseFor(session.handle.state, {
    closing: session.callCompletion === "ending",
    terminating: session.callCompletion === "terminating",
    audioPlaying: ttsAudioInFlight(session),
  });
}

/**
 * The one way a call is ended by the runtime (every outcome: completed
 * conversation, caller's request, silence, repeated errors or questions,
 * maximum length). In order:
 *
 * 1. CLOSING — stop timers; nothing else may start closing this call.
 * 2. Speak `message` (if any) and wait for its audio to actually finish
 *    (waitForFinalAudio: TTS delivery + estimated playout, bounded by
 *    policy.closingAudioMaxWaitMs). A TTS failure never blocks the hang-up.
 * 3. If the caller spoke over it (generation moved on), cancel: their turn
 *    is handled normally and the call stays in "anything else" mode, so
 *    silence still ends it.
 * 4. If the caller already hung up (the session is ending), stop — no
 *    hang-up request for a call that is already over.
 * 5. TERMINATING — one provider hang-up (shared, bounded retry), then
 *    terminateRuntimeSession (transcript persisted, bridge closed).
 *
 * Idempotent: a second call while one is in progress is a no-op.
 */
async function finishCall(
  session: Session,
  opts: { reason: string; message: string | null; generation?: number },
): Promise<void> {
  if (session.callCompletion === "ending" || session.callCompletion === "terminating") return;
  const state = stateOf(session);
  if (state === "ending" || state === "ended" || state === "failed") return;
  session.callCompletion = "ending";
  clearSilenceTimer(session);
  clearPaymentWaitTimer(session);
  clearMaxDurationTimer(session);
  logLifecycle(session, "CLOSING", opts.reason);
  log("conversation_closing", session, { reason: opts.reason });
  if (opts.message) {
    session.turns.push({ role: "assistant", text: opts.message, at: new Date().toISOString() });
    try {
      await speak(session, opts.message);
    } catch (err) {
      log("farewell_failed", session, { reason: opts.reason, message: (err as Error).message });
    }
  }
  await waitForFinalAudio(session);
  if (opts.generation !== undefined && session.generation !== opts.generation) {
    log("conversation_close_cancelled_by_caller", session, { reason: opts.reason });
    session.callCompletion = "awaiting_anything_else";
    return;
  }
  const after = stateOf(session);
  if (after === "ending" || after === "ended" || after === "failed") {
    log("conversation_close_caller_already_gone", session, { reason: opts.reason });
    return;
  }
  session.callCompletion = "terminating";
  logLifecycle(session, "TERMINATING", opts.reason);
  await requestProviderHangup(session, opts.reason);
  await terminateRuntimeSession(session.input.callId, opts.reason);
}

/**
 * Ends a completed conversation with a short farewell (skipped when the
 * agent's own last reply already said goodbye). If the caller starts
 * speaking over it, the hang-up is cancelled and their turn is handled
 * normally — see finishCall.
 */
async function endConversationGracefully(
  session: Session,
  generation: number,
  reason: string,
  message: string = CLOSING_MESSAGES.farewell(session.input.businessName),
): Promise<void> {
  await finishCall(session, {
    reason,
    message: session.farewellSpoken ? null : message,
    generation,
  });
}

/** Spoken when a turn ran a tool but produced no reply text at all. */
const TOOL_TURN_FALLBACK =
  "I'm sorry, I couldn't finish that just now. Could you please say that again?";

/** The deterministic sentence for a book_appointment outcome on the native tool-calling path. */
function toolBookingOutcomeSentence(outcome: BookingOutcome): string {
  switch (outcome) {
    case "confirmed":
      return `Your appointment is confirmed. ${ANYTHING_ELSE_QUESTION}`;
    case "saved_calendar_sync_failed":
      return `Your appointment request is saved, and our team will confirm it with you shortly. ${ANYTHING_ELSE_QUESTION}`;
    case "pending":
      return "I've passed on your request, but it isn't confirmed yet. Our team will confirm it with you shortly.";
    default:
      return "I'm sorry, I wasn't able to complete that booking. Someone will follow up to confirm.";
  }
}

/** A reply that tells the caller the appointment is done ("booked", "confirmed", "all set") — and not a negated form like "isn't confirmed yet". */
function claimsBookingSuccess(reply: string): boolean {
  return (
    /\b(booked|confirmed|all set|scheduled)\b/i.test(reply) &&
    !/\b(not|isn't|wasn't|unable|couldn't|can't|cannot)\b/i.test(reply)
  );
}

/** Any appointment detail is known — the call is in a booking conversation. */
function appointmentInProgress(s: AppointmentState): boolean {
  return Boolean(s.service || s.customerName || s.preferredDate || s.phone);
}

/**
 * Deterministic, targeted follow-ups (English replies only) for the cases
 * where the model's own reply would otherwise restart collection, re-ask
 * details already given, or — worst — claim a booking that never happened:
 *
 * - the caller asked to book (ready_to_book) but a required detail is still
 *   missing: ask for exactly that one detail (nextMissingDetailQuestion);
 * - the number the caller just gave can't be used: ask only for the number;
 * - the answer to CALLER_ID_QUESTION was ambiguous: one short clarification;
 * - the caller wants a different number but hasn't said it yet: ask for it.
 *
 * Otherwise the model's reply is returned unchanged.
 */
function applyTargetedClarification(
  session: Session,
  reply: string,
  callerIntent: CallerIntentSignals,
  callerIdAnswer: ReturnType<typeof resolveCallerIdAnswer>,
): string {
  const state = session.appointmentState;
  let reason: string | null = null;
  let question: string | null = null;
  if (state.bookingStatus === "ready_to_book" && !appointmentStateIsComplete(state)) {
    if (!state.service) {
      const ask = serviceClarification(session);
      if (ask.question === null) {
        // Already asked as far as is useful — let the model's own reply
        // stand rather than repeating the same question again.
        log("targeted_clarification_skipped", session, { reason: ask.reason });
        return reply;
      }
      question = ask.question;
      reason = ask.reason;
    } else {
      question = nextMissingDetailQuestion(state);
      reason = "booking_missing_detail";
    }
  } else if (
    !state.phone &&
    state.phoneIssue !== null &&
    (callerIntent.phone || callerIdAnswer?.phoneIssue)
  ) {
    question = phoneIssueQuestion(state.phoneIssue);
    reason =
      state.phoneIssue === "country_code_required" ? "phone_needs_country_code" : "invalid_phone";
  } else if (callerIdAnswer?.callerIdChoice === "clarifying") {
    question = "Just to confirm, shall I use the number you're calling from?";
    reason = "caller_id_answer_ambiguous";
  } else if (
    callerIdAnswer?.callerIdChoice === "declined" &&
    !callerIdAnswer.phone &&
    !callerIdAnswer.phoneIssue
  ) {
    question = "Of course. What number would you like me to use?";
    reason = "caller_id_declined";
  }
  if (!question) return reply;
  log("targeted_clarification", session, { reason });
  return question;
}

/**
 * The model's proposed service, mapped onto the business's configured
 * services. A label that matches a configured row is replaced by that
 * row's exact name, so booking resolves the real service id. A label that
 * matches none of them is never stored as the service (the business doesn't
 * offer it); it is remembered so the next clarification can say so. When no
 * catalog is loaded, the proposal is kept as before.
 */
function canonicalizeProposedService(
  session: Session,
  proposed: Partial<AppointmentState> | null,
): Partial<AppointmentState> | null {
  if (!proposed?.service) return proposed;
  const services = session.cachedServices ?? [];
  if (!services.length) return proposed;
  const row = findConfiguredService(services, proposed.service);
  if (row) return { ...proposed, service: row.name.trim() };
  if (!session.appointmentState.service) session.unmatchedServiceRequest = proposed.service;
  const rest = { ...proposed };
  delete rest.service;
  return rest;
}

/**
 * Log-safe summary of this turn's state marker (Smile Dental incident: the
 * logs couldn't show whether the model's marker was missing, malformed, or
 * simply left the service null while the caller was asked for it again and
 * again). Fixed enum values only — never the reply text, the caller's
 * words, or the service name itself.
 *
 * - marker: "absent" (no marker), "unparseable" (marker present, JSON
 *   invalid or truncated) or "parsed".
 * - service: "none" (the marker named no service), "accepted" (kept —
 *   matched a configured service, or no catalog to check against) or
 *   "unmatched" (named something the business doesn't offer).
 */
export function apptStateMarkerDiagnostic(
  rawReply: string,
  markerState: Partial<AppointmentState> | null,
  canonicalState: Partial<AppointmentState> | null,
): {
  marker: "absent" | "unparseable" | "parsed";
  service: "none" | "accepted" | "unmatched";
} {
  const marker = markerState
    ? "parsed"
    : rawReply.includes(APPT_STATE_MARKER)
      ? "unparseable"
      : "absent";
  const service = !markerState?.service
    ? "none"
    : canonicalState?.service
      ? "accepted"
      : "unmatched";
  return { marker, service };
}

/**
 * What to say when a booking can't proceed because the service is still
 * unknown — escalating, never the same question forever:
 *
 * 1. The caller's words fit two or more configured services equally:
 *    "Did you mean A or B?"
 * 2. The model heard a service that matches nothing configured: say it
 *    isn't offered and list what is.
 * 3. First plain ask: "Which service would you like to book?"
 * 4. Second ask: list the configured services to choose from.
 * 5. After that: stop asking, offer a callback from the team, and let the
 *    conversation continue (question null from then on).
 */
function serviceClarification(session: Session): { question: string | null; reason: string } {
  const services = session.cachedServices ?? [];
  const candidates = session.serviceCandidates;
  const unmatched = session.unmatchedServiceRequest;
  session.serviceCandidates = null;
  session.unmatchedServiceRequest = null;
  session.serviceQuestionCount++;
  const attempt = session.serviceQuestionCount;

  if (attempt > 3) return { question: null, reason: "service_unresolved_stop_asking" };
  if (attempt === 3) {
    return {
      question:
        "I'm sorry, I couldn't match that to one of our services. I'll ask the team to call you back to arrange it. Is there anything else I can help with?",
      reason: "service_unresolved_callback",
    };
  }
  if (candidates && candidates.length > 1) {
    return {
      question: `Did you mean ${spokenServiceList(candidates, "or")}?`,
      reason: "service_ambiguous",
    };
  }
  if (unmatched && services.length) {
    return {
      question: `I'm sorry, we don't offer ${unmatched}. We offer ${spokenServiceList(services, "and")}. Which would you like?`,
      reason: "service_not_offered",
    };
  }
  if (attempt === 2 && services.length) {
    return {
      question: `We offer ${spokenServiceList(services, "and")}. Which one would you like to book?`,
      reason: "service_list_offered",
    };
  }
  return { question: "Which service would you like to book?", reason: "booking_missing_detail" };
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
    // Production call dfcf72ca: the model wrote `"customer_name": ""`, which
    // replaced the name the caller had given — the runtime then asked for
    // it again after the caller confirmed. A blank value is "not stated",
    // never a value.
    const text = (key: string): string | null => {
      const value = parsed[key];
      return typeof value === "string" && value.trim() ? value.trim() : null;
    };
    const service = text("service");
    if (service) state.service = service;
    const customerName = text("customer_name");
    if (customerName) state.customerName = customerName;
    const phone = text("phone");
    if (phone) state.phone = phone;
    const email = text("email");
    if (email) state.email = email;
    const preferredDate = text("preferred_date");
    if (preferredDate) state.preferredDate = preferredDate;
    const preferredTime = text("preferred_time");
    if (preferredTime) state.preferredTime = preferredTime;
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

/**
 * Merges a turn's proposed appointment-state fields into the session's
 * persistent state — only fields the model actually provided this turn are
 * overwritten; everything else (including a field the current turn didn't
 * mention) is left exactly as it was.
 *
 * `extracted` is the deterministic backstop over the caller's own raw words
 * (parseCallerIntentFromText — see handleUserUtterance). Two different
 * priority rules apply, by field:
 *
 * - preferredDate/preferredTime: the marker wins when it proposes a value
 *   THIS turn; extraction only FILLS IN what the marker left unset (same
 *   backstop discipline as every other caller-intent backstop in this
 *   file — production incident: the model's marker is not reliably
 *   followed, so an explicit "tomorrow at 3 PM"/"Friday at 4:30" the
 *   caller actually said must never be left out just because the marker
 *   omitted it).
 * - phone/email: the OPPOSITE priority from date/time — this turn's own
 *   extraction wins first, then STICKY CURRENT, and the marker is only
 *   ever consulted as a last resort to fill the gap before any extraction
 *   has happened at all. Unlike a date/time, these are long, precise
 *   strings the model has to COPY correctly into its own JSON on EVERY
 *   turn (it re-emits the whole known state each reply) rather than just
 *   understand once — production incident: a caller's phone number was
 *   collected correctly by STT but came back shortened ("7-9-0 0" instead
 *   of the digits actually given) once the model had to recall/re-type it
 *   on a LATER turn that never actually restated it. Letting that later
 *   turn's marker value win over the already-correct sticky-current value
 *   (the way date/time's marker-wins rule does) is exactly how that
 *   happened — so here, once a value is known, only a fresh same-turn
 *   extraction may move it; the marker can never silently degrade it.
 *
 * Either way, when extraction finds nothing this turn, the previously
 * established value is never overwritten by this turn's incomplete/null
 * marker value.
 *
 * `extracted.service` (matchServiceInText's result) uses the SAME
 * marker-wins-fills-gap priority as preferredDate/preferredTime, not
 * phone/email's sticky priority — like a date/time, a service name is
 * something the model is generally reliable about once it hears it, and
 * this field only exists to catch the one turn where the caller just
 * named it and no marker has proposed it yet (see
 * tryEarlyDeterministicDispatch).
 */
export function mergeAppointmentState(
  current: AppointmentState,
  proposed: Partial<AppointmentState> | null,
  extracted?: {
    preferredDate?: string | null;
    preferredTime?: string | null;
    phone?: string | null;
    /** The caller's turn explicitly talked about a phone/mobile/contact number (PHONE_CONTEXT_PATTERN) — required before a digit run may replace a caller-approved caller-ID number. */
    phoneMentioned?: boolean;
    /** The business's country, for interpreting a number given without a country code — see StartRuntimeSessionInput.businessCountry. */
    phoneCountry?: string | null;
    email?: string | null;
    service?: string | null;
  },
): AppointmentState {
  const hasExtracted = Boolean(
    extracted?.preferredDate ||
    extracted?.preferredTime ||
    extracted?.phone ||
    extracted?.email ||
    extracted?.service,
  );
  if (!proposed && !hasExtracted) return current;
  const proposedSafe = proposed ?? {};
  const preferredDate =
    proposedSafe.preferredDate ?? extracted?.preferredDate ?? current.preferredDate;
  // preferredTime and preferredPeriod are each independently sticky (a
  // given value persists until the caller gives a new one) — see
  // attemptAvailabilityCheck/attemptBooking for why an exact preferredTime
  // always takes priority over preferredPeriod when, unusually, both end
  // up set at once, rather than this merge trying to clear one in favor of
  // the other.
  const preferredTime =
    proposedSafe.preferredTime ?? extracted?.preferredTime ?? current.preferredTime;
  const preferredPeriod = proposedSafe.preferredPeriod ?? current.preferredPeriod;
  // The requested slot itself changed this turn (a new date/time/period, or
  // a correction to one already given) — any availabilityStatus/selectedSlot
  // carried over from a PREVIOUS check now describes a slot the caller is
  // no longer asking about, so it must not keep being treated as current
  // (e.g. silently booking the OLD time as "already confirmed available").
  const slotChanged =
    preferredDate !== current.preferredDate ||
    preferredTime !== current.preferredTime ||
    preferredPeriod !== current.preferredPeriod;
  // Phone: only ever stored as E.164 (contacts.phone's own CHECK constraint
  // — see phone-number.ts; a raw "9876543210" here is exactly what made
  // every voice booking fail at the contact upsert). Same priority as
  // before (this turn's extraction, then sticky current, then the marker
  // only to fill a gap), plus three guards: an extraction that can't be
  // normalized never overwrites anything and instead flags a targeted
  // re-ask (phoneIssue) when no number is known yet; an empty/invalid
  // marker value never overwrites anything; and a number the caller
  // approved from caller ID is only replaced when this turn explicitly
  // talks about a phone number (a stray digit run elsewhere in speech is
  // not a correction).
  const phoneCountry = extracted?.phoneCountry ?? null;
  const extractedResult = extracted?.phone
    ? normalizePhoneNumber(extracted.phone, phoneCountry)
    : null;
  const extractedPhone = extractedResult?.ok ? extractedResult.e164 : null;
  const markerResult = normalizePhoneNumber(proposedSafe.phone, phoneCountry);
  const markerPhone = markerResult.ok ? markerResult.e164 : null;
  const callerApprovedLocked =
    current.phoneSource === "caller_id" && current.phone !== null && !extracted?.phoneMentioned;
  let phone = current.phone;
  let phoneSource = current.phoneSource;
  let phoneIssue = current.phoneIssue;
  if (extractedPhone && !callerApprovedLocked) {
    if (extractedPhone !== current.phone) phoneSource = "caller_provided";
    phone = extractedPhone;
    phoneIssue = null;
  } else if (!current.phone && extractedResult && !extractedResult.ok) {
    phoneIssue = extractedResult.reason;
  } else if (!current.phone && markerPhone) {
    phone = markerPhone;
    phoneSource = "caller_provided";
    phoneIssue = null;
  }
  return {
    service: proposedSafe.service ?? extracted?.service ?? current.service,
    customerName: proposedSafe.customerName ?? current.customerName,
    // Sticky-current outranks the marker here (the OPPOSITE of
    // service/customerName/date/time just above, which let a fresh marker
    // value always win) — production incident: once a phone/email is
    // correctly known (via this turn's own extraction, or an earlier
    // turn's), a LATER turn's marker is the model re-typing its own
    // recollection of the whole state from the conversation history, which
    // degrading it on a turn that didn't actually restate the number is
    // exactly how "7-9-0 6-9-0 3-0" became "7-9-0 0" days into the same
    // call. Only this exact turn's raw extraction is allowed to move it —
    // the marker only ever fills the gap on the very first turn before any
    // extraction has happened yet.
    phone,
    email: extracted?.email ?? current.email ?? proposedSafe.email ?? null,
    preferredDate,
    preferredTime,
    preferredPeriod,
    // Deliberately NOT sticky, same reasoning as bookingStatus below: "the
    // caller wants the next/earliest open slot" is a proposal for THIS
    // turn's attempt, not a durable fact — carrying it forward would risk
    // silently resolving a LATER, unrelated booking request (with its own
    // explicit time) as "next available" instead.
    wantsNextAvailable: proposedSafe.wantsNextAvailable === true,
    // bookingStatus is deliberately NOT sticky across turns the way the
    // other fields are: "ready_to_book"/"checking_availability" are only a
    // proposal for THIS turn's attempt (handleUserUtterance resolves it
    // immediately — to "booked"/"unavailable" for a booking attempt, or
    // back to "collecting"/"unavailable" for an availability check) —
    // carrying either forward would re-trigger a tool call on a later,
    // unrelated turn.
    bookingStatus: proposedSafe.bookingStatus ?? "collecting",
    availabilityStatus: slotChanged ? "unknown" : current.availabilityStatus,
    selectedSlot: slotChanged ? null : current.selectedSlot,
    phoneSource,
    callerIdChoice: current.callerIdChoice,
    phoneIssue,
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

/**
 * Required to trigger a REAL availability check — deliberately narrower
 * than appointmentStateIsComplete (booking): phone/email are NOT required
 * here (production incident: a real call collected service, name, date,
 * and time, then asked for phone/email before ever checking the calendar
 * — the caller supplied phone/email and the agent merely said "I'm
 * checking availability now" with no real tool call behind it, because
 * nothing in the architecture dispatched on phone/email arriving, and
 * nothing had dispatched earlier either since completeness was defined
 * including phone). See handleUserUtterance's completion-transition
 * backstop, which dispatches the instant this becomes true — independent
 * of the model's own marker, an explicit "yes", or an explicit "is it
 * available?" question.
 */
export function appointmentReadyForAvailabilityCheck(s: AppointmentState): boolean {
  return Boolean(
    s.service && s.customerName && s.preferredDate && (s.preferredTime || s.wantsNextAvailable),
  );
}

/** Required to check availability — unlike a booking attempt, the caller's name/phone are not needed merely to ask "is this slot free" or "what's available". A specific time is NOT required either — an open "any slots today"/"this afternoon" query is checked and listed by attemptAvailabilityCheck just as validly as an exact-time check. */
function appointmentSlotIsKnown(s: AppointmentState): boolean {
  return Boolean(s.preferredDate);
}

/** Renders the runtime-owned appointment state into a system message the LLM can read as ground truth, instead of relying on it re-deriving the same facts from (possibly truncated) conversation history. Returns null when nothing is known yet, so a fresh call's messages array isn't padded with an all-null block. */
function describeKnownAppointmentState(
  s: AppointmentState,
  callerIdLastFour: string | null = null,
): string | null {
  const known: string[] = [];
  if (s.service) known.push(`service: ${s.service}`);
  if (s.customerName) known.push(`customer name: ${s.customerName}`);
  if (s.phone && s.phoneSource === "caller_id") {
    known.push(
      `phone: confirmed — the caller agreed to use the number they're calling from (ending in ${phoneLastFour(s.phone)}). Never ask for a phone number again.`,
    );
  } else if (s.phone) {
    known.push(`phone: ${s.phone}`);
  }
  if (s.email) known.push(`email: ${s.email}`);
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
  const phoneGuidance = describePhoneGuidance(s, callerIdLastFour);
  if (!known.length && !phoneGuidance) return null;
  const sections: string[] = [];
  if (known.length) {
    sections.push(
      `CURRENT APPOINTMENT STATE (already confirmed by the caller — do not ask for these again):\n${known.join("\n")}`,
    );
  }
  if (phoneGuidance) sections.push(`PHONE NUMBER: ${phoneGuidance}`);
  return sections.join("\n\n");
}

/** How the agent should obtain the caller's phone number, given what's already settled — null once a number is known (nothing to guide). See CallerIdChoice. */
function describePhoneGuidance(
  s: AppointmentState,
  callerIdLastFour: string | null,
): string | null {
  if (s.phone) return null;
  if (s.phoneIssue === "invalid") {
    return "the number the caller gave could not be understood as a complete, valid phone number. Ask ONLY for their phone number again (digit by digit) — do not re-ask any other detail.";
  }
  if (s.phoneIssue === "country_code_required") {
    return "the caller gave a number without a country code, and this business's country doesn't say how to read it. Ask ONLY for their phone number again, including the country code — do not re-ask any other detail.";
  }
  switch (s.callerIdChoice) {
    case "not_offered":
      return callerIdLastFour
        ? `not collected yet. The caller's own number is available from caller ID (ending in ${callerIdLastFour}). When you need their phone number, ask exactly: "${CALLER_ID_QUESTION}" Never ask them to say a number unless they choose a different one.`
        : null;
    case "offered":
      return `you asked whether to use the number they're calling from — wait for their answer.`;
    case "clarifying":
      return `the caller's answer about using the number they're calling from was unclear. Ask once, briefly: "Just to confirm, shall I use the number you're calling from?"`;
    case "declined":
      return "the caller wants to use a different number — ask them for it.";
    default:
      return null;
  }
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
  /** A weekday the caller named ("Friday", "next Monday"), if any — resolved to an actual date by the caller (via resolveWeekdayInTimezone), never here, same reasoning as relativeDate. Mutually exclusive with relativeDate in practice (handleUserUtterance prefers relativeDate when, unusually, both appear). */
  weekday: { weekday: number; forceNextWeek: boolean } | null;
  /** An explicit clock time the caller gave ("3 PM", "4:30"), as 24-hour "HH:mm" — see extractExplicitTime's own doc comment for the am/pm-inference rule when no meridiem was said. Null when no digits shaped like a time appear at all. */
  explicitTime: string | null;
  /** The caller affirmatively confirmed a booking ("yes", "please confirm", "that works", "go ahead", "book it") — only meaningful where the runtime already knows a specific slot is being discussed (see handleUserUtterance's own gating). */
  bookingConfirmed: boolean;
  /** The caller asked for a reminder/alert — a capability this codebase does not implement (see REMINDERS_NOT_IMPLEMENTED_NOTICE). */
  reminderRequested: boolean;
  /** A phone number the caller just spoke, as the raw digit string — see extractPhoneNumber's own doc comment for why this is extracted independently of the marker rather than trusting the model to copy/recall it correctly. Null when no digit run long enough to plausibly be a phone number appears. */
  phone: string | null;
  /** The caller explicitly talked about a phone/mobile/contact number this turn ("my number is…", "use this number instead") — see mergeAppointmentState's caller-ID guard. */
  phoneMentioned: boolean;
  /** An email address the caller just spoke, normalized to lowercase "local@domain.tld" — handles both a symbolic email and the common spoken form STT sometimes transcribes verbatim ("dhanush56 at gmail dot com"). Null when neither shape appears. */
  email: string | null;
}

const AVAILABILITY_KEYWORDS =
  /\b(available|availability|availabl[ey]|slots?|openings?|free|anything open|any time|what time)\b/i;
const AVAILABILITY_QUESTION_SHAPE =
  /\b(any|anything|do you have|what('s| is)|is there|are there|what times?)\b/i;
const NEXT_AVAILABLE_PATTERN =
  /\b(next available|earliest|soonest|first available|as soon as possible|asap)\b/i;
// Production incident: "General checkup, and let me know if that slot is
// free or not." never set availabilityRequested at all — it matches
// AVAILABILITY_KEYWORDS (via "free") but has no "?" and doesn't match
// AVAILABILITY_QUESTION_SHAPE's question-word list, since it's phrased as
// an imperative request rather than a question. Deliberately requires BOTH
// an imperative verb AND an "if/whether" clause before the availability
// word, so a plain statement like "I'd like to book a teeth cleaning" (no
// conditional at all) still never matches.
const AVAILABILITY_IMPERATIVE_PATTERN =
  /\b(let me know|check|see|find out|tell me)\b[\s\S]*?\b(if|whether)\b[\s\S]*?\b(free|available|open)\b/i;
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

// Weekday extraction, e.g. "Friday at 4:30", "next Monday morning" — see
// resolveWeekdayInTimezone for how the (weekday, forceNextWeek) pair below
// resolves to an actual date. 0=Sunday..6=Saturday, matching
// business_hours.day_of_week and calendar/timezone.ts's dayOfWeekInTimezone.
const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const WEEKDAY_PATTERN = new RegExp(`\\b(next\\s+)?(${WEEKDAY_NAMES.join("|")})\\b`, "i");

// Explicit clock time, e.g. "3 PM", "3:30pm", "4:30", "15:00" — see
// extractExplicitTime's own doc comment for the full extraction/am-pm-
// inference rule. Checked in order: a meridiem-qualified time is
// unambiguous and tried first; a bare "H:MM"/"HH:MM" is only treated as a
// time at all because it has the ":MM" shape (never a lone number).
const TIME_WITH_MERIDIEM_PATTERN = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i;
const TIME_24H_OR_BARE_COLON_PATTERN = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

/**
 * Extracts an explicit clock time from the caller's own words, normalized
 * to 24-hour "HH:mm" — matching AppointmentState.preferredTime's own
 * documented storage format (see formatSlotTime24h). Deliberately requires
 * either an am/pm suffix or a ":mm" minutes part before treating any digits
 * as a time at all, so a bare number ("I have 3 kids") is never mistaken
 * for one.
 *
 * When no am/pm is given and the hour alone is ambiguous (1-6), this
 * assumes PM — the common convention for a business's working hours (an
 * afternoon/evening appointment is far more often meant by "4:30" than
 * 4:30 in the dead of night). Hour 7-11 with no meridiem is left as AM
 * (used as-is); hour 0 or already >= 13 is unambiguous 24-hour notation
 * and is also used as-is. This is a deliberately simple heuristic, not a
 * calendar-aware disambiguation — see parseCallerIntentFromText's own doc
 * comment on why this stays plain pattern matching rather than an NLU
 * model.
 */
function extractExplicitTime(text: string): string | null {
  const withMeridiem = TIME_WITH_MERIDIEM_PATTERN.exec(text);
  if (withMeridiem) {
    let hour = parseInt(withMeridiem[1]!, 10);
    const minute = withMeridiem[2] ?? "00";
    const isPm = /p/i.test(withMeridiem[3]!);
    if (isPm && hour !== 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${minute}`;
  }
  const bareColon = TIME_24H_OR_BARE_COLON_PATTERN.exec(text);
  if (bareColon) {
    let hour = parseInt(bareColon[1]!, 10);
    const minute = bareColon[2]!;
    if (hour >= 1 && hour <= 6) hour += 12; // ambiguous -> assume afternoon
    return `${String(hour).padStart(2, "0")}:${minute}`;
  }
  return null;
}

// Matches a long run of digit groups, optionally separated by whitespace
// or hyphens (STT often transcribes a spoken phone number digit-by-digit,
// e.g. "7 9 0 6 9 0 3 0 1 2" or "790-690-3012") — at least 7 digits total,
// so a short number elsewhere in the sentence (a time, a date, a
// quantity) is never mistaken for one.
const PHONE_DIGIT_RUN_PATTERN = /\b(?:\d[\s-]*){6,}\d\b/;

/**
 * Extracts a phone number as the RAW digit string, read directly off the
 * caller's current turn — see mergeAppointmentState's own doc comment for
 * why this takes priority over the model's marker (production incident: a
 * caller's phone number came back shortened — "7-9-0 0" instead of the
 * digits actually given — once the model had to recall/re-type it later
 * in the call; reading the digits straight off the turn they were
 * actually spoken in avoids ever depending on that recall at all).
 */
function extractPhoneNumber(text: string): string | null {
  const match = PHONE_DIGIT_RUN_PATTERN.exec(text);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}

const EMAIL_SYMBOLIC_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// The common spoken form Sarvam STT sometimes transcribes verbatim instead
// of symbols — "dhanush56 at gmail dot com". The local part and domain are
// deliberately each a SINGLE alphanumeric token, not a "[\s.-]+"-joined
// run of several — production incident: an earlier version allowed a
// multi-word run before "at" (meant to support a spelled-out local part
// like "d h a n u s h at gmail dot com"), but since regex.exec always
// tries the EARLIEST possible starting position, that same greediness let
// it swallow unrelated LEADING words in the sentence too — "My email is
// chdhnsh56 at gmail dot com" matched starting at "My", capturing
// "myemailischdhnsh56" as the local part instead of "chdhnsh56". No test
// in this codebase ever exercised a genuine multi-word local part or
// domain, and every real caller utterance seen transcribes a spoken
// username/domain as one contiguous token — so restricting to a single
// token is a deliberate, conservative trade: it gives up a theoretical,
// never-reported, never-tested case to fix the confirmed, common one. The
// regex engine still naturally retries every later starting position when
// an earlier one fails to complete the full "local at domain dot tld"
// shape, so a caller saying "you can reach me at X at Y dot Z" still
// correctly resolves to the SECOND "at", not the first. Single-level
// domain only (no "dot co dot in"-style multi-part TLDs).
const EMAIL_SPOKEN_PATTERN = /\b([a-z0-9]+)\s+at\s+([a-z0-9]+)\s+dot\s+(com|org|net|in|co|io)\b/i;

/** Extracts an email address from the caller's current turn, same priority-over-the-marker reasoning as extractPhoneNumber. Normalized to lowercase "local@domain.tld". */
function extractEmail(text: string): string | null {
  const symbolic = EMAIL_SYMBOLIC_PATTERN.exec(text);
  if (symbolic) return symbolic[0].toLowerCase();
  const spoken = EMAIL_SPOKEN_PATTERN.exec(text);
  if (spoken) {
    return `${spoken[1]}@${spoken[2]}.${spoken[3]}`.toLowerCase();
  }
  return null;
}

export function parseCallerIntentFromText(text: string): CallerIntentSignals {
  const availabilityRequested =
    AVAILABILITY_KEYWORDS.test(text) &&
    (AVAILABILITY_QUESTION_SHAPE.test(text) ||
      /\?/.test(text) ||
      NEXT_AVAILABLE_PATTERN.test(text) ||
      AVAILABILITY_IMPERATIVE_PATTERN.test(text));
  const wantsNextAvailable = NEXT_AVAILABLE_PATTERN.test(text);
  const preferredPeriod = PERIOD_PATTERNS.find(([re]) => re.test(text))?.[1] ?? null;
  const relativeDate = RELATIVE_DATE_PATTERNS.find(([re]) => re.test(text))?.[1] ?? null;
  const weekdayMatch = WEEKDAY_PATTERN.exec(text);
  const weekday = weekdayMatch
    ? {
        weekday: WEEKDAY_NAMES.indexOf(
          weekdayMatch[2]!.toLowerCase() as (typeof WEEKDAY_NAMES)[number],
        ),
        forceNextWeek: Boolean(weekdayMatch[1]),
      }
    : null;
  const explicitTime = extractExplicitTime(text);
  const bookingConfirmed =
    BOOKING_CONFIRMATION_PATTERN.test(text) && !BOOKING_NEGATION_PATTERN.test(text);
  const reminderRequested = REMINDER_PATTERN.test(text);
  const phone = extractPhoneNumber(text);
  const email = extractEmail(text);
  return {
    availabilityRequested,
    wantsNextAvailable,
    preferredPeriod,
    relativeDate,
    weekday,
    explicitTime,
    bookingConfirmed,
    reminderRequested,
    phone,
    phoneMentioned: PHONE_CONTEXT_PATTERN.test(text),
    email,
  };
}

const PHONE_CONTEXT_PATTERN = /\b(phone|mobile|cell|contact|whats ?app)\b|\bnumber\b/i;

// Answers to CALLER_ID_QUESTION. "Different" wins over an affirmative word
// in the same sentence ("yes, but use a different number").
const CALLER_ID_DIFFERENT_PATTERN =
  /\b(different|another|other|new|separate)\s+(number|one|phone|mobile)\b|\b(no|nope|nah)\b(?!\s+problem)|\bdon'?t use\b|\bnot (that|this) (one|number)\b/i;
// Hedges are never an answer, even when they contain an affirmative word
// ("I'm not sure" contains "sure").
const CALLER_ID_HEDGE_PATTERN =
  /\b(not sure|unsure|not certain|don'?t know|no idea|maybe|i guess|which number|what number)\b/i;
const CALLER_ID_ACCEPT_PATTERN =
  /\b(yes|yeah|yep|yup|sure|ok(ay)?|of course|please do|go ahead|that'?s fine|that works|fine|correct|right|use (it|that|this)|same (number|one)|this number|that number|calling from|no problem)\b/i;
// The caller explicitly names the number they're calling from — a choice of
// caller ID whether or not the question was asked (call dfcf72ca: "use the
// number I'm calling from" was refused because the runtime hadn't recorded
// the model's own wording of the question as asked).
const CALLER_ID_EXPLICIT_PATTERN =
  /\b(?:number|phone|one)\s+(?:i'?m|i am|i was|i)\s+(?:calling|called|ringing)\s+(?:from|on|with)\b|\b(?:calling|incoming|current|same|this)\s+(?:phone\s+)?number\b|\bcaller\s?id\b/i;
const CALLER_ID_NEGATED_PATTERN = /\b(?:don'?t|do not|not|never)\s+(?:use|want)\b/i;
// The agent (in any wording) offering the number the caller is calling from.
const CALLER_ID_OFFER_PATTERN =
  /\b(?:calling|called|ringing)\s+(?:from|on|with)\b|\bnumber\s+you(?:'re|\s+are)\s+(?:calling|using)\b|\b(?:this|same|current|incoming)\s+(?:phone\s+)?number\b|\bcaller\s?id\b/i;

// Words that are never (part of) a caller's name — stops a "yes, book it"
// or "today at four" from being stored as one.
const NOT_A_NAME = new Set(
  (
    "yes yeah yep yup no nope nah ok okay sure fine right correct please thanks thank you " +
    "hello hi hey book booking it that this the a an and or but so is it's its was " +
    "number phone mobile calling from use same my me i i'm im am are be to for of on at in " +
    "today tomorrow morning afternoon evening pm am time date appointment slot service " +
    "root canal cleaning teeth tooth checkup dental treatment confirm confirmed go ahead " +
    "just only also again what why how when where who which can could would will shall " +
    "not don't do done good great perfect fine wait sorry hmm um uh"
  ).split(" "),
);

/** The agent's reply asked for the caller's name. */
const NAME_QUESTION_PATTERN =
  /\b(?:your|the)\s+(?:full\s+)?name\b|\bwho\s+(?:am i|is)\s+speaking\b/i;

/**
 * The caller's name from their own words (call dfcf72ca: the name was
 * given more than once but the model's state block never carried it, so
 * after the caller confirmed, the runtime asked for it again).
 *
 * - "my name is X" / "my name's X" / "call me X" — always.
 * - "this is X" / "I'm X" / "I am X" / "it's X", or a bare one-to-three word
 *   answer — only when the agent's previous reply asked for the name.
 *
 * Returns the name (each word capitalised) or null. Never returns a word in
 * NOT_A_NAME, digits, or more than three words.
 */
export function extractCallerName(text: string, agentAskedForName: boolean): string | null {
  const explicit = /\b(?:my\s+name\s+is|my\s+name'?s|call\s+me)\s+(.+)/i.exec(text);
  const contextual = agentAskedForName
    ? /^\s*(?:(?:it'?s|this\s+is|i'?m|i\s+am|name'?s|name\s+is)\s+)?(.+)$/i.exec(text)
    : null;
  const candidate = (explicit ?? contextual)?.[1];
  if (!candidate) return null;
  const words: string[] = [];
  for (const raw of candidate.split(/\s+/)) {
    const word = raw.replace(/^[^a-z]+|[^a-z]+$/gi, "");
    const ended = /[,.;!?]$/.test(raw);
    if (!word || !/^[a-z][a-z'.-]*$/i.test(word) || NOT_A_NAME.has(word.toLowerCase())) break;
    words.push(word);
    if (ended || words.length === 3) break;
  }
  if (!words.length) return null;
  // A contextual (non-explicit) answer must be ONLY the name — "Dhanush" or
  // "it's Dhanush", not "I'm calling about my teeth".
  if (!explicit) {
    const rest = candidate
      .split(/\s+/)
      .slice(words.length)
      .join(" ")
      .replace(/[^a-z]/gi, "");
    if (rest) return null;
  }
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/**
 * Interprets the caller's turn as an answer to CALLER_ID_QUESTION — only
 * while that question is pending (callerIdChoice "offered"/"clarifying")
 * and no number is known yet. Returns the state fields to apply, or null
 * when this turn isn't such an answer. Pure and directly unit-tested.
 *
 * - A number spoken in the answer is always taken as the caller's choice
 *   (normalized; an invalid one flags a targeted re-ask instead).
 * - An affirmative answer selects the trusted caller-ID number — the caller
 *   is never asked to repeat it.
 * - A "different number" answer moves on to asking for that number.
 * - Anything else gets exactly one short clarification, then falls back to
 *   asking for a number normally (never an endless loop).
 */
export function resolveCallerIdAnswer(
  text: string,
  state: Pick<AppointmentState, "phone" | "callerIdChoice">,
  callerId: string | null,
  phoneCountry: string | null = null,
):
  | (Pick<AppointmentState, "callerIdChoice"> &
      Partial<Pick<AppointmentState, "phone" | "phoneSource" | "phoneIssue">>)
  | null {
  if (state.phone || !callerId) return null;
  const spoken = extractPhoneNumber(text);
  if (
    !spoken &&
    CALLER_ID_EXPLICIT_PATTERN.test(text) &&
    !CALLER_ID_NEGATED_PATTERN.test(text) &&
    !CALLER_ID_HEDGE_PATTERN.test(text)
  ) {
    return {
      callerIdChoice: "accepted",
      phone: callerId,
      phoneSource: "caller_id",
      phoneIssue: null,
    };
  }
  if (state.callerIdChoice !== "offered" && state.callerIdChoice !== "clarifying") return null;
  if (spoken) {
    const normalized = normalizePhoneNumber(spoken, phoneCountry);
    return normalized.ok
      ? {
          callerIdChoice: "declined",
          phone: normalized.e164,
          phoneSource: "caller_provided",
          phoneIssue: null,
        }
      : { callerIdChoice: "declined", phoneIssue: normalized.reason };
  }
  const hedged = CALLER_ID_HEDGE_PATTERN.test(text);
  if (!hedged && CALLER_ID_DIFFERENT_PATTERN.test(text)) return { callerIdChoice: "declined" };
  if (!hedged && CALLER_ID_ACCEPT_PATTERN.test(text)) {
    return {
      callerIdChoice: "accepted",
      phone: callerId,
      phoneSource: "caller_id",
      phoneIssue: null,
    };
  }
  return { callerIdChoice: state.callerIdChoice === "offered" ? "clarifying" : "declined" };
}

// A reply sentence asking the caller for a phone number.
const PHONE_REQUEST_SENTENCE_PATTERN =
  /\b(phone|mobile|contact|cell)(\s+number)?\b|\byour number\b/i;
const QUESTION_SHAPE_PATTERN =
  /\?|\b(may i|can i|could i|could you|can you|please (share|provide|tell|give))\b|\bwhat(?:'?s| is)\b/i;

/**
 * When caller ID is usable and the caller hasn't been asked about it yet,
 * guarantees the phone number is requested via CALLER_ID_QUESTION rather
 * than "what's your phone number?" — the model's own wording is replaced
 * sentence-by-sentence (only the phone-request sentence; everything else
 * it said is kept). `offered` is true when the reply now carries the
 * question, so the caller's next turn is read as its answer.
 */
export function applyCallerIdOffer(
  reply: string,
  state: Pick<AppointmentState, "phone" | "callerIdChoice">,
): { reply: string; offered: boolean } {
  if (state.phone || state.callerIdChoice !== "not_offered") return { reply, offered: false };
  if (CALLER_ID_OFFER_PATTERN.test(reply)) return { reply, offered: true };
  const sentences = reply.match(/[^.!?]+[.!?]*\s*/g) ?? [reply];
  let replaced = false;
  const rewritten = sentences.map((sentence) => {
    if (
      !replaced &&
      PHONE_REQUEST_SENTENCE_PATTERN.test(sentence) &&
      QUESTION_SHAPE_PATTERN.test(sentence)
    ) {
      replaced = true;
      return `${CALLER_ID_QUESTION} `;
    }
    return PHONE_REQUEST_SENTENCE_PATTERN.test(sentence) && QUESTION_SHAPE_PATTERN.test(sentence)
      ? ""
      : sentence;
  });
  return replaced ? { reply: rewritten.join("").trim(), offered: true } : { reply, offered: false };
}

/** A sentence that asks for, or refuses to use, the caller's phone number. */
const PHONE_REFUSAL_PATTERN =
  /\b(?:can'?t|cannot|unable to|don'?t have|do not have)\b[^.?!]*\b(?:number|caller\s?id)\b/i;

/**
 * Once a phone number is settled, the model's own request for one (or its
 * claim that it can't see the caller's number) is removed — call dfcf72ca:
 * the caller agreed to use their calling number and was asked for a number
 * anyway. When nothing else is left, the next missing detail is asked.
 * With no caller ID at all, an offer of "the number you're calling from"
 * (which the runtime couldn't honour) becomes a plain request for a number.
 * English replies only (the patterns are English).
 */
export function guardPhoneRequests(
  reply: string,
  state: AppointmentState,
): { reply: string; changed: boolean } {
  const sentences = reply.match(/[^.!?]+[.!?]*\s*/g) ?? [reply];
  const asksForPhone = (sentence: string) =>
    PHONE_REQUEST_SENTENCE_PATTERN.test(sentence) && QUESTION_SHAPE_PATTERN.test(sentence);
  if (state.phone) {
    const kept = sentences.filter(
      (sentence) => !asksForPhone(sentence) && !PHONE_REFUSAL_PATTERN.test(sentence),
    );
    if (kept.length === sentences.length) return { reply, changed: false };
    const rest = kept.join("").trim();
    return {
      reply: rest || nextMissingDetailQuestion(state) || "Thank you.",
      changed: true,
    };
  }
  if (state.callerIdChoice === "unavailable") {
    let replaced = false;
    const rewritten = sentences.map((sentence) => {
      if (!CALLER_ID_OFFER_PATTERN.test(sentence)) return sentence;
      if (replaced) return "";
      replaced = true;
      return "What's the best phone number to reach you? ";
    });
    return replaced
      ? { reply: rewritten.join("").trim(), changed: true }
      : { reply, changed: false };
  }
  return { reply, changed: false };
}

/**
 * The single detail still missing before a booking can be attempted, asked
 * as one targeted question (English) — the alternative to the model
 * restarting the whole collection. Null when nothing is missing. The phone
 * question uses CALLER_ID_QUESTION whenever caller ID is usable and the
 * caller hasn't answered it yet.
 */
const INVALID_PHONE_QUESTION =
  "Sorry, I didn't catch a complete phone number. Could you please say your phone number again, digit by digit?";
const COUNTRY_CODE_PHONE_QUESTION =
  "Could you please say your phone number again, including the country code?";

/** The targeted re-ask for a phone number that couldn't be used. */
function phoneIssueQuestion(issue: "invalid" | "country_code_required"): string {
  return issue === "country_code_required" ? COUNTRY_CODE_PHONE_QUESTION : INVALID_PHONE_QUESTION;
}

export function nextMissingDetailQuestion(s: AppointmentState): string | null {
  if (!s.service) return "Which service would you like to book?";
  if (!s.customerName) return "May I have your name for the appointment?";
  if (!s.preferredDate) return "Which date would you like to come in?";
  if (!s.preferredTime && !s.wantsNextAvailable) return "What time would you prefer?";
  if (!s.phone) {
    if (s.phoneIssue) return phoneIssueQuestion(s.phoneIssue);
    if (s.callerIdChoice === "not_offered") return CALLER_ID_QUESTION;
    if (s.callerIdChoice === "offered" || s.callerIdChoice === "clarifying") {
      return "Just to confirm, shall I use the number you're calling from?";
    }
    return "What's the best phone number to reach you?";
  }
  return null;
}

const GOODBYE_PATTERN = /\b(good ?bye|bye( bye)?)\b/i;
const NOTHING_ELSE_PATTERN =
  /^\W*(no|nope|nah|no thanks?|no thank you|thanks?|thank you( so much| very much)?|that'?s (all|it|everything)|nothing( else)?|i'?m (good|fine|all set)|all good)\b|\b(nothing else|that'?s all|that'?s it|that'?s everything|no,? thanks?|no,? thank you)\b/i;

// "Thanks — can I also ask about prices?" is a new question, not a goodbye.
const CONTINUATION_PATTERN =
  /\?|\b(also|another|one more|what|how|when|where|why|can (i|you)|could (i|you)|i (want|need|would like)|book|reschedule|cancel)\b/i;

/**
 * Whether the caller is ending the conversation: an explicit goodbye at any
 * point, or — only right after a confirmed booking, when the agent asked
 * "anything else?" — a plain "no"/"that's all"/"thank you". Never true when
 * the same turn also carries a new booking request (a date, time, or
 * availability question), so "no, actually can I also book Friday?" is
 * handled as a request, not a hangup.
 */
export function isClosingUtterance(
  text: string,
  awaitingAnythingElse: boolean,
  intent: Pick<
    CallerIntentSignals,
    "availabilityRequested" | "explicitTime" | "relativeDate" | "weekday"
  >,
): boolean {
  if (
    intent.availabilityRequested ||
    intent.explicitTime ||
    intent.relativeDate ||
    intent.weekday
  ) {
    return false;
  }
  if (GOODBYE_PATTERN.test(text)) return true;
  return (
    awaitingAnythingElse && NOTHING_ELSE_PATTERN.test(text) && !CONTINUATION_PATTERN.test(text)
  );
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

/**
 * Resolves a caller-named weekday ("Friday", "next Monday") to an actual
 * YYYY-MM-DD in the business's own timezone — same noon-anchored,
 * DST-transition-safe technique as resolveRelativeDateInTimezone, reusing
 * calendar/timezone.ts's own dayOfWeekInTimezone to read what weekday
 * "today" is.
 *
 * Plain "Friday" resolves to the NEAREST such day on or after today
 * (today itself, if today IS a Friday) — the ordinary meaning of naming a
 * weekday without qualification. "next Friday" explicitly skips to the
 * following week's occurrence instead, even when today already is a
 * Friday.
 */
function resolveWeekdayInTimezone(
  signal: { weekday: number; forceNextWeek: boolean },
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
  const todayWeekday = dayOfWeekInTimezone(todayYmd, timeZone);
  let daysUntil = (signal.weekday - todayWeekday + 7) % 7;
  if (signal.forceNextWeek) daysUntil += 7;
  const targetInstant = new Date(
    zonedWallTimeToUtc(todayYmd, "12:00", timeZone).getTime() + daysUntil * 24 * 60 * 60 * 1000,
  );
  return ymdFormatter.format(targetInstant);
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
    session.ttsLastSendAt = Date.now();
    session.ttsAudioSinceSend = false;
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
): Promise<{
  reply: string;
  enteredPaymentWait: boolean;
  usedToolCalling: boolean;
  bookedViaTool: boolean;
  /** book_appointment's real outcome on the tool-calling path this turn, if it ran. */
  toolBookingOutcome: BookingOutcome | null;
}> {
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
      // Record book_appointment's REAL outcome (the stored booking's status)
      // as it passes through — toolCalls only carries name/isError, and the
      // model's own wording must never be the only evidence of a booking.
      let bookingOutcome: BookingOutcome | null = null;
      const result = await generateReplyWithTools(messages, tools, async (name, input) => {
        const toolResult = await executeTool(name, input, toolCtx);
        if (name === "book_appointment") {
          const parsed = safeJsonParse(toolResult.content);
          const reported = parsed?.["bookingOutcome"];
          bookingOutcome =
            !toolResult.isError && typeof reported === "string"
              ? (reported as BookingOutcome)
              : "not_booked";
        }
        return toolResult;
      });
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
      const outcome = bookingOutcome as BookingOutcome | null;
      return {
        reply: result.reply,
        enteredPaymentWait,
        usedToolCalling: true,
        bookedViaTool: outcome === "confirmed" || outcome === "saved_calendar_sync_failed",
        toolBookingOutcome: outcome,
      };
    }
  }
  const { reply } = await session.deps.generateReply(messages);
  return {
    reply,
    enteredPaymentWait: false,
    usedToolCalling: false,
    bookedViaTool: false,
    toolBookingOutcome: null,
  };
}

/** Absolute last-resort appointment length — used only when the business's own configured default (businesses.default_appointment_duration_minutes, resolved per-call in resolveBookingContext) genuinely could not be read, e.g. the DB lookup itself failed. Never the primary fallback; see matchService's own doc comment. */
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

export interface ResolvedService {
  id: string | null;
  durationMinutes: number;
}

/**
 * Matches the caller's requested service (AppointmentState.service, the
 * free-text name captured via the marker — e.g. "teeth cleaning") against
 * this business's configured `services` rows, returning its real
 * `duration_minutes` — fixing the production gap where every availability
 * check and booking used a hardcoded 30-minute duration regardless of what
 * the business actually configured for that service.
 *
 * Matches by exact name first (case-insensitive), then falls back to a
 * substring match either direction (the caller's own wording and the
 * configured service name are free text on both sides and rarely match
 * character-for-character — "teeth cleaning" vs. a configured "Teeth
 * Cleaning & Polish"). Falls back to `fallbackDurationMinutes` — the
 * business's own configured default_appointment_duration_minutes
 * (resolveBookingContext resolves it per-call; the bare
 * DEFAULT_APPOINTMENT_DURATION_MINUTES constant is only its own
 * last-resort default) — whenever no service is known, no match is found,
 * or the matched service has no duration configured; never silently
 * invents a duration that wasn't actually configured. Pure (no I/O) — see
 * resolveBookingContext for where `rows` comes from. Exported directly
 * for unit testing — this
 * codebase's test harness has no real Supabase client to resolve
 * resolveBookingContext's own DB query through (every harness test already
 * runs against its fallback), so service-duration coverage (15/30/45/60
 * minute services, exact vs. substring matching, no-match fallback) tests
 * this pure function directly instead.
 */
export function matchService(
  rows: { id: string; name: string; duration_minutes: number | null }[],
  serviceName: string | null,
  fallbackDurationMinutes: number = DEFAULT_APPOINTMENT_DURATION_MINUTES,
): ResolvedService {
  if (!serviceName) return { id: null, durationMinutes: fallbackDurationMinutes };
  // Exact name, then substring either way, then the caller-wording matcher
  // ("clean my teeth" -> "Teeth Cleaning") — see service-matching.ts.
  const match = findConfiguredService(rows, serviceName);
  if (!match) return { id: null, durationMinutes: fallbackDurationMinutes };
  return {
    id: match.id,
    durationMinutes: match.duration_minutes ?? fallbackDurationMinutes,
  };
}

/**
 * The REVERSE lookup direction from matchService: scans the caller's own
 * raw turn text for any configured service's name appearing as a
 * case-insensitive substring, so a service mentioned for the first time
 * ("General checkup") is captured into AppointmentState.service the
 * SAME turn it's said, rather than waiting on the model's own marker to
 * propose it. Prefers the LONGEST matching name — a short configured name
 * like "Cleaning" would otherwise match before a more specific "Deep
 * Cleaning & Polish" that's also present in the row set. Pure (no I/O);
 * `rows` comes from resolveDeterministicExtractionContext. Returns the
 * matched row's own name (not the caller's wording), so a later
 * matchService lookup against it is a trivial exact-name hit.
 */
export function matchServiceInText(
  rows: { id: string; name: string; duration_minutes: number | null }[],
  text: string,
): string | null {
  const result = resolveServiceFromText(rows, text);
  return result.kind === "match" ? result.row.name.trim() : null;
}

/**
 * Combines the business-timezone lookup (resolveBusinessTimezone's own
 * query) and the configured-services lookup (matchService's own input)
 * into a single dynamic import + a single round trip (two queries run
 * concurrently against the same already-imported client, via
 * Promise.all) — attemptAvailabilityCheck/attemptBooking need both every
 * turn, and resolving them as two separate lazy imports would double that
 * overhead for no benefit. Looked up fresh per attempt rather than
 * threaded through StartRuntimeSessionInput — see attemptBooking's own
 * doc comment for why.
 */
async function resolveBookingContext(
  businessId: string,
  serviceName: string | null,
  // The configured services already loaded for this call (the same rows the
  // caller's wording was matched against). When present, the booking uses
  // exactly those rows rather than querying them again.
  knownServices: ServiceRow[] | null = null,
): Promise<{ timezone: string; service: ResolvedService }> {
  const cached = knownServices && knownServices.length ? knownServices : null;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [businessRes, servicesRes] = await Promise.all([
      supabaseAdmin
        .from("businesses")
        .select("timezone, default_appointment_duration_minutes")
        .eq("id", businessId)
        .maybeSingle(),
      cached
        ? Promise.resolve({ data: cached })
        : supabaseAdmin
            .from("services")
            .select("id, name, duration_minutes")
            .eq("business_id", businessId)
            .eq("is_active", true),
    ]);
    const fallbackDurationMinutes =
      businessRes.data?.default_appointment_duration_minutes ??
      DEFAULT_APPOINTMENT_DURATION_MINUTES;
    return {
      timezone: businessRes.data?.timezone ?? "UTC",
      service: matchService(servicesRes.data ?? [], serviceName, fallbackDurationMinutes),
    };
  } catch {
    return {
      timezone: "UTC",
      service: matchService(cached ?? [], serviceName, DEFAULT_APPOINTMENT_DURATION_MINUTES),
    };
  }
}

/**
 * tryEarlyDeterministicDispatch's own combined fetch — mirrors
 * resolveBookingContext's "one dynamic import, Promise.all both queries"
 * discipline, but for the two DIFFERENT lookups the deterministic
 * extraction preview conditionally needs: the business timezone (to
 * resolve a relativeDate/weekday into an actual date) and the configured
 * services list (for matchServiceInText). Each is fetched only when its
 * own `needs*` flag is set — a turn with no date word and an
 * already-known service costs nothing here — but when BOTH are needed,
 * this is still exactly one round trip, not two separate lazy imports
 * (the exact class of duplicate-DB-call regression this file has
 * repeatedly had to fix; see resolveBookingContext's own doc comment).
 */
async function resolveDeterministicExtractionContext(
  businessId: string,
  needsTimezone: boolean,
  needsServices: boolean,
): Promise<{
  timezone: string | null;
  /** Null when not requested OR when the read failed — never an empty stand-in for a failure. */
  services: { id: string; name: string; duration_minutes: number | null }[] | null;
  /** Why the services read failed (a PostgREST/SQLSTATE code, or "unavailable"); null otherwise. */
  servicesError: string | null;
}> {
  if (!needsTimezone && !needsServices) {
    return { timezone: null, services: null, servicesError: null };
  }
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [businessRes, servicesRes] = await Promise.all([
      needsTimezone
        ? supabaseAdmin.from("businesses").select("timezone").eq("id", businessId).maybeSingle()
        : Promise.resolve(null),
      needsServices
        ? supabaseAdmin
            .from("services")
            .select("id, name, duration_minutes")
            .eq("business_id", businessId)
            .eq("is_active", true)
        : Promise.resolve(null),
    ]);
    // Production incident (Smile Dental, "Root canal"): a failed services
    // read (e.g. PGRST303) came back as `data: null` and was used as an
    // empty catalog — cached for the rest of the call, so nothing the caller
    // said could ever match. A failure is now reported as such.
    const servicesError =
      needsServices && servicesRes?.error
        ? (servicesRes.error as { code?: string }).code || "unknown"
        : null;
    return {
      timezone: needsTimezone ? (businessRes?.data?.timezone ?? "UTC") : null,
      services: needsServices && !servicesError ? (servicesRes?.data ?? []) : null,
      servicesError,
    };
  } catch {
    return {
      timezone: needsTimezone ? "UTC" : null,
      services: null,
      servicesError: needsServices ? "unavailable" : null,
    };
  }
}

/**
 * State-aware acknowledgements (production incident: a generic filler
 * before every LLM call would mean saying something before every single
 * turn, including turns that are already fast; this instead speaks a
 * short, concrete acknowledgement only at specific, well-understood
 * AppointmentState transitions, naming what was actually just captured —
 * see handleUserUtterance for where these are used). English only
 * (en-IN) — a non-English/code-mixed call keeps the model's own wording
 * entirely rather than mixing in a hardcoded English phrase.
 */

/** "today"/"tomorrow"/"October 9" — never the bare ISO string, which TTS would read out digit by digit. */
export function spokenDateLabel(dateIso: string, timeZone: string, now: Date = new Date()): string {
  const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayYmd = ymdFormatter.format(now);
  if (dateIso === todayYmd) return "today";
  const tomorrowInstant = new Date(
    zonedWallTimeToUtc(todayYmd, "12:00", timeZone).getTime() + 24 * 60 * 60 * 1000,
  );
  if (dateIso === ymdFormatter.format(tomorrowInstant)) return "tomorrow";
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
}

/** "3 PM"/"3:30 PM" from a 24-hour "HH:mm" — never the bare 24-hour string. */
export function spokenTimeLabel(hhmm: string): string {
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0
    ? `${hour12} ${period}`
    : `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

/** The caller's requested time, in whatever shape is actually known — an exact time, a period, "the next available time", or a neutral fallback. Never invents a time that isn't in the state. */
export function describeRequestedTime(state: AppointmentState): string {
  if (state.preferredTime) return spokenTimeLabel(state.preferredTime);
  if (state.preferredPeriod) return `the ${state.preferredPeriod}`;
  if (state.wantsNextAvailable) return "the next available time";
  return "that time";
}

/** A short acknowledgement already said this reply makes a second, deterministic one redundant — e.g. the model's own reply already opens with the caller's name, or with a common ack word. Deliberately simple/conservative: a false negative here just means an extra (harmless) short phrase; a false positive would mean skipping a needed acknowledgement, so this only matches clear, common cases. */
export function replyAlreadyAcknowledges(reply: string, customerName: string | null): boolean {
  const lead = reply.slice(0, 40).toLowerCase();
  if (customerName && lead.includes(customerName.toLowerCase())) return true;
  return /\b(got it|thanks|thank you|great|perfect|noted|sure thing|okay|alright|sounds good)\b/.test(
    lead,
  );
}

const WEEKDAY_SPOKEN_NAMES = WEEKDAY_NAMES.map((n) => n[0]!.toUpperCase() + n.slice(1));

/**
 * Detects a field transition that just happened THIS turn (previous vs.
 * merged AppointmentState) and returns a short deterministic phrase to
 * prepend to the model's own reply — never a replacement, so there is
 * only ever one spoken acknowledgement for a given field, not two. Picks
 * the MOST ADVANCED applicable transition when several fields arrive in
 * the same utterance (e.g. "I'm Dhanush and I want teeth cleaning
 * tomorrow"), so it never says a now-stale "got it, what's your name"
 * when the caller has already moved the conversation further along.
 *
 * `timeJustCaptured` deliberately does NOT require `next.service` (unlike
 * an earlier version of this function) — production incident: a real call
 * had the caller give name, then phone, then date/time, then service
 * LAST, and requiring service here meant NO deterministic ack ever fired
 * for the time-capture turn, leaving the caller's entire reply to the
 * slow, ungrounded Sarvam call. The spoken phrase itself never named the
 * service either way, so dropping the requirement loses nothing and
 * covers the real field order.
 *
 * Deliberately does not cover the "required info complete" transition —
 * handleUserUtterance's own completion-triggered dispatch speaks its own
 * consolidated acknowledgement for that one, immediately before the real
 * availability check, so there is no second thing to say here.
 *
 * Deliberately synchronous — no business-timezone DB lookup. The date
 * label here is a cosmetic "today"/"tomorrow" nicety, not the booking
 * logic itself (the real check_calendar_availability/book_appointment
 * call downstream still resolves and uses the real business timezone via
 * resolveBookingContext). Using UTC for the label's today/tomorrow
 * comparison is wrong only in a narrow window near local midnight, where
 * it falls back to an unambiguous "Month Day" phrasing rather than a
 * wrong day — an acceptable tradeoff for keeping this function (called on
 * every ordinary conversational turn) free of any extra await, which
 * previously pushed existing tests' drain() budgets past their limit.
 */
function fieldTransitionAck(previous: AppointmentState, next: AppointmentState): string | null {
  const timeJustCaptured =
    !previous.preferredTime &&
    !previous.preferredPeriod &&
    !previous.wantsNextAvailable &&
    (next.preferredTime || next.preferredPeriod || next.wantsNextAvailable) &&
    next.preferredDate;
  if (timeJustCaptured) {
    const dateLabel = spokenDateLabel(next.preferredDate!, "UTC");
    return `Perfect — ${dateLabel} at ${describeRequestedTime(next)}.`;
  }

  // Service arriving AFTER date/time were already known (the real call's
  // actual order) — a case the original (service-and-date-together-only)
  // version of this function had no phrase for at all.
  const serviceJustCapturedAfterDateTime =
    !previous.service &&
    next.service &&
    previous.preferredDate &&
    (previous.preferredTime || previous.preferredPeriod || previous.wantsNextAvailable);
  if (serviceJustCapturedAfterDateTime) {
    const dateLabel = spokenDateLabel(next.preferredDate ?? previous.preferredDate!, "UTC");
    return `Got it — ${next.service} ${dateLabel} at ${describeRequestedTime(next)}.`;
  }

  const serviceAndDateJustCaptured =
    (!previous.service || !previous.preferredDate) && next.service && next.preferredDate;
  if (serviceAndDateJustCaptured) {
    const dateLabel = spokenDateLabel(next.preferredDate!, "UTC");
    return `Got it — ${next.service} ${dateLabel}.`;
  }

  const nameJustCaptured = !previous.customerName && next.customerName;
  if (nameJustCaptured) {
    return `Got it, ${next.customerName}.`;
  }

  return null;
}

/**
 * The fast path for Fix #2/#3 (production incident: a real call showed
 * several seconds of total silence after "Tomorrow at 3 p.m. afternoon.",
 * ending in the caller asking "Hello? Are you there?" — traced to every
 * acknowledgement in this file being computed only AFTER the Sarvam LLM
 * call resolved, with nothing spoken before it). Computed from
 * `callerIntent` (parseCallerIntentFromText's deterministic read of the
 * caller's OWN words) and the AppointmentState as of BEFORE this turn —
 * deliberately NOT the model's marker, which does not exist yet at the
 * point this runs (before getReply is even called). Entirely synchronous
 * and local: no DB lookup, no LLM round trip, so it can be spoken the
 * instant the transcript arrives.
 *
 * The date/time branch deliberately requires `explicitTime` (not a bare
 * date alone) before firing — a date-only utterance ("...tomorrow") in
 * real speech very often also carries a service/name the caller is
 * naming in the same breath, which this function has no way to see
 * (service/name have no deterministic extractor); firing early on date
 * alone would say a LESS informative "Got it — tomorrow." immediately,
 * then have nothing more to add once the fuller marker-based ack would
 * otherwise have named the service too. An explicit time is a much more
 * self-contained, safe-to-acknowledge-immediately statement.
 */
function immediateCallerAck(
  previous: AppointmentState,
  intent: CallerIntentSignals,
): string | null {
  // Only once a specific slot is already clearly on the table — matches
  // the same gating handleUserUtterance's own bookingConfirmed backstop
  // applies before escalating to ready_to_book, so a stray "yes"/"sure"
  // earlier in an unrelated exchange never triggers this.
  if (
    intent.bookingConfirmed &&
    previous.bookingStatus !== "ready_to_book" &&
    previous.preferredDate &&
    (previous.preferredTime || previous.wantsNextAvailable)
  ) {
    return "Give me just a moment to confirm that.";
  }
  // AVAILABILITY_KEYWORDS/AVAILABILITY_QUESTION_SHAPE deliberately also
  // match a plain business-hours question ("What time do you close?" — see
  // their own pattern comments for "what time" being a shared trigger),
  // which is harmless where availabilityRequested is only ever used to
  // GATE an already-date-known dispatch, but would misfire here as an
  // immediate ack with no calendar context in play at all. Requiring some
  // actual date context (already known, or given in this same breath)
  // before committing to "let me check that for you" avoids that false
  // positive; a bare, date-less availability-shaped question still gets
  // the normal (non-immediate) marker-driven handling one turn later.
  const hasDateContext = Boolean(previous.preferredDate || intent.relativeDate || intent.weekday);
  if (intent.availabilityRequested && hasDateContext) {
    return "Sure, let me check that for you.";
  }

  const timeJustGiven = Boolean(intent.explicitTime) && !previous.preferredTime;
  if (timeJustGiven) {
    const dateLabel =
      intent.relativeDate ??
      (intent.weekday ? WEEKDAY_SPOKEN_NAMES[intent.weekday.weekday] : null) ??
      (previous.preferredDate ? spokenDateLabel(previous.preferredDate, "UTC") : null);
    const timeLabel = spokenTimeLabel(intent.explicitTime!);
    return dateLabel ? `Got it — ${dateLabel} at ${timeLabel}.` : `Got it — ${timeLabel}.`;
  }

  if ((intent.phone || intent.email) && !(previous.phone && previous.email)) {
    return "Got it, thanks.";
  }

  return null;
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
// Fix #4 (local fallback when the calendar succeeds but the LLM phrasing
// call is what's slow/fails): bounded well under TURN_DEADLINE_MS, so a
// slow SECOND Sarvam call (this one) can never, by itself, run the clock
// out on the whole turn and lose a real, already-known-honest outcome to
// the generic turn-deadline apology (see withTurnDeadline's own doc
// comment — that apology is deliberately generic and knows nothing about
// what actually happened). A few seconds is still ample for a short,
// one-or-two-sentence paraphrase.
const PHRASING_LLM_TIMEOUT_MS = 6_000;

/**
 * `localFallback` is a plain, already caller-facing sentence (never an
 * LLM-prompt-style instruction, unlike `facts`) — spoken verbatim when
 * this function's own LLM call is slow enough to exceed
 * PHRASING_LLM_TIMEOUT_MS, or fails outright. Every call site provides
 * its own, matching exactly what `facts` says, so the caller always
 * hears something honest and specific to the real outcome — never a
 * generic "something went wrong" — regardless of whether the SECOND
 * Sarvam call (this one) is what's struggling, as opposed to the first.
 */
async function composeHonestBookingReply(
  session: Session,
  facts: string,
  localFallback: string,
): Promise<string> {
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
    const { reply } = await withToolDeadline(
      PHRASING_LLM_TIMEOUT_MS,
      session.deps.generateReply([
        {
          role: "system",
          content: `You are ${session.input.snapshotAgent.agent_name}, a phone receptionist. Respond in language code ${language}. One or two short sentences, phone-conversation style. State only what the facts below say — never claim a booking succeeded unless the facts say it did. Never mention a support ticket, a callback, or a reminder being created/scheduled/sent unless the facts below explicitly say one was. Do not add any JSON, markers, or notes.`,
        },
        { role: "user", content: facts },
      ]),
    );
    // The phrasing prompt asks for no markers; strip one anyway so a stray
    // state block can never be read aloud.
    const spoken = parseApptStateMarker(reply).spokenText.trim();
    // An empty phrasing reply must never become silence after a real tool
    // result — the caller would hear nothing and the call would sit idle
    // until the silence prompt. The canned, already-honest fallback says
    // the same facts.
    if (!spoken) {
      log("booking_reply_composition_empty", session);
      namedLog("voice:final_response", session, {
        latency_ms: Date.now() - startedAt,
        replyLength: localFallback.length,
        fellBackToCannedReply: true,
      });
      return localFallback;
    }
    namedLog("voice:final_response", session, {
      latency_ms: Date.now() - startedAt,
      replyLength: spoken.length,
    });
    return spoken;
  } catch (err) {
    log("booking_reply_composition_failed", session, { message: (err as Error).message });
    namedLog("voice:final_response", session, {
      latency_ms: Date.now() - startedAt,
      replyLength: localFallback.length,
      fellBackToCannedReply: true,
    });
    return localFallback;
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

/** The plain, already caller-facing counterpart to calendarErrorFacts — for composeHonestBookingReply's `localFallback` parameter, same error-code mapping, never an LLM-prompt-style instruction. */
function calendarErrorFallback(errorCode: string): string {
  switch (errorCode) {
    case "GOOGLE_AUTH_REQUIRED":
    case "NEEDS_REAUTH":
    case "NOT_CONFIGURED":
      return "I'm sorry, I'm unable to access the calendar for this business right now, so I can't confirm that yet. I'll have someone call you back to confirm.";
    case "CALENDAR_TIMEOUT":
      return "I'm sorry, the calendar is taking longer than expected to respond, so I couldn't confirm that just now. Someone will follow up shortly.";
    default:
      return "I'm sorry, I couldn't reach the calendar just now, so I can't confirm that. I'll have someone call you back to confirm.";
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

/** The business-local calendar date ("YYYY-MM-DD") of a UTC instant — null if the timezone/instant can't be formatted. */
function formatSlotDateLocal(isoUtc: string, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(isoUtc));
  } catch {
    return null;
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

  // Dedup (production reliability gap: a repeated/rephrased "is that still
  // available?" for the EXACT same date/time/period re-ran a real Google
  // Calendar + database round trip for information already in hand).
  // mergeAppointmentState resets availabilityStatus to "unknown" the
  // instant the requested date/time/period actually changes, so "not
  // unknown" here reliably means this exact slot was already checked
  // against the real calendar and nothing about the request has moved
  // since — reuse that real result instead of calling out again.
  if (state.availabilityStatus !== "unknown") {
    namedLog("calendar_tool:skipped_unchanged_request", session, {
      tool: "check_calendar_availability",
      availability_status: state.availabilityStatus,
    });
    return {
      spoken: await composeHonestBookingReply(
        session,
        state.availabilityStatus === "available" && state.selectedSlot
          ? "The requested time was already confirmed available by the calendar moments ago — restate that briefly and ask if they'd like you to book it, without checking again."
          : "This exact date/time was already checked moments ago and is NOT available — restate that briefly, same as before, nothing new to add.",
        state.availabilityStatus === "available" && state.selectedSlot
          ? "That time is already confirmed available — would you like me to book it?"
          : "That time isn't available, as I mentioned a moment ago.",
      ),
      state: { ...state, bookingStatus: "collecting" },
    };
  }

  if (!executeTool || !state.preferredDate) {
    namedLog("calendar_tool:error", session, {
      tool: "check_calendar_availability",
      code: "NOT_CONFIGURED",
    });
    return {
      spoken: await composeHonestBookingReply(
        session,
        "Availability could not be checked because this line isn't configured for live calendar access. Tell the caller you'll have someone confirm and call them back.",
        "I'm sorry, I'm unable to access the calendar on this line right now. I'll have someone call you back to confirm.",
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
  const { timezone, service } = await resolveBookingContext(
    businessId,
    state.service,
    session.cachedServices,
  );
  const exactStartIso = state.preferredTime
    ? zonedWallTimeToUtc(state.preferredDate, state.preferredTime, timezone).toISOString()
    : null;

  namedLog("calendar_tool:start", session, {
    tool: "check_calendar_availability",
    call_id: callId,
    business_id: businessId,
    date: state.preferredDate,
    requested_time: state.preferredTime ?? state.preferredPeriod ?? "any",
    duration_minutes: service.durationMinutes,
  });
  const startedAt = Date.now();
  namedLog("calendar_tool:provider_request", session, { tool: "check_calendar_availability" });

  const availability = await withToolDeadline(
    CALENDAR_TOOL_TIMEOUT_MS,
    executeTool(
      "check_calendar_availability",
      { dateIso: state.preferredDate, durationMinutes: service.durationMinutes },
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
      spoken: await composeHonestBookingReply(
        session,
        calendarErrorFacts(errorCode),
        calendarErrorFallback(errorCode),
      ),
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
          "Good news — that time is available. Would you like me to book it?",
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
        alternatives.length
          ? `That time isn't available. The only open times that day are ${alternatives.join(" and ")}. Would either of those work?`
          : "That time isn't available, and there are no other open slots that day. Would you like me to check a different day?",
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
        `There are no open slots on ${state.preferredDate}${periodLabel}. Would you like me to check a different day?`,
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
      `These times are open on ${state.preferredDate}${periodLabel}: ${listed.join(", ")}. Would any of those work?`,
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
  generation: number,
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
        "I'm sorry, I'm unable to complete the booking on this line right now. I'll have someone call you back to confirm.",
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
  const { timezone, service } = await resolveBookingContext(
    session.input.businessId,
    state.service,
    session.cachedServices,
  );
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
    durationMinutes: service.durationMinutes,
  });
  namedLog("calendar_tool:start", session, {
    tool: "check_calendar_availability",
    call_id: session.input.callId,
    business_id: session.input.businessId,
    date: state.preferredDate,
    requested_time: state.preferredTime,
    duration_minutes: service.durationMinutes,
  });
  const availabilityStartedAt = Date.now();
  namedLog("calendar_tool:provider_request", session, { tool: "check_calendar_availability" });

  const availability = await withToolDeadline(
    CALENDAR_TOOL_TIMEOUT_MS,
    executeTool(
      "check_calendar_availability",
      { dateIso: state.preferredDate, durationMinutes: service.durationMinutes },
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
      spoken: await composeHonestBookingReply(
        session,
        calendarErrorFacts(errorCode),
        calendarErrorFallback(errorCode),
      ),
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
        alternatives.length
          ? `That time isn't available. The only open times that day are ${alternatives.join(" and ")}. Would either of those work?`
          : "There are no open slots available for that time. Would you like me to check a different day?",
      ),
      state: {
        ...state,
        bookingStatus: "unavailable",
        availabilityStatus: "unavailable",
        selectedSlot: alternatives.length ? (slots[0] ?? null) : null,
      },
    };
  }
  // Checked HERE — immediately before committing to the real
  // book_appointment side effect — not just before speaking the result
  // afterward. A stale generation check that only suppresses SPEECH is
  // not sufficient once a turn has actually performed a booking side
  // effect: a caller who said "book it" and then immediately "wait,
  // don't" must never end up with a real appointment just because this
  // turn's availability round trip happened to start first. This is the
  // one point that can still prevent the side effect itself — once the
  // real executeTool("book_appointment", ...) call below has actually
  // been dispatched, there is no cancellation mechanism in this codebase
  // (see handleUserUtterance's own comment on this honest limitation),
  // so a caller who interrupts AFTER that point cannot stop the booking
  // from being created; that residual window is a genuine,
  // acknowledged distributed-system limitation, not something this check
  // claims to close.
  if (session.generation !== generation) {
    log("booking_attempt_skipped_stale", session);
    return { spoken: "", state };
  }

  // The REAL time being booked — for an exact-time request this equals
  // what the caller already said; for "next available" it's the actual
  // resolved slot. What gets spoken and stored afterwards comes from the
  // persisted booking itself (see confirmedStartIso below).
  const startIso = targetSlot.start;
  const endIso = targetSlot.end;

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
        ...(service.id ? { serviceId: service.id } : {}),
        ...(state.email ? { customerEmail: state.email } : {}),
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
    // The booking layer rejected the phone number itself — everything else
    // the caller gave is still valid, so ask ONLY for the number again
    // rather than declining the whole booking or restarting collection.
    if (errorCode === "INVALID_PHONE") {
      return {
        spoken: await composeHonestBookingReply(
          session,
          "The booking was NOT made because the caller's phone number is not a valid, complete number. Do not say it was booked. Apologize briefly and ask ONLY for their phone number again, digit by digit. Do not ask for anything else.",
          "I'm sorry, I couldn't use that phone number. Could you please tell me your phone number again, digit by digit?",
        ),
        state: {
          ...state,
          phone: null,
          phoneSource: null,
          phoneIssue: "invalid",
          callerIdChoice: state.callerIdChoice === "accepted" ? "declined" : state.callerIdChoice,
          bookingStatus: "collecting",
        },
      };
    }
    return {
      spoken: await composeHonestBookingReply(
        session,
        errorCode === "CALENDAR_TIMEOUT"
          ? calendarErrorFacts("CALENDAR_TIMEOUT")
          : "The booking attempt failed on our end. Apologize briefly and say someone will follow up to confirm. Do not say it was booked.",
        errorCode === "CALENDAR_TIMEOUT"
          ? calendarErrorFallback("CALENDAR_TIMEOUT")
          : "I'm sorry, the booking attempt failed on our end. Someone will follow up to confirm.",
      ),
      state: { ...state, bookingStatus: "unavailable" },
    };
  }

  // The persisted booking is the source of truth for what gets confirmed:
  // an idempotent retry returns the ALREADY-created row (never a second
  // one), so its own start time is what the caller is told.
  const bookedData = (bookingResult?.["data"] ?? {}) as {
    id?: unknown;
    startAt?: unknown;
    status?: unknown;
  };
  // What the STORED booking says — never just "the tool call succeeded".
  // A result with no recognizable status is treated as not booked.
  const outcome: BookingOutcome =
    typeof bookingResult?.["bookingOutcome"] === "string"
      ? (bookingResult["bookingOutcome"] as BookingOutcome)
      : classifyBookingStatus(typeof bookedData.status === "string" ? bookedData.status : null);
  const confirmedStartIso = typeof bookedData.startAt === "string" ? bookedData.startAt : startIso;
  // confirmedLocalTime is spoken; bookedTime24h (24-hour "HH:mm", the shape
  // preferredTime is documented to hold and zonedWallTimeToUtc expects back)
  // is stored, so a later "that slot" reference still re-resolves correctly.
  const confirmedLocalTime = formatSlotTimeLocal(confirmedStartIso, timezone);
  const bookedTime24h = formatSlotTime24h(confirmedStartIso, timezone);
  const confirmedDateLabel = spokenDateLabel(
    formatSlotDateLocal(confirmedStartIso, timezone) ?? state.preferredDate,
    timezone,
  );
  const bookingId = typeof bookedData.id === "string" ? bookedData.id : null;
  const what = state.service ?? "appointment";
  const businessName = session.input.businessName;
  const englishReply =
    resolveResponseLanguage(
      session.detectedLanguage,
      session.input.snapshotAgent.primary_language,
    ) === "en-IN";

  if (outcome !== "confirmed") {
    log("booking_attempt_not_confirmed", session, { booking_id: bookingId, outcome });
    namedLog("calendar_tool:completed", session, { tool: "book_appointment", outcome });
    if (outcome === "saved_calendar_sync_failed") {
      // Saved in ClickAI and holding the slot, but its Google Calendar event
      // failed (CALENDAR_SYNC_FAILED, flagged for staff on the dashboard) —
      // accurate both ways: not "it failed", and not "confirmed".
      const savedText = `Your ${what} request at ${businessName} for ${confirmedDateLabel} at ${confirmedLocalTime} is saved, and our team will confirm it with you shortly. ${ANYTHING_ELSE_QUESTION}`;
      let saved = englishReply
        ? savedText
        : await composeHonestBookingReply(
            session,
            `The appointment request (${what} at ${businessName} on ${confirmedDateLabel} at ${confirmedLocalTime}) is SAVED, but it is NOT confirmed yet — the team will confirm it with the caller shortly. Say exactly that; do not say it is confirmed or booked. Then ask whether there is anything else you can help with.`,
            savedText,
          );
      if (!/anything else/i.test(saved)) saved = `${saved} ${ANYTHING_ELSE_QUESTION}`;
      return {
        spoken: saved,
        state: {
          ...state,
          preferredTime: bookedTime24h,
          wantsNextAvailable: false,
          bookingStatus: "booked",
          availabilityStatus: "unknown",
          selectedSlot: null,
        },
      };
    }
    const notConfirmedText =
      outcome === "pending"
        ? `I've passed on your request for ${confirmedDateLabel} at ${confirmedLocalTime}, but it isn't confirmed yet. Our team will confirm it with you shortly.`
        : "I'm sorry, I wasn't able to complete that booking. Someone will follow up to confirm.";
    return {
      spoken: englishReply
        ? notConfirmedText
        : await composeHonestBookingReply(
            session,
            outcome === "pending"
              ? "The appointment request was received but is NOT confirmed yet; the team will confirm it shortly. Do not say it is booked or confirmed."
              : "The booking was NOT completed. Apologize briefly and say someone will follow up. Do not say it was booked.",
            notConfirmedText,
          ),
      state: { ...state, bookingStatus: "unavailable" },
    };
  }

  log("booking_attempt_succeeded", session, { booking_id: bookingId });
  namedLog("calendar_tool:completed", session, { tool: "book_appointment" });
  const plainConfirmation = `You're all set — your ${what} at ${businessName} is confirmed for ${confirmedDateLabel} at ${confirmedLocalTime}. ${ANYTHING_ELSE_QUESTION}`;
  // English: spoken verbatim — the confirmation must state the real
  // service, business, date and time every time, and a second model round
  // trip here only added dead air after the booking had already succeeded.
  // Other languages are phrased by the model from the same facts.
  let confirmation = englishReply
    ? plainConfirmation
    : await composeHonestBookingReply(
        session,
        `The booking succeeded and is confirmed in the system: ${what} at ${businessName} for ${state.customerName ?? "the caller"} on ${confirmedDateLabel} at ${confirmedLocalTime}. Confirm the service, date and time in one short sentence, then ask whether there is anything else you can help with.`,
        plainConfirmation,
      );
  if (!/anything else/i.test(confirmation))
    confirmation = `${confirmation} ${ANYTHING_ELSE_QUESTION}`;
  return {
    spoken: confirmation,
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
 * Speaks the short pre-tool-call acknowledgement (skipped when the caller
 * already got an equivalent one immediately on this turn — see
 * immediateCallerAck) and performs the real deterministic dispatch,
 * returning the final spoken reply. Shared between handleUserUtterance's
 * two dispatch paths — the early, pre-LLM one (tryEarlyDeterministicDispatch)
 * and the normal, marker-driven one — so both speak identically and a
 * caller is never told the same thing twice in one turn regardless of
 * which path got there. Requires `session.appointmentState` already set
 * to the state this dispatch should act on (both call sites do this
 * immediately before calling here).
 *
 * `generation` is this turn's own generation number (captured in
 * enqueueUserUtterance's fast phase, before this call was ever reached) —
 * checked immediately before EACH speak() call below, never just once.
 * There is no cancellation signal in this codebase (see
 * handleUserUtterance's own comment on this honest limitation), so the
 * real attemptBooking/attemptAvailabilityCheck call below always runs to
 * completion and session.appointmentState is always updated with its
 * real outcome — the calendar operation genuinely happened and its
 * result must persist regardless of whether the caller has since moved
 * on. Only the SPOKEN half is conditional: returns `null` instead of the
 * composed reply whenever session.generation has moved past `generation`
 * by the time there's something to say, so a stale result from a turn
 * the caller has already interrupted or moved past can never reach TTS.
 */
async function dispatchDeterministicTool(
  session: Session,
  willAttemptBooking: boolean,
  completionTriggeredAvailability: boolean,
  immediateAckAlreadySpoken: boolean,
  generation: number,
): Promise<string | null> {
  const stillCurrent = () => session.generation === generation;
  if (willAttemptBooking) {
    // Production incident: real calendar+LLM round trips left the caller
    // in dead air long enough to say "hello? are you there?". A short,
    // immediate, honest acknowledgement — spoken BEFORE the slower real
    // operation, never claiming an outcome yet — fills that gap with
    // controlled sound instead of silence. Skipped when immediateCallerAck
    // already said the equivalent thing for this exact turn, or when this
    // turn has already gone stale before even getting this far.
    if (!immediateAckAlreadySpoken && stillCurrent()) {
      await speak(session, "Give me just a moment to confirm that.");
    }
    const outcome = await attemptBooking(session, generation);
    session.appointmentState = outcome.state;
    return stillCurrent() ? outcome.spoken : null;
  }

  // The completion transition gets its own consolidated message (names
  // what was just captured AND what's about to happen) — always spoken
  // even when a generic immediate ack already played, since it says
  // something genuinely new (the specific date/time/name), never the
  // same thing twice. The generic "Let me check that for you." is what
  // gets skipped when redundant with an equivalent immediate ack.
  let ack = "Let me check that for you.";
  if (completionTriggeredAvailability) {
    // "UTC" here is the same deliberate cosmetic-label tradeoff as
    // fieldTransitionAck (see its doc comment) — the REAL availability
    // check immediately below still resolves and uses the real business
    // timezone via resolveBookingContext. Doing it here too would be a
    // second, redundant lazy import spent on a label, right before the
    // real one is about to run anyway.
    const state = session.appointmentState;
    const dateLabel = state.preferredDate ? spokenDateLabel(state.preferredDate, "UTC") : null;
    const whenLabel = dateLabel
      ? `${dateLabel} at ${describeRequestedTime(state)}`
      : describeRequestedTime(state);
    ack = `Thanks${state.customerName ? `, ${state.customerName}` : ""}. I have everything I need. Let me check whether ${whenLabel} is available.`;
  }
  if ((completionTriggeredAvailability || !immediateAckAlreadySpoken) && stillCurrent()) {
    await speak(session, ack);
  }
  const outcome = await attemptAvailabilityCheck(session);
  session.appointmentState = outcome.state;
  return stillCurrent() ? outcome.spoken : null;
}

/**
 * Fix #1/#4 (move the deterministic dispatch decision earlier where
 * SAFE): decides whether THIS turn can be fully handled — a real
 * check_calendar_availability/book_appointment call, dispatched and
 * spoken — WITHOUT ever calling the Sarvam LLM at all, using only
 * `previous` (AppointmentState as of before this turn) and this turn's
 * deterministic extraction (parseCallerIntentFromText). Deliberately
 * narrow: service/customerName/email are NEVER set here (there is no
 * deterministic extractor for them — only the model's marker can read
 * free text like a service name), so this only ever fires when those
 * fields were ALREADY known from an EARLIER turn and this turn's own
 * extraction (an explicit date/time, or an explicit availability
 * question/booking confirmation against an already-complete slot) is
 * enough on its own to decide. That makes skipping the LLM call safe:
 * nothing about service/name is at risk of being lost, since neither one
 * is changing on this turn by definition. Any turn that doesn't meet this
 * bar falls through to the normal, marker-driven path unchanged — this
 * is a strictly additive fast path, never a replacement of the general
 * mechanism.
 *
 * Returns `dispatched: false` when not applicable (the overwhelmingly
 * common case), letting handleUserUtterance proceed exactly as before —
 * still carrying `extractedDate`/`matchedServiceName`, so the normal
 * marker-driven path that ALSO needs this same relativeDate/weekday
 * resolution and configured-services lookup can reuse them instead of
 * paying for a second round trip on the same turn.
 *
 * `generation` (this turn's own, captured in enqueueUserUtterance's fast
 * phase) is threaded straight through to dispatchDeterministicTool —
 * see its own doc comment for the staleness suppression that provides.
 *
 * Deterministic SERVICE matching (item 2 — production gap: "General
 * checkup, and let me know if that slot is free or not." dispatched an
 * early availability check with service still null, silently defaulting
 * to a 30-minute slot regardless of what the business actually
 * configured for a general checkup): whenever `previous.service` is
 * still unknown, this also scans the caller's raw text for any
 * configured service's name (matchServiceInText) and feeds a match into
 * the same preview, using the SAME marker-wins-fills-gap priority as
 * date/time — a service name is something the model generally gets
 * right once it hears it, so this exists only to catch the one turn the
 * caller just named it, before any marker has had a chance to.
 */
async function tryEarlyDeterministicDispatch(
  session: Session,
  previous: AppointmentState,
  callerIntent: CallerIntentSignals,
  immediateAckAlreadySpoken: boolean,
  generation: number,
  text: string,
): Promise<
  | { dispatched: true; spoken: string | null }
  | { dispatched: false; extractedDate: string | null; matchedServiceName: string | null }
> {
  // Production incident (found via this round's own regression test for
  // the exact reported sequence): "Yeah, please confirm. Also, can you
  // remind me at tomorrow at 1 p.m. that I have an appointment?" — the
  // caller's OWN explicit time here is about the REMINDER, not the
  // appointment, but a plain date/time regex has no way to tell the two
  // apart. The MARKER-driven path is protected from this because the
  // marker (even an "unreliable" one) still independently states its own
  // preferred_time, which wins over extraction regardless — but this
  // early, marker-less preview has nothing to defer to, so a reminder
  // mentioned in the same breath would otherwise silently clobber the
  // caller's already-confirmed appointment time with the reminder's time.
  // Fix: when a reminder is also detected this turn, never let this
  // turn's own date/time extraction move the preview at all — fall back
  // to whatever was already known (current/sticky), exactly as if this
  // turn's own extraction had found nothing.
  const dateTimeIsAmbiguous = callerIntent.reminderRequested;
  const needsTimezone =
    !dateTimeIsAmbiguous && Boolean(callerIntent.relativeDate || callerIntent.weekday);
  const needsServices = previous.service === null;
  // Only actually fetched when not already cached on the session (see
  // session.cachedServices's own doc comment) — the configured list is
  // the same for every turn of this call, so a turn that repeats
  // needsServices=true (the caller still hasn't named their service)
  // after the FIRST such turn reuses the cached list instead of paying
  // for the DB round trip again.
  const needsServicesFetch = needsServices && session.cachedServices === null;
  let extractedDate: string | null = null;
  let matchedServiceName: string | null = null;
  if (needsTimezone || needsServicesFetch) {
    const ctx = await resolveDeterministicExtractionContext(
      session.input.businessId,
      needsTimezone,
      needsServicesFetch,
    );
    if (needsTimezone) {
      const timezone = ctx.timezone ?? "UTC";
      extractedDate = callerIntent.relativeDate
        ? resolveRelativeDateInTimezone(callerIntent.relativeDate, timezone)
        : resolveWeekdayInTimezone(callerIntent.weekday!, timezone);
    }
    if (needsServicesFetch) {
      if (ctx.services) {
        session.cachedServices = ctx.services;
      } else {
        // Left uncached so the next turn reads the catalog again. Only the
        // error code is logged — no caller speech or service data.
        log("services_catalog_unavailable", session, { code: ctx.servicesError });
      }
    }
  }
  if (needsServices) {
    // The caller's own words, mapped onto the configured services
    // (service-matching.ts) — "clean my teeth" now finds "Teeth Cleaning".
    // A tie between services is remembered so the clarification can ask
    // "A or B?" instead of the generic question.
    const resolution = resolveServiceFromText(session.cachedServices ?? [], text);
    if (resolution.kind === "match") matchedServiceName = resolution.row.name.trim();
    else if (resolution.kind === "ambiguous") session.serviceCandidates = resolution.candidates;
  }
  // `proposed: null` is deliberate — this preview reflects ONLY what's
  // deterministically extractable this turn, never anything a marker
  // might have said (there is no marker yet; nothing has called the LLM).
  let preview = mergeAppointmentState(previous, null, {
    preferredDate: extractedDate,
    preferredTime: dateTimeIsAmbiguous ? null : callerIntent.explicitTime,
    phone: callerIntent.phone,
    phoneMentioned: callerIntent.phoneMentioned,
    phoneCountry: session.input.businessCountry ?? null,
    email: callerIntent.email,
    service: matchedServiceName,
  });

  // Mirrors handleUserUtterance's own marker-driven backstops exactly,
  // just evaluated against the deterministic preview instead of the
  // (not-yet-available) merged-with-marker state.
  if (
    callerIntent.availabilityRequested &&
    preview.bookingStatus !== "ready_to_book" &&
    preview.preferredDate
  ) {
    preview = {
      ...preview,
      preferredPeriod: preview.preferredPeriod ?? callerIntent.preferredPeriod,
      wantsNextAvailable: preview.wantsNextAvailable || callerIntent.wantsNextAvailable,
      bookingStatus: "checking_availability",
    };
  }
  if (
    callerIntent.bookingConfirmed &&
    preview.bookingStatus !== "ready_to_book" &&
    preview.preferredDate &&
    (preview.preferredTime || preview.wantsNextAvailable)
  ) {
    preview = { ...preview, bookingStatus: "ready_to_book" };
  }
  const wasReadyForAvailability = appointmentReadyForAvailabilityCheck(previous);
  const completionTriggeredAvailability =
    !wasReadyForAvailability &&
    appointmentReadyForAvailabilityCheck(preview) &&
    preview.bookingStatus !== "ready_to_book";
  if (completionTriggeredAvailability) {
    preview = { ...preview, bookingStatus: "checking_availability" };
  }

  const willAttemptBooking =
    preview.bookingStatus === "ready_to_book" && appointmentStateIsComplete(preview);
  const willCheckAvailability =
    !willAttemptBooking &&
    preview.bookingStatus === "checking_availability" &&
    appointmentSlotIsKnown(preview);
  if (!willAttemptBooking && !willCheckAvailability) {
    return { dispatched: false, extractedDate, matchedServiceName };
  }

  session.appointmentState = preview;
  namedLog("voice:early_deterministic_dispatch", session, {
    willAttemptBooking,
    willCheckAvailability,
    completionTriggeredAvailability,
  });
  const spoken = await dispatchDeterministicTool(
    session,
    willAttemptBooking,
    completionTriggeredAvailability,
    immediateAckAlreadySpoken,
    generation,
  );
  return { dispatched: true, spoken };
}

/**
 * Entry point for a final transcript (onSttEvent's "final_transcript"
 * case calls this instead of handleUserUtterance directly). Splits each
 * turn into two independently-scheduled phases:
 *
 * 1. FAST phase — run synchronously right here, before anything is
 *    queued. Computes and speaks the deterministic immediateCallerAck,
 *    if any — see its own doc comment for exactly what it covers —
 *    through the lightweight session.immediateAckQueue, NEVER
 *    session.utteranceQueue. This is the production fix for "a new
 *    caller utterance must not be forced to wait for a previous slow
 *    calendar/LLM operation to finish before it gets its own immediate
 *    acknowledgement". The ack needs no staleness protection of its own:
 *    nothing can be more current than the turn that was JUST accepted,
 *    so it's simply spoken, synchronously-triggered, right here.
 * 2. SLOW phase (handleUserUtterance) — marker merge,
 *    tryEarlyDeterministicDispatch, getReply, tool dispatch. Still fully
 *    serialized via session.utteranceQueue, deliberately UNCHANGED: this
 *    is what prevents two bookings or two calendar checks from ever
 *    running concurrently, AND is what makes `session.generation`'s bump
 *    meaningful (still done inside handleUserUtterance itself, exactly
 *    as before — see its own comment). Moving that bump OUT here too was
 *    tried and reverted: it broke the "two final_transcript events
 *    arriving close together, no actual barge-in in between" case — both
 *    utterances deserve a real reply, but bumping generation at enqueue
 *    time (unserialized) made the FIRST one's own in-flight reply look
 *    "stale" the instant the second was merely ACCEPTED, before the
 *    first's turn in the queue had even finished. Only the fast ack
 *    moved out of the queue; generation's bump-and-compare semantics
 *    stay exactly where — and exactly when — they always were.
 *
 * session.immediateAckQueue exists only to stop two rapid-fire immediate
 * acks' own speak() calls from interleaving each other (speak() has one
 * await suspension point before its synchronous chunk-sending loop) — it
 * is NOT a second copy of utteranceQueue's booking/TTS-race protection,
 * which the slow phase above still owns in full.
 */
function enqueueUserUtterance(session: Session, text: string) {
  const immediateAck = session.deps.generateReplyWithTools
    ? null
    : immediateCallerAck(session.appointmentState, parseCallerIntentFromText(text));
  if (immediateAck) {
    session.immediateAckQueue = session.immediateAckQueue.then(() =>
      speak(session, immediateAck).catch((err: unknown) => {
        log("immediate_ack_error", session, { message: (err as Error).message });
      }),
    );
  }
  session.utteranceQueue = session.utteranceQueue.then(() =>
    handleUserUtterance(session, text, immediateAck).catch((err: unknown) => {
      log("utterance_queue_error", session, { message: (err as Error).message });
    }),
  );
}

async function handleUserUtterance(session: Session, text: string, immediateAck: string | null) {
  session.turns.push({ role: "user", text, at: new Date().toISOString() });
  // Deterministic backstop over the caller's own raw words — see
  // parseCallerIntentFromText's own doc comment for the production
  // incident this responds to (the model's own marker emission is not
  // reliably followed every turn). Computed once, up front, so both the
  // pre-reply system-message grounding below (reminders) and the
  // post-reply state enrichment further down use the exact same read of
  // this turn's caller text. Recomputed here (enqueueUserUtterance's fast
  // phase already computed its own copy for immediateCallerAck) rather
  // than threaded through — it's a pure, cheap regex pass, and threading
  // it would only save that.
  let callerIntent = parseCallerIntentFromText(text);
  // The answer to CALLER_ID_QUESTION, when it's pending — applied before
  // anything else reads appointment state this turn, so the early
  // deterministic dispatch, the model's grounding message, and the booking
  // attempt all see the caller's choice (and never ask for the number
  // again once it's settled). See resolveCallerIdAnswer.
  const callerIdAnswer = resolveCallerIdAnswer(
    text,
    session.appointmentState,
    session.callerId,
    session.input.businessCountry ?? null,
  );
  if (callerIdAnswer) {
    // Smile Dental incident: the caller's "Yes" to "may I use the number
    // you're calling from?" was also read as "yes, book it" — with the date
    // and time already known that made the turn ready_to_book, and with no
    // service yet the runtime asked "Which service would you like to book?"
    // instead of continuing. A yes/no to the caller-ID question is only an
    // answer to that question unless the caller explicitly asks to book.
    if (callerIntent.bookingConfirmed && !/\bbook/i.test(text)) {
      callerIntent = { ...callerIntent, bookingConfirmed: false };
    }
    session.appointmentState = { ...session.appointmentState, ...callerIdAnswer };
    log("caller_id_answer", session, {
      choice: callerIdAnswer.callerIdChoice,
      phone_selected: Boolean(callerIdAnswer.phone),
      phone_issue: callerIdAnswer.phoneIssue ?? null,
    });
  }
  // The caller's name from their own words, when not already known — the
  // model's state block does not reliably carry it (see extractCallerName).
  if (!session.appointmentState.customerName) {
    const lastAgentTurn = [...session.turns].reverse().find((t) => t.role === "assistant");
    const agentAskedForName = Boolean(
      lastAgentTurn && NAME_QUESTION_PATTERN.test(lastAgentTurn.text),
    );
    const name = extractCallerName(text, agentAskedForName);
    if (name) {
      session.appointmentState = { ...session.appointmentState, customerName: name };
      log("caller_name_captured", session, { asked: agentAskedForName });
    }
  }
  // Captured HERE — not reused from enqueueUserUtterance's fast-phase
  // read — because this turn's place in utteranceQueue means a PREVIOUS
  // turn's slow-phase work (e.g. a booking/availability outcome) may have
  // mutated session.appointmentState in the gap between this utterance
  // being accepted and this turn actually starting. The early-dispatch
  // fast path and the rest of this turn both need "what's true right
  // now", not a possibly-stale snapshot from before this turn's own place
  // in the queue was reached.
  const previousAppointmentState = session.appointmentState;
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
  // Bumped HERE — still gated by utteranceQueue, exactly as before this
  // round's changes — see enqueueUserUtterance's own doc comment for why
  // this must NOT move any earlier.
  const generation = ++session.generation;
  const requestStarted = Date.now();
  const llmRequestAt = requestStarted;

  // The caller is wrapping up — "bye", "hang up", "that's all", or a plain
  // "no, thanks" right after the agent asked whether there's anything else
  // (after a booking, an answered enquiry, or any other completed request).
  // A deterministic closing, then a provider hang-up once it has finished
  // playing (finishCall). No LLM round trip, so nothing can re-open the
  // conversation or repeat a question. A turn that also carries a new
  // request ("thanks — what time do you close?") is never a closing.
  const lastAgentText =
    [...session.turns].reverse().find((t) => t.role === "assistant")?.text ?? "";
  const closingIntent = classifyCallerClosingIntent(text, {
    awaitingAnythingElse:
      session.callCompletion === "awaiting_anything_else" || agentAskedAnythingElse(lastAgentText),
    hasNewRequest: Boolean(
      callerIntent.availabilityRequested ||
      callerIntent.explicitTime ||
      callerIntent.relativeDate ||
      callerIntent.weekday,
    ),
  });
  if (closingIntent && closingIntent !== "human_requested") {
    log("caller_closing_intent", session, { intent: closingIntent });
    await endConversationGracefully(
      session,
      generation,
      closingIntent === "hangup_request" ? "caller_requested_hangup" : "caller_closed_conversation",
      closingMessageFor(text, session.input.businessName),
    );
    return;
  }
  if (closingIntent === "human_requested") {
    // No live transfer exists in this runtime (policy.humanHandoffAvailable
    // is reserved for when one does) — say so honestly and keep helping.
    log("human_handoff_requested", session, {
      handoff_available: session.policy.humanHandoffAvailable,
    });
    await speakRuntimeTurnReply(session, generation, CLOSING_MESSAGES.humanUnavailable, {
      awaitAnythingElse: true,
    });
    return;
  }
  // The caller carried on with a real request: the conversation is open
  // again until the agent next asks whether there's anything else.
  if (session.callCompletion === "awaiting_anything_else") session.callCompletion = "none";
  session.farewellSpoken = false;

  // The runtime's own ground truth for what the caller has already
  // confirmed — see AppointmentState's own doc comment. Built from state
  // BEFORE this turn, so the model is told what's already known without
  // depending on it still being visible in the (bounded)
  // CONVERSATION_HISTORY_TURNS window.
  const knownAppointmentState = describeKnownAppointmentState(
    session.appointmentState,
    session.callerId ? phoneLastFour(session.callerId) : null,
  );
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
      // Fix #1/#4: try the fully-deterministic fast path FIRST — when it
      // applies, this turn is handled (and spoken) without ever calling
      // Sarvam at all. See tryEarlyDeterministicDispatch's own doc comment
      // for exactly when this is safe. Deliberately gated on the SAME
      // condition as the marker-based backstop further down
      // (`!usedToolCalling`, see its own comment): when the session is
      // configured for native AI tool-calling (generateReplyWithTools —
      // currently only Claude, not Sarvam, but the code supports it), the
      // MODEL decides which tool to call and with what arguments, and
      // this deterministic fast path must never preempt that decision by
      // guessing it can act first from AppointmentState heuristics alone.
      const early = session.deps.generateReplyWithTools
        ? ({ dispatched: false, extractedDate: null, matchedServiceName: null } as const)
        : await tryEarlyDeterministicDispatch(
            session,
            previousAppointmentState,
            callerIntent,
            Boolean(immediateAck),
            generation,
            text,
          );
      let reply: string;
      let enteredPaymentWait = false;
      let toolDispatched = early.dispatched;
      let usedToolCallingThisTurn = false;
      let bookedViaTool = false;
      let toolBookingOutcome: BookingOutcome | null = null;
      if (early.dispatched) {
        if (isCancelled() || generation !== session.generation || early.spoken === null) {
          log("llm_response_discarded_stale", session, { early: true });
          return;
        }
        reply = early.spoken;
      } else {
        const {
          reply: rawReply,
          enteredPaymentWait: epw,
          usedToolCalling,
          bookedViaTool: booked,
          toolBookingOutcome: outcome,
        } = await getReply(session, messages);
        enteredPaymentWait = epw;
        usedToolCallingThisTurn = usedToolCalling;
        bookedViaTool = booked;
        toolBookingOutcome = outcome;
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
        reply = rawReply;
        if (!usedToolCalling) {
          // Strip and parse the trailing structured appointment-state block
          // (see parseApptStateMarker/APPT_STATE_MARKER) — spokenText is what
          // the caller actually hears; the marker itself never reaches TTS or
          // the persisted transcript.
          const { spokenText, state: markerState } = parseApptStateMarker(rawReply);
          const proposedAppointmentState = canonicalizeProposedService(session, markerState);
          log(
            "appt_state_marker",
            session,
            apptStateMarkerDiagnostic(rawReply, markerState, proposedAppointmentState),
          );

          // Deterministic date/time extraction over the caller's own raw
          // words (production incident: an explicit "tomorrow at 3 PM" /
          // "3 PM tomorrow" / "Friday at 4:30" / "next Monday morning" was
          // sometimes dropped, or nulled out by an incomplete marker, rather
          // than reliably reaching AppointmentState). Resolved to an actual
          // date from whichever of relativeDate/weekday the caller actually
          // said (relativeDate preferred on the rare chance both appear) —
          // only ever FILLS IN what the marker leaves unset this turn, same
          // backstop discipline as mergeAppointmentState's own doc comment
          // describes. Reused from `early` (tryEarlyDeterministicDispatch
          // already resolved this exact same relativeDate/weekday for its
          // own preview, when applicable) rather than recomputed here — a
          // second resolveBusinessTimezone lookup on the same turn for the
          // same answer would be pure waste, and previously pushed several
          // tests' drain() budgets past their limit. Phone/email are also
          // extracted here (callerIntent.phone/email) — see
          // mergeAppointmentState's doc comment for why those two take the
          // OPPOSITE priority (extraction over the marker, not just filling
          // its gaps).
          const extractedDate = early.extractedDate;
          // Same reuse reasoning as extractedDate just above, for
          // matchServiceInText's own configured-services lookup — see
          // tryEarlyDeterministicDispatch's doc comment.
          const matchedServiceName = early.matchedServiceName;
          // Same reminder-ambiguity guard as tryEarlyDeterministicDispatch
          // (see its own doc comment) — a time mentioned for an unrelated
          // reminder in the same breath must never be fed in as the
          // appointment's own preferredTime. The marker normally protects
          // against this anyway (it wins over extraction here), but this
          // keeps the fallback-when-the-marker-itself-omits-it case safe
          // too, rather than relying on the marker always being reliable.
          let appointmentState = mergeAppointmentState(
            previousAppointmentState,
            proposedAppointmentState,
            {
              preferredDate: extractedDate,
              preferredTime: callerIntent.reminderRequested ? null : callerIntent.explicitTime,
              phone: callerIntent.phone,
              phoneMentioned: callerIntent.phoneMentioned,
              phoneCountry: session.input.businessCountry ?? null,
              email: callerIntent.email,
              service: matchedServiceName,
            },
          );

          // Deterministic backstop (production incident: the model's marker
          // did not reliably propose checking_availability/ready_to_book every
          // turn it should have — see parseCallerIntentFromText's own doc
          // comment). Only ever FILLS IN what the marker left unset, or
          // escalates bookingStatus the marker should have proposed — never
          // overrides a value the marker DID set this turn. preferredDate is
          // already resolved above (from the marker, or the extraction
          // backstop) by the time this runs.
          if (
            callerIntent.availabilityRequested &&
            appointmentState.bookingStatus !== "ready_to_book" &&
            appointmentState.preferredDate
          ) {
            appointmentState = {
              ...appointmentState,
              preferredPeriod: appointmentState.preferredPeriod ?? callerIntent.preferredPeriod,
              wantsNextAvailable:
                appointmentState.wantsNextAvailable || callerIntent.wantsNextAvailable,
              bookingStatus: "checking_availability",
            };
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
          // Production incident: a real call collected service, name, date,
          // AND time — every field appointmentReadyForAvailabilityCheck
          // requires — then asked for phone/email before ever checking the
          // calendar; the caller supplied phone/email and the agent merely
          // said "I'm checking availability now" with no real tool call
          // behind it, because nothing dispatched on the fields becoming
          // complete and the caller never asked an explicit availability
          // question or said an explicit "yes" in that exact turn. This
          // fires the INSTANT the four required fields become complete —
          // independent of the model's marker, an explicit "yes", or an
          // explicit "is it available?" — never on a later turn where they
          // were already complete (wasReadyForAvailability guards that).
          const wasReadyForAvailability =
            appointmentReadyForAvailabilityCheck(previousAppointmentState);
          const completionTriggeredAvailability =
            !wasReadyForAvailability &&
            appointmentReadyForAvailabilityCheck(appointmentState) &&
            appointmentState.bookingStatus !== "ready_to_book";
          if (completionTriggeredAvailability) {
            appointmentState = { ...appointmentState, bookingStatus: "checking_availability" };
          }
          session.appointmentState = appointmentState;
          if (appointmentState.service) session.serviceQuestionCount = 0;

          reply = spokenText;

          // Resolved once, up front, so the state-aware-acknowledgement block
          // below can skip its own work entirely on a turn that's about to
          // dispatch a real tool call anyway — `reply` gets replaced wholesale
          // by that outcome's own composed text, so computing (and awaiting)
          // an acknowledgement first would just be discarded latency for no
          // benefit, re-introducing exactly the extra-lazy-import timing cost
          // this file has repeatedly had to tune drain()s around before.
          const willAttemptBooking =
            session.appointmentState.bookingStatus === "ready_to_book" &&
            appointmentStateIsComplete(session.appointmentState);
          const willCheckAvailability =
            !willAttemptBooking &&
            session.appointmentState.bookingStatus === "checking_availability" &&
            appointmentSlotIsKnown(session.appointmentState);

          // State-aware acknowledgement (never a generic filler before every
          // LLM call — see fieldTransitionAck's own doc comment): prepended,
          // never replacing the model's own reply, and skipped entirely when
          // the model's own wording already reads as an acknowledgement, OR
          // when the immediate pre-LLM ack already said something this turn
          // (see immediateCallerAck — never two deterministic acks back to
          // back), so the caller is never told the same thing twice. English
          // only; a non-English/code-mixed reply is left exactly as the
          // model wrote it.
          if (
            !immediateAck &&
            !willAttemptBooking &&
            !willCheckAvailability &&
            resolveResponseLanguage(
              session.detectedLanguage,
              session.input.snapshotAgent.primary_language,
            ) === "en-IN"
          ) {
            const ack = fieldTransitionAck(previousAppointmentState, appointmentState);
            if (ack && !replyAlreadyAcknowledges(reply, appointmentState.customerName)) {
              reply = `${ack} ${reply}`;
            }
          }
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
          if (willAttemptBooking || willCheckAvailability) {
            toolDispatched = true;
            const dispatched = await dispatchDeterministicTool(
              session,
              willAttemptBooking,
              completionTriggeredAvailability,
              Boolean(immediateAck),
              generation,
            );
            if (dispatched === null) {
              log("llm_response_discarded_stale", session, { afterDispatch: true });
              return;
            }
            reply = dispatched;
          }
        }
      }

      const isEnglish =
        resolveResponseLanguage(
          session.detectedLanguage,
          session.input.snapshotAgent.primary_language,
        ) === "en-IN";
      if (isEnglish && !toolDispatched && !usedToolCallingThisTurn) {
        reply = applyTargetedClarification(session, reply, callerIntent, callerIdAnswer);
      }

      // Native tool-calling path: the model's own words must agree with the
      // stored booking. A reply claiming a booking the outcome doesn't
      // support is replaced with the deterministic outcome sentence.
      if (
        isEnglish &&
        toolBookingOutcome !== null &&
        toolBookingOutcome !== "confirmed" &&
        claimsBookingSuccess(reply)
      ) {
        log("tool_reply_overclaimed_booking", session, { outcome: toolBookingOutcome });
        reply = toolBookingOutcomeSentence(toolBookingOutcome);
      }

      if (!reply) {
        log("llm_empty_reply", session, {
          after_tool: toolDispatched || usedToolCallingThisTurn,
        });
        // An empty reply must never become silence after a tool call: the
        // caller gets the real outcome (if a booking ran) or a short,
        // honest retry prompt. Mid-booking without a tool call, ask for the
        // one detail still needed; otherwise keep the previous behavior.
        const fallbackQuestion =
          toolBookingOutcome !== null
            ? toolBookingOutcomeSentence(toolBookingOutcome)
            : toolDispatched || usedToolCallingThisTurn
              ? TOOL_TURN_FALLBACK
              : isEnglish && appointmentInProgress(session.appointmentState)
                ? nextMissingDetailQuestion(session.appointmentState)
                : null;
        if (!fallbackQuestion) {
          setState(session, "listening");
          armSilenceTimer(session);
          return;
        }
        reply = fallbackQuestion;
      }

      // Caller ID is usable and the phone number is being requested for the
      // first time — make sure it's asked as CALLER_ID_QUESTION (English
      // replies only; the question itself is English), and mark it offered
      // so the caller's next turn is read as the answer.
      if (isEnglish) {
        const guarded = guardPhoneRequests(reply, session.appointmentState);
        if (guarded.changed) {
          log("phone_request_guarded", session, {
            phone_known: Boolean(session.appointmentState.phone),
          });
          reply = guarded.reply;
        }
        const offer = applyCallerIdOffer(reply, session.appointmentState);
        if (offer.offered) {
          reply = offer.reply;
          session.appointmentState = { ...session.appointmentState, callerIdChoice: "offered" };
        }
      }

      // A confirmed booking from the native tool-calling path gets the same
      // closing question the deterministic path's confirmation carries.
      if (bookedViaTool && !/anything else/i.test(reply)) {
        reply = `${reply} ${ANYTHING_ELSE_QUESTION}`;
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

      reply = guardRepeatedReply(session, reply);
      session.turns.push({ role: "assistant", text: reply, at: new Date().toISOString() });
      await speak(session, reply);
      session.consecutiveTurnErrors = 0;
      // The conversation has reached a natural end point: a booking was
      // really confirmed this turn (deterministic path: attemptBooking
      // reported "booked"; tool-calling path: book_appointment succeeded),
      // or the agent asked whether there's anything else / said goodbye
      // (an answered enquiry, a completed request of any kind). From here a
      // closing reply or continued silence ends the call cleanly (see
      // classifyCallerClosingIntent / armSilenceTimer) instead of looping
      // on "are you still there?". A follow-up question re-opens it.
      session.farewellSpoken = agentSaidGoodbye(reply);
      if (
        (toolDispatched && session.appointmentState.bookingStatus === "booked") ||
        bookedViaTool ||
        agentAskedAnythingElse(reply) ||
        session.farewellSpoken
      ) {
        session.callCompletion = "awaiting_anything_else";
      }
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
      // Bounded: after policy.consecutiveErrorLimit failed turns in a row
      // (LLM, TTS or unexpected errors), the call is ended safely with a
      // deterministic apology rather than apologising forever.
      session.consecutiveTurnErrors++;
      if (session.consecutiveTurnErrors >= session.policy.consecutiveErrorLimit) {
        log("consecutive_turn_errors_limit", session, {
          count: session.consecutiveTurnErrors,
          errorCategory,
        });
        await finishCall(session, {
          reason: "repeated_turn_errors",
          message: CLOSING_MESSAGES.repeatedErrors,
          generation: session.generation,
        });
        return;
      }
      await speakFallback(session, err, "llm_error");
      setState(session, "listening");
      armSilenceTimer(session);
    }
  }
}

/**
 * Breaks a repetition loop: when the agent is about to say the same reply
 * for the policy.repeatedReplyLimit-th time in a row, it instead offers an
 * alternative and asks whether there's anything else (so a closing reply
 * or silence can end the call). Never changes a reply said fewer times.
 */
function guardRepeatedReply(session: Session, reply: string): string {
  const norm = normalizeReplyForRepeat(reply);
  if (!norm) return reply;
  session.repeatedReplyCount = norm === session.lastReplyNorm ? session.repeatedReplyCount + 1 : 1;
  session.lastReplyNorm = norm;
  if (session.repeatedReplyCount < session.policy.repeatedReplyLimit) return reply;
  log("repeated_reply_limit", session, { count: session.repeatedReplyCount });
  session.repeatedReplyCount = 0;
  session.lastReplyNorm = normalizeReplyForRepeat(CLOSING_MESSAGES.repeatedQuestion);
  return CLOSING_MESSAGES.repeatedQuestion;
}

/**
 * Speaks a runtime-composed reply as this turn's answer (no LLM involved),
 * then returns to listening — the same ending every handleUserUtterance
 * path uses. `awaitAnythingElse`: the reply asked whether there's anything
 * else, so a closing reply or silence may end the call next.
 */
async function speakRuntimeTurnReply(
  session: Session,
  generation: number,
  text: string,
  opts: { awaitAnythingElse: boolean },
): Promise<void> {
  session.turns.push({ role: "assistant", text, at: new Date().toISOString() });
  try {
    await speak(session, text);
  } catch (err) {
    log("runtime_reply_failed", session, { message: (err as Error).message });
  }
  if (generation !== session.generation) return;
  if (opts.awaitAnythingElse) session.callCompletion = "awaiting_anything_else";
  setState(session, "listening");
  armSilenceTimer(session);
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
        session.outboundPlayoutEndsAt = 0;
        session.tts?.flush();
        // The interrupted audio will never be heard: nothing is in flight.
        session.ttsChunksFlushed = session.ttsChunksSent;
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
        // Length only — never the caller's words (see log()'s doc comment).
        log("duplicate_final_transcript_ignored", session, { textLength: event.text.length });
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
        // Greeting latency, measured: the call's first audio is the
        // greeting. From telephony routing starting (shortly after the
        // provider's answer webhook) and from this runtime starting.
        const firstAudioAt = Date.now();
        log("greeting_first_audio", session, {
          ms_since_runtime_start: firstAudioAt - session.startedAt,
          ms_since_routing_start:
            session.input.routingStartedAt !== undefined
              ? firstAudioAt - session.input.routingStartedAt
              : null,
          ms_since_tts_connected:
            session.ttsConnectedAt !== null ? firstAudioAt - session.ttsConnectedAt : null,
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
      session.ttsLastAudioAt = Date.now();
      session.ttsAudioSinceSend = true;
      const frame: AudioFrame = { data: event.data, timestampMs: Date.now() - session.startedAt };
      session.input.bridge.sendOutboundFrame(frame);
      // Playout estimate for waitForFinalAudio: the provider plays frames in
      // real time, so each one extends "audio still playing" by its own
      // duration (8-bit mu-law/a-law = 1 byte/sample, linear16 = 2).
      {
        const format = session.input.bridge.outboundFormat;
        const bytesPerSample =
          format.encoding === "linear16" ? 2 : format.encoding === "opus" ? 0 : 1;
        if (bytesPerSample > 0 && format.sampleRateHz > 0) {
          const frameMs = (event.data.length / bytesPerSample / format.sampleRateHz) * 1000;
          session.outboundPlayoutEndsAt =
            Math.max(Date.now(), session.outboundPlayoutEndsAt) + frameMs;
        }
      }
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
      // Never beyond what was sent (a barge-in's extra flush, or chunks
      // already discarded, must not make later audio look delivered).
      session.ttsChunksFlushed = Math.min(session.ttsChunksFlushed + 1, session.ttsChunksSent);
      // Requested diagnostic naming (distinct from the voice_runtime:*
      // namespace) — pairs with tts:start above: fires once THIS speak()
      // call's audio has fully played out (ttsAudioInFlight false again),
      // not per-chunk, so a single log line per utterance (not per flush
      // event) actually answers "how long did synthesis+delivery take".
      if (ttsSynthesisComplete(session)) {
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
        ttsSynthesisComplete(session)
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
      if (ttsSynthesisComplete(session) && isAwaitingCaller(stateOf(session))) {
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
  const callerId = normalizeCallerId(input.callerNumber, input.businessCountry ?? null);
  const session: Session = {
    handle,
    callerId,
    outboundPlayoutEndsAt: 0,
    callCompletion: "none",
    policy: resolveCallLifecyclePolicy(input.lifecyclePolicy),
    farewellSpoken: false,
    consecutiveTurnErrors: 0,
    lastReplyNorm: null,
    repeatedReplyCount: 0,
    providerHangup: null,
    closingBridge: false,
    terminationStarted: false,
    maxDurationTimer: null,
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
    ttsLastSendAt: 0,
    ttsLastAudioAt: 0,
    ttsAudioSinceSend: false,
    ttsCompletionFallbackLogged: false,
    declaredTtsOutputCodec: null,
    declaredTtsOutputSampleRateHz: null,
    firstOutboundAudioFrameLogged: false,
    activeSpeechGeneration: 0,
    staleAudioDropLogged: false,
    utteranceQueue: Promise.resolve(),
    immediateAckQueue: Promise.resolve(),
    cachedServices: input.services ?? null,
    serviceQuestionCount: 0,
    serviceCandidates: null,
    unmatchedServiceRequest: null,
    appointmentState: {
      ...emptyAppointmentState(),
      callerIdChoice: callerId ? "not_offered" : "unavailable",
    },
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
  // Presence only — never the number itself (see this file's logging rule
  // in log()'s own doc comment). "provided" distinguishes a webhook that
  // sent nothing from one that sent a withheld/malformed value.
  armMaxDurationTimer(session);
  log("runtime_started", session, {
    caller_id_provided: Boolean(input.callerNumber),
    caller_id_usable: Boolean(callerId),
  });

  input.bridge.onClose((reason) => {
    log("bridge_closed", session, { reason, by_runtime: session.closingBridge });
    if (session.closingBridge) {
      // The runtime closed it itself (a finished call, or the provider's
      // call-ended webhook already terminated the session) — nothing more.
      void terminateRuntimeSession(input.callId, `bridge closed: ${reason}`);
      return;
    }
    // The media connection closed without the runtime ending the call: the
    // caller hung up, the provider ended the stream, or the connection
    // dropped. The session is torn down at once (stops listening,
    // generation and any in-flight tool work; nothing is spoken — there is
    // no audio path left). Closing the stream does not by itself end the
    // phone call (Vobiz's <Stream> uses keepCallAlive), so unless the
    // provider confirms the call ended (its call-ended webhook, within
    // policy.mediaCloseHangupGraceMs), it is asked to hang up — once, and a
    // call that has already ended is not an error.
    void (async () => {
      await terminateRuntimeSession(input.callId, `bridge closed: ${reason}`);
      await new Promise((resolve) => setTimeout(resolve, session.policy.mediaCloseHangupGraceMs));
      if (providerReportedCallEnded(input.callId)) {
        log("media_closed_call_already_ended", session, { reason });
        return;
      }
      await requestProviderHangup(session, "media_connection_closed");
    })();
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

  // Greeting latency: the greeting starts as soon as TTS is connected — it
  // no longer also waits for STT. Nothing the caller says is lost while STT
  // is still connecting: every inbound frame is buffered (pendingInboundFrames,
  // registered above) and flushed into STT the moment it connects. If STT
  // then fails, the caller hears an honest apology and the call is ended,
  // exactly as before — just after the greeting instead of instead of it.
  const [ttsOutcome] = await Promise.allSettled([ttsConnectPromise]);

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

  /** Applies STT's connect outcome (connected: flush the buffered audio). */
  const applySttOutcome = (sttOutcome: PromiseSettledResult<SttSession>) => {
    // The session already ended while STT was connecting (the greeting
    // failed, the caller hung up): close the late connection, never leak it.
    if (session.terminationStarted) {
      if (sttOutcome.status === "fulfilled") {
        try {
          sttOutcome.value.close();
        } catch {
          /* best-effort */
        }
      }
      return;
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
  };

  /**
   * Either connection failing is fatal to the session: a working TTS
   * session speaks an honest apology first if STT is what failed (there is
   * nothing to speak with if TTS failed), then the phone call itself is
   * ended — closing the media stream alone does not hang up (Vobiz
   * keepCallAlive). Bounded; never blocks the session teardown.
   */
  const failStartup = async (failureReason: string, sttError: unknown | null) => {
    if (sttError !== null && session.tts) {
      await speakFallback(session, sttError, "stt_connect_failed");
      // Let the apology play (bounded) before the line is dropped.
      await waitForFinalAudio(session);
    }
    setState(session, "failed");
    await requestProviderHangup(session, failureReason);
    await terminateRuntimeSession(input.callId, failureReason);
    return handle;
  };

  if (ttsOutcome.status === "rejected") {
    // Still settle STT so a connected STT session is closed by termination.
    const [sttOutcome] = await Promise.allSettled([sttConnectPromise]);
    applySttOutcome(sttOutcome);
    return failStartup("tts_connect_failed", null);
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
    // Nothing can be said on this call: end the phone call, not just the
    // media stream (see the connect-failure path above).
    await requestProviderHangup(session, "greeting_failed");
    await terminateRuntimeSession(input.callId, "greeting_failed");
    void Promise.allSettled([sttConnectPromise]).then(([late]) => applySttOutcome(late));
    return handle;
  }

  const [sttOutcome] = await Promise.allSettled([sttConnectPromise]);
  applySttOutcome(sttOutcome);
  if (session.terminationStarted) return handle; // ended during the greeting
  if (sttOutcome.status === "rejected") {
    return failStartup("stt_connect_failed", sttOutcome.reason);
  }

  return handle;
}

/** Calls whose provider reported the call ended (call-ended webhook), with when — see providerReportedCallEnded. */
const providerEndedCalls = new Map<string, number>();
const PROVIDER_ENDED_MEMORY_MS = 10 * 60_000;

function recordProviderCallEnded(callId: string) {
  const now = Date.now();
  for (const [id, at] of providerEndedCalls) {
    if (now - at > PROVIDER_ENDED_MEMORY_MS) providerEndedCalls.delete(id);
  }
  providerEndedCalls.set(callId, now);
}

/** The provider's call-ended webhook for this call has been received recently. */
function providerReportedCallEnded(callId: string): boolean {
  const at = providerEndedCalls.get(callId);
  return at !== undefined && Date.now() - at <= PROVIDER_ENDED_MEMORY_MS;
}

/** Idempotent: a second call for an already-ending/ended session is a no-op. */
export async function terminateRuntimeSession(callId: string, reason: string): Promise<void> {
  // The provider's own call-ended webhook (telephony.ts terminateAgentRuntime
  // passes "call ended: <status>") is the confirmation that the phone call
  // is over — remembered even if the session has already gone, so a media
  // close that raced it doesn't request a needless hang-up.
  if (reason.startsWith("call ended:")) recordProviderCallEnded(callId);
  const session = activeSessions.get(callId);
  if (!session) return;
  if (session.handle.state === "ending" || session.handle.state === "ended") return;
  // A failed session never enters "ending", so the state check above can't
  // stop a second termination (e.g. the bridge's own close handler firing
  // while this one is still persisting) — this does: one cleanup, one
  // transcript, per session.
  if (session.terminationStarted) return;
  session.terminationStarted = true;

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
  clearMaxDurationTimer(session);
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
  // Our own close of the media bridge — not a dropped connection (see the
  // bridge.onClose handler in startRuntimeSession).
  session.closingBridge = true;
  try {
    session.input.bridge.close();
  } catch {
    /* best-effort */
  }

  await persistTranscript(session);

  if (!hadError) setState(session, "ended");
  activeSessions.delete(callId);
  logLifecycle(session, hadError ? "FAILED" : "COMPLETED", reason);
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
      session.outboundPlayoutEndsAt = 0;
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
