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
 */

import type { AudioMediaBridge, AudioFrame } from "./telephony/audio-bridge.ts";
import {
  connectSarvamStt,
  connectSarvamTts,
  type SttEvent,
  type TtsEvent,
} from "./sarvam-realtime.server.ts";
import { sarvam, ProviderError } from "./sarvam.server.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";

export type RuntimeState =
  "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "INTERRUPTED" | "ENDING" | "ENDED" | "ERROR";

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

interface Session {
  handle: RuntimeSessionHandle;
  input: StartRuntimeSessionInput;
  turns: ConversationTurn[];
  detectedLanguage: string | null;
  generation: number;
  startedAt: number;
  stt: Awaited<ReturnType<typeof connectSarvamStt>> | null;
  tts: Awaited<ReturnType<typeof connectSarvamTts>> | null;
  accumulatingUserText: string;
}

const activeSessions = new Map<string, Session>();

function log(
  event: string,
  session: Pick<Session, "input"> & { handle: { runtimeSessionId: string } },
  extra?: Record<string, unknown>,
) {
  console.info(`voice_runtime:${event}`, {
    call_id: session.input.callId,
    runtime_session_id: session.handle.runtimeSessionId,
    organization_id: session.input.organizationId,
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const summary = session.turns.length
      ? `${session.turns.length} turns · ${session.detectedLanguage ?? session.input.snapshotAgent.primary_language}`
      : "No conversation recorded.";
    await supabaseAdmin
      .from("call_logs")
      .update({
        transcript: session.turns as never,
        summary,
        language: session.detectedLanguage ?? session.input.snapshotAgent.primary_language,
        agent_version: session.input.agentVersion,
      })
      .eq("id", session.input.callId);
  } catch (err) {
    console.error("voice_runtime:persist_transcript_failed", (err as Error).message);
  }
}

async function speak(session: Session, text: string): Promise<void> {
  if (!session.tts) return;
  session.handle.state = "SPEAKING";
  for (const chunk of chunkIntoSentences(text)) {
    session.tts.sendText(chunk);
    session.tts.flush();
  }
}

async function handleUserUtterance(session: Session, text: string) {
  session.turns.push({ role: "user", text, at: new Date().toISOString() });
  session.handle.state = "THINKING";
  const generation = ++session.generation;
  const requestStarted = Date.now();

  const messages = [
    { role: "system" as const, content: session.input.instructions },
    ...session.turns
      .slice(-20)
      .map((t) => ({ role: t.role as "user" | "assistant", content: t.text })),
  ];

  try {
    const { reply } = await sarvam.runConversation(messages);
    log("llm_completed", session, { latency_ms: Date.now() - requestStarted });

    // Soft cancellation: if the caller interrupted (or spoke again) while
    // this request was in flight, `generation` has already advanced — the
    // stale reply is discarded instead of being spoken over the new turn.
    // (sarvam.runConversation has no request-cancellation signal to abort
    // outright — this is the honest, documented limitation; see the Phase E
    // report.)
    if (generation !== session.generation) {
      log("llm_response_discarded_stale", session);
      return;
    }
    if (!reply) {
      log("llm_empty_reply", session);
      session.handle.state = "LISTENING";
      return;
    }

    session.turns.push({ role: "assistant", text: reply, at: new Date().toISOString() });
    await speak(session, reply);
    if (generation === session.generation) session.handle.state = "LISTENING";
  } catch (err) {
    log("llm_error", session, { message: (err as Error).message });
    if (generation === session.generation) {
      await speakFallback(session, err);
      session.handle.state = "LISTENING";
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
      if (session.handle.state === "SPEAKING" || session.handle.state === "THINKING") {
        // Barge-in: stop talking immediately, discard the audio already
        // queued for the caller, and soft-cancel any in-flight LLM turn.
        session.generation++;
        session.input.bridge.clearOutboundBuffer();
        session.tts?.flush();
        session.handle.state = "INTERRUPTED";
        log("interruption", session);
      }
      break;
    }
    case "speech_end":
      break;
    case "partial_transcript":
      session.accumulatingUserText = event.text;
      break;
    case "final_transcript": {
      session.accumulatingUserText = "";
      if (event.language) session.detectedLanguage = event.language;
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
 * the ERROR state with a clear reason, so a Sarvam outage degrades the
 * call gracefully instead of crashing the webhook that invoked this.
 */
export async function startRuntimeSession(
  input: StartRuntimeSessionInput,
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
    state: "IDLE",
    terminate: async (reason: string) => terminateRuntimeSession(input.callId, reason),
  };
  const session: Session = {
    handle,
    input,
    turns: [],
    detectedLanguage: null,
    generation: 0,
    startedAt: Date.now(),
    stt: null,
    tts: null,
    accumulatingUserText: "",
  };
  activeSessions.set(input.callId, session);
  log("runtime_started", session);

  input.bridge.onClose((reason) => {
    log("bridge_closed", session, { reason });
    void terminateRuntimeSession(input.callId, `bridge closed: ${reason}`);
  });

  try {
    session.tts = await connectSarvamTts({
      voiceId: input.snapshotAgent.voice_id,
      language: input.snapshotAgent.primary_language,
      pace: input.snapshotAgent.speaking_pace,
      outputCodec: outputCodecFor(input.bridge),
      outputSampleRateHz: input.bridge.outboundFormat.sampleRateHz,
      onEvent: (e) => onTtsEvent(session, e),
    });
    log("tts_connected", session);
  } catch (err) {
    log("tts_connect_failed", session, { message: (err as Error).message });
    handle.state = "ERROR";
    await terminateRuntimeSession(input.callId, "tts_connect_failed");
    return handle;
  }

  try {
    session.stt = await connectSarvamStt({
      language: input.snapshotAgent.multilingual ? "unknown" : input.snapshotAgent.primary_language,
      sampleRateHz: input.bridge.inboundFormat.sampleRateHz,
      encoding: input.bridge.inboundFormat.encoding === "mulaw" ? "mulaw" : "linear16",
      onEvent: (e) => onSttEvent(session, e),
    });
    log("stt_connected", session);
  } catch (err) {
    log("stt_connect_failed", session, { message: (err as Error).message });
    await speakFallback(session, err);
    handle.state = "ERROR";
    await terminateRuntimeSession(input.callId, "stt_connect_failed");
    return handle;
  }

  input.bridge.onInboundFrame((frame) => {
    session.stt?.sendAudioFrame(frame.data);
  });

  try {
    const greeting = pickGreeting(input.snapshotAgent, input.businessName);
    session.turns.push({ role: "assistant", text: greeting, at: new Date().toISOString() });
    await speak(session, greeting);
    handle.state = "LISTENING";
    log("greeting_played", session);
    void markAgentLive(input.agentConfigId);
  } catch (err) {
    log("greeting_failed", session, { message: (err as Error).message });
    handle.state = "ERROR";
  }

  return handle;
}

/** Idempotent: a second call for an already-ending/ended session is a no-op. */
export async function terminateRuntimeSession(callId: string, reason: string): Promise<void> {
  const session = activeSessions.get(callId);
  if (!session) return;
  if (session.handle.state === "ENDING" || session.handle.state === "ENDED") return;

  // A session that failed to start (state === "ERROR") still needs the full
  // cleanup below, but its visible final state should stay ERROR rather
  // than being overwritten with a "normal" ENDING/ENDED — callers (and
  // logs) need to be able to tell "the call ended" from "the runtime never
  // worked" apart.
  const hadError = session.handle.state === "ERROR";
  if (!hadError) session.handle.state = "ENDING";
  log("runtime_terminating", session, { reason });

  session.generation++; // discard any in-flight LLM work
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

  if (!hadError) session.handle.state = "ENDED";
  activeSessions.delete(callId);
  log("runtime_terminated", session, { reason });
}
