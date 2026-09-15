/**
 * Deterministic backend test harness for the voice-agent call pipeline.
 *
 * Drives the REAL orchestration/state-machine/persistence code in
 * ../voice-runtime.server.ts end-to-end — startRuntimeSession,
 * onSttEvent/onTtsEvent, handleUserUtterance, the silence timer, barge-in,
 * terminateRuntimeSession — through its public `RuntimeDeps` seam
 * (connectStt/connectTts/generateReply/persistTranscript) and the
 * `AudioMediaBridge` interface. Nothing here mocks voice-runtime.server.ts
 * itself or asserts "a function was called" in place of exercising the
 * actual logic; every fake below is a deterministic, inspectable stand-in
 * for exactly the same shape a real provider connection has (connect,
 * send, receive events, close), so the session genuinely runs through its
 * real code paths against them.
 *
 * Provider-neutral by construction: `createFakeBridge` implements the same
 * `AudioMediaBridge` contract `ExotelMediaBridge` does — nothing here is
 * Exotel-specific (no CallSid, no stream_sid, no Exotel event names). A
 * real telephony integration test would swap this fake bridge for a real
 * one; nothing in voice-runtime.server.ts or this harness changes.
 *
 * This is one tier of this project's test pyramid for the voice pipeline:
 *   - UNIT: pure-function tests with no I/O at all (e.g.
 *     isValidRuntimeTransition, chunkIntoSentences — voice-runtime.server.test.ts).
 *   - INTEGRATION (this harness): the real orchestration code, real state
 *     machine, real persistence call sites — driven by fake, deterministic
 *     STT/TTS/LLM/persistence implementations. No network, no live
 *     credentials, fully deterministic, safe in CI.
 *   - LIVE (Sarvam): the real Sarvam WebSocket/HTTP APIs, gated behind
 *     SARVAM_API_KEY — see voice-runtime-harness.test.ts's "LIVE TEST"
 *     section and docs/voice-pipeline-testing.md's runbook.
 *   - LIVE (telephony): an actual Exotel call reaching the deployed Worker
 *     — see docs/voice-pipeline-testing.md's telephony runbook. Cannot be
 *     automated from this repository at all.
 */

import type { AudioFormat, AudioFrame, AudioMediaBridge } from "./audio-bridge.ts";
import type {
  ConnectSttOptions,
  ConnectTtsOptions,
  SttEvent,
  SttSession,
  TtsEvent,
  TtsSession,
} from "../sarvam-realtime.server.ts";
import type { ChatMessage } from "../sarvam.server.ts";
import type { RuntimeDeps, TranscriptRecord } from "../voice-runtime.server.ts";

/* ------------------------------------------------------------------ */
/* Fake audio bridge                                                   */
/* ------------------------------------------------------------------ */

export interface FakeBridge extends AudioMediaBridge {
  /** Every frame the runtime has sent to the caller (TTS audio out), in order. */
  readonly sentFrames: AudioFrame[];
  /** How many times the runtime asked the bridge to drop queued caller-bound audio (barge-in). */
  readonly clearedCount: number;
  readonly closed: boolean;
  readonly closeReason: string | null;
  /** Simulates one frame of caller audio arriving on the wire. */
  emitInboundFrame(data: Uint8Array): void;
  /** Simulates the provider's own transport dropping (Exotel WS close, network loss, etc) — not an application-initiated close. */
  simulateProviderDisconnect(reason: string): void;
}

