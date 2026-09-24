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
 * itself resolved by llm-provider.server.ts (Sarvam, Claude, or Gemini, by
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
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ClaudeTool } from "./claude.server.ts";

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
  // Tool-calling deps are all-or-nothing (see getReply): populated only
  // when the selected provider actually implements it (Claude today).
  // generateReplyWithTools is undefined for Sarvam/Gemini, which
  // correctly disables the whole tool-calling path for them rather than
  // half-wiring it.
  ...(generateReplyWithTools
    ? {
        generateReplyWithTools,
        resolveAvailableTools: resolveAvailableToolsFromDb,
        executeTool: executeToolViaRegistry,
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
}

const activeSessions = new Map<string, Session>();

/** Bounds memory if STT never connects (or connects very slowly) while the caller is already talking — approximate, not a guaranteed-lossless buffer. At ~20ms/frame this is roughly 5s of audio. */
const MAX_PENDING_INBOUND_FRAMES = 250;

/** A provider (or the network) redelivering the identical final_transcript within this window is treated as a duplicate event, not a second utterance — see onSttEvent's "final_transcript" case. */
const DUPLICATE_TRANSCRIPT_WINDOW_MS = 2_000;

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
  if (!isAwaitingCaller(session.handle.state)) return;
  const delay = session.silencePromptSent ? SILENCE_HANGUP_MS : SILENCE_PROMPT_MS;
  session.silenceTimer = setTimeout(() => {
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
      language: session.detectedLanguage ?? session.input.snapshotAgent.primary_language,
      agentVersion: session.input.agentVersion,
    });
    log("persist_transcript_succeeded", session, { turn_count: session.turns.length });
  } catch (err) {
    log("persist_transcript_failed", session, { message: (err as Error).message });
  }
}

async function speak(
  session: Session,
  text: string,
  asState: "greeting" | "speaking" = "speaking",
): Promise<void> {
  if (!session.tts) return;
  setState(session, asState);
  for (const chunk of chunkIntoSentences(text)) {
    session.tts.sendText(chunk);
    session.tts.flush();
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
): Promise<{ reply: string; enteredPaymentWait: boolean }> {
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
      return { reply: result.reply, enteredPaymentWait };
    }
  }
  const { reply } = await session.deps.generateReply(messages);
  return { reply, enteredPaymentWait: false };
}

async function handleUserUtterance(session: Session, text: string) {
  session.turns.push({ role: "user", text, at: new Date().toISOString() });
  // Whatever payment wait was pending no longer applies — the caller is
  // actively talking again now, and this turn will address whatever they
  // said (possibly re-arming a fresh wait itself, if it results in another
  // request_payment call).
  clearPaymentWaitTimer(session);
  setState(session, "thinking");
  const generation = ++session.generation;
  const requestStarted = Date.now();

  const messages: ChatMessage[] = [
    { role: "system", content: session.input.instructions },
    ...session.turns.slice(-20).map((t) => ({ role: t.role, content: t.text }) as ChatMessage),
  ];

  try {
    const { reply, enteredPaymentWait } = await getReply(session, messages);
    log("llm_completed", session, { latency_ms: Date.now() - requestStarted });

    // Soft cancellation: if the caller interrupted (or spoke again) while
    // this request was in flight, `generation` has already advanced — the
    // stale reply is discarded instead of being spoken over the new turn.
    // (There is no request-cancellation signal to abort the call outright —
    // this is the honest, documented limitation; see the Phase E report.)
    if (generation !== session.generation) {
      log("llm_response_discarded_stale", session);
      return;
    }
    if (!reply) {
      log("llm_empty_reply", session);
      setState(session, "listening");
      armSilenceTimer(session);
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
  } catch (err) {
    log("llm_error", session, { message: (err as Error).message });
    if (generation === session.generation) {
      await speakFallback(session, err);
      setState(session, "listening");
      armSilenceTimer(session);
    }
  }
}

async function speakFallback(session: Session, error: unknown) {
  const message =
    error instanceof ProviderError
      ? "I'm sorry, I'm having trouble understanding right now. Please hold for a moment or call back shortly."
      : "I'm sorry, something went wrong on my end. Please try again in a moment.";
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
      if (state === "greeting" || state === "speaking" || state === "thinking") {
        // Barge-in: stop talking immediately, discard the audio already
        // queued for the caller, and soft-cancel any in-flight LLM turn.
        session.generation++;
        session.input.bridge.clearOutboundBuffer();
        session.tts?.flush();
        setState(session, "interrupted");
        log("interruption", session);
      } else if (state === "listening" || state === "waiting_on_payment") {
        setState(session, "transcribing");
      }
      break;
    }
    case "speech_end":
      // The caller just stopped talking. Re-arm from here rather than from
      // speech_start, so the silence window doesn't start counting down
      // while they're still mid-utterance — a no-op unless the state is
      // one of the "waiting on the caller" states (e.g. does nothing while
      // the agent is thinking/speaking, which isn't caller silence).
      armSilenceTimer(session);
      break;
    case "partial_transcript":
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
        break;
      }
      session.lastFinalTranscript = { text: event.text, at: Date.now() };

      log("transcript_final", session, { language: event.language });
      void handleUserUtterance(session, event.text);
      break;
    }
    case "language_detected":
      session.detectedLanguage = event.language;
      log("language_detected", session, { language: event.language });
      break;
    case "error":
      log("stt_error", session, { message: event.message });
      break;
    case "closed":
      log("stt_disconnected", session, { code: event.code, reason: event.reason });
      break;
    case "unknown":
      break;
  }
}

function onTtsEvent(session: Session, event: TtsEvent) {
  switch (event.type) {
    case "audio": {
      session.ttsBytesInFlight += event.data.length;
      const frame: AudioFrame = { data: event.data, timestampMs: Date.now() - session.startedAt };
      session.input.bridge.sendOutboundFrame(frame);
      break;
    }
    case "error":
      log("tts_error", session, { message: event.message });
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

  try {
    const outputCodec = outputCodecFor(input.bridge);
    const outputSampleRateHz = input.bridge.outboundFormat.sampleRateHz;
    session.tts = await deps.connectTts({
      voiceId: input.snapshotAgent.voice_id,
      language: input.snapshotAgent.primary_language,
      pace: input.snapshotAgent.speaking_pace,
      outputCodec,
      outputSampleRateHz,
      onEvent: (e) => onTtsEvent(session, e),
    });
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
  } catch (err) {
    log("tts_connect_failed", session, { message: (err as Error).message });
    setState(session, "failed");
    await terminateRuntimeSession(input.callId, "tts_connect_failed");
    return handle;
  }

  try {
    const sttSampleRateHz = input.bridge.inboundFormat.sampleRateHz;
    const sttEncoding = input.bridge.inboundFormat.encoding === "mulaw" ? "mulaw" : "linear16";
    session.stt = await deps.connectStt({
      language: input.snapshotAgent.multilingual ? "unknown" : input.snapshotAgent.primary_language,
      sampleRateHz: sttSampleRateHz,
      encoding: sttEncoding,
      onEvent: (e) => onSttEvent(session, e),
    });
    /**
     * Diagnostic (audio format tracing): the exact format this session
     * told the AI voice provider inbound audio would arrive in, derived
     * entirely from the bridge's own declared inboundFormat — never a
     * hardcoded assumption here. Compare against the telephony provider's
     * own configured format if STT connects but never produces a
     * transcript for audio that is clearly being sent.
     */
    log("stt_connected", session, { sttSampleRateHz, sttEncoding });
    // Flush whatever arrived on the bridge while STT was still connecting —
    // see the onInboundFrame registration above.
    for (const frame of session.pendingInboundFrames) session.stt.sendAudioFrame(frame.data);
    session.pendingInboundFrames = [];
  } catch (err) {
    log("stt_connect_failed", session, { message: (err as Error).message });
    await speakFallback(session, err);
    setState(session, "failed");
    await terminateRuntimeSession(input.callId, "stt_connect_failed");
    return handle;
  }

  try {
    const greeting = pickGreeting(input.snapshotAgent, input.businessName);
    session.turns.push({ role: "assistant", text: greeting, at: new Date().toISOString() });
    await speak(session, greeting, "greeting");
    setState(session, "listening");
    armSilenceTimer(session);
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