export function createFakeBridge(
  format: AudioFormat = { encoding: "linear16", sampleRateHz: 8000 },
): FakeBridge {
  const inboundHandlers: ((frame: AudioFrame) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  const sentFrames: AudioFrame[] = [];
  let clearedCount = 0;
  let closed = false;
  let closeReason: string | null = null;
  const startedAt = Date.now();

  const fireClose = (reason: string) => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    for (const cb of closeHandlers) cb(reason);
  };

  return {
    inboundFormat: format,
    outboundFormat: format,
    onInboundFrame(cb) {
      inboundHandlers.push(cb);
    },
    sendOutboundFrame(frame) {
      sentFrames.push(frame);
    },
    clearOutboundBuffer() {
      clearedCount++;
    },
    onClose(cb) {
      closeHandlers.push(cb);
    },
    close() {
      fireClose("closed by application");
    },
    get sentFrames() {
      return sentFrames;
    },
    get clearedCount() {
      return clearedCount;
    },
    get closed() {
      return closed;
    },
    get closeReason() {
      return closeReason;
    },
    emitInboundFrame(data: Uint8Array) {
      const frame: AudioFrame = { data, timestampMs: Date.now() - startedAt };
      for (const cb of inboundHandlers) cb(frame);
    },
    simulateProviderDisconnect(reason: string) {
      fireClose(reason);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Fake STT — real connect/close semantics, controllable events         */
/* ------------------------------------------------------------------ */

export interface FakeSttController {
  readonly connectCalls: ConnectSttOptions[];
  readonly sentAudioFrames: Uint8Array[];
  readonly closed: boolean;
  /** Delivers one SttEvent to the runtime, exactly as a real Sarvam WS message would. Throws if STT hasn't connected yet. */
  emit(event: SttEvent): void;
  /** Convenience: speech_start immediately followed by final_transcript with this text. */
  speakUtterance(text: string, language?: string): void;
}

export interface FakeSttOptions {
  /** Milliseconds to wait before connect() resolves — for testing "audio arrives before the connection is ready". */
  connectDelayMs?: number;
  /** If set, connect() rejects with this error instead of succeeding. */
  failConnectWith?: Error;
}

export function createFakeStt(opts: FakeSttOptions = {}): {
  connectStt: RuntimeDeps["connectStt"];
  controller: FakeSttController;
} {
  const connectCalls: ConnectSttOptions[] = [];
  const sentAudioFrames: Uint8Array[] = [];
  let onEventRef: ((event: SttEvent) => void) | null = null;
  let closed = false;

  const connectStt: RuntimeDeps["connectStt"] = async (connectOpts) => {
    connectCalls.push(connectOpts);
    if (opts.connectDelayMs)
      await new Promise((resolve) => setTimeout(resolve, opts.connectDelayMs));
    if (opts.failConnectWith) throw opts.failConnectWith;
    onEventRef = connectOpts.onEvent;
    const session: SttSession = {
      sendAudioFrame(data) {
        sentAudioFrames.push(data);
      },
      close() {
        closed = true;
      },
    };
    return session;
  };

  const controller: FakeSttController = {
    get connectCalls() {
      return connectCalls;
    },
    get sentAudioFrames() {
      return sentAudioFrames;
    },
    get closed() {
      return closed;
    },
    emit(event: SttEvent) {
      if (!onEventRef) throw new Error("fake STT: cannot emit before connectStt has resolved");
      onEventRef(event);
    },
    speakUtterance(text: string, language = "en-IN") {
      controller.emit({ type: "speech_start" });
      controller.emit({ type: "final_transcript", text, language });
    },
  };

  return { connectStt, controller };
}

/* ------------------------------------------------------------------ */
/* Fake TTS — real connect/close semantics, records what was spoken      */
/* ------------------------------------------------------------------ */

export interface FakeTtsController {
  readonly connectCalls: ConnectTtsOptions[];
  readonly sentTexts: string[];
  readonly flushCount: number;
  readonly closed: boolean;
  /** Delivers one TtsEvent to the runtime, exactly as a real Sarvam WS message would. */
  emit(event: TtsEvent): void;
  /** Convenience: emits one "audio" event with the given bytes, as if Sarvam had synthesized speech. */
  emitAudio(data: Uint8Array): void;
}

export interface FakeTtsOptions {
  connectDelayMs?: number;
  failConnectWith?: Error;
}

export function createFakeTts(opts: FakeTtsOptions = {}): {
  connectTts: RuntimeDeps["connectTts"];
  controller: FakeTtsController;
} {
  const connectCalls: ConnectTtsOptions[] = [];
  const sentTexts: string[] = [];
  let flushCount = 0;
  let onEventRef: ((event: TtsEvent) => void) | null = null;
  let closed = false;

  const connectTts: RuntimeDeps["connectTts"] = async (connectOpts) => {
    connectCalls.push(connectOpts);
    if (opts.connectDelayMs)
      await new Promise((resolve) => setTimeout(resolve, opts.connectDelayMs));
    if (opts.failConnectWith) throw opts.failConnectWith;
    onEventRef = connectOpts.onEvent;
    const session: TtsSession = {
      sendText(text) {
        sentTexts.push(text);
      },
      flush() {
        flushCount++;
      },
      close() {
        closed = true;
      },
    };
    return session;
  };

  const controller: FakeTtsController = {
    get connectCalls() {
      return connectCalls;
    },
    get sentTexts() {
      return sentTexts;
    },
    get flushCount() {
      return flushCount;
    },
    get closed() {
      return closed;
    },
    emit(event: TtsEvent) {
      if (!onEventRef) throw new Error("fake TTS: cannot emit before connectTts has resolved");
      onEventRef(event);
    },
    emitAudio(data: Uint8Array) {
      controller.emit({ type: "audio", data });
    },
  };

  return { connectTts, controller };
}

/* ------------------------------------------------------------------ */
/* Fake LLM                                                             */
/* ------------------------------------------------------------------ */

export interface FakeLlmController {
  readonly calls: ChatMessage[][];
  /** Sets the reply the NEXT generateReply call resolves with (consumed once, then reverts to the default). */
  setNextReply(reply: string): void;
  /** Sets the error the NEXT generateReply call rejects with (consumed once). */
  setNextError(error: Error): void;
  /** Delays every future generateReply call by this many ms (0 = no delay). */
  setDelay(ms: number): void;
}

export function createFakeLlm(defaultReply = "Okay, how can I help?"): {
  generateReply: RuntimeDeps["generateReply"];
  controller: FakeLlmController;
} {
  const calls: ChatMessage[][] = [];
  let nextReply: string | null = null;
  let nextError: Error | null = null;
  let delayMs = 0;

  const generateReply: RuntimeDeps["generateReply"] = async (messages) => {
    calls.push(messages);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (nextError) {
      const err = nextError;
      nextError = null;
      throw err;
    }
    const reply = nextReply ?? defaultReply;
    nextReply = null;
    return { reply };
  };

  return {
    generateReply,
    controller: {
      get calls() {
        return calls;
      },
      setNextReply(reply: string) {
        nextReply = reply;
      },
      setNextError(error: Error) {
        nextError = error;
      },
      setDelay(ms: number) {
        delayMs = ms;
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Fake persistence                                                     */
/* ------------------------------------------------------------------ */

export interface FakePersistenceController {
  readonly records: TranscriptRecord[];
  readonly failNext: (error: Error) => void;
}

export function createFakePersistence(): {
  persistTranscript: RuntimeDeps["persistTranscript"];
  controller: FakePersistenceController;
} {
  const records: TranscriptRecord[] = [];
  let nextError: Error | null = null;

  const persistTranscript: RuntimeDeps["persistTranscript"] = async (record) => {
    if (nextError) {
      const err = nextError;
      nextError = null;
      throw err;
    }
    records.push(record);
  };

  return {
    persistTranscript,
    controller: {
      get records() {
        return records;
      },
      failNext(error: Error) {
        nextError = error;
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* One-call convenience: every fake wired into one RuntimeDeps           */
/* ------------------------------------------------------------------ */

export interface Harness {
  bridge: FakeBridge;
  stt: FakeSttController;
  tts: FakeTtsController;
  llm: FakeLlmController;
  persistence: FakePersistenceController;
  deps: RuntimeDeps;
}

export function createHarness(
  opts: { stt?: FakeSttOptions; tts?: FakeTtsOptions; defaultReply?: string } = {},
): Harness {
  const bridge = createFakeBridge();
  const { connectStt, controller: stt } = createFakeStt(opts.stt);
  const { connectTts, controller: tts } = createFakeTts(opts.tts);
  const { generateReply, controller: llm } = createFakeLlm(opts.defaultReply);
  const { persistTranscript, controller: persistence } = createFakePersistence();

  return {
    bridge,
    stt,
    tts,
    llm,
    persistence,
    deps: { connectStt, connectTts, generateReply, persistTranscript },
  };
}
