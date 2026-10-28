import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { classifySarvamClose, normalizeSttMessage } from "./sarvam-realtime.server.ts";

/**
 * Multilingual regressions for the Sarvam realtime clients, against the
 * message shapes in Sarvam's realtime STT reference
 * (docs.sarvam.ai/api-reference/speech-to-text/transcribe/realtime/ws):
 * every field is top-level; with language_code=auto, transcript.partial and
 * transcript.final carry `language`, and transcript.final also carries
 * `language_confidence` (a string-typed 0.0–1.0 float). Odia is `or-IN` on
 * that endpoint but `od-IN` for bulbul:v3 TTS.
 */

describe("normalizeSttMessage — detected language from the realtime protocol", () => {
  test("transcript.final reads `language` and `language_confidence` (the realtime field names)", () => {
    const event = normalizeSttMessage({
      event: "transcript.final",
      utterance_idx: 0,
      text: "నమస్కారం",
      language: "te-IN",
      language_confidence: "0.93",
    });
    assert.deepEqual(event, {
      type: "final_transcript",
      text: "నమస్కారం",
      language: "te-IN",
      languageConfidence: 0.93,
    });
  });

  test("Odia arrives as or-IN and is normalized to the TTS/LLM code od-IN", () => {
    const event = normalizeSttMessage({
      event: "transcript.final",
      text: "ନମସ୍କାର",
      language: "or-IN",
      language_confidence: "0.88",
    });
    assert.equal((event as { language?: string }).language, "od-IN");
  });

  test("transcript.partial carries `language` without a confidence", () => {
    const event = normalizeSttMessage({
      event: "transcript.partial",
      text: "मुझे",
      language: "hi-IN",
    });
    assert.deepEqual(event, { type: "partial_transcript", text: "मुझे", language: "hi-IN" });
  });

  test("a recognised language the pipeline can't answer in is passed through unchanged (so it is logged and later falls back)", () => {
    const event = normalizeSttMessage({
      event: "transcript.final",
      text: "...",
      language: "ur-IN",
      language_confidence: "0.9",
    });
    assert.equal((event as { language?: string }).language, "ur-IN");
  });

  test("the legacy `language_code` field is still read when `language` is absent", () => {
    const event = normalizeSttMessage({
      event: "transcript.final",
      text: "hello",
      language_code: "en-IN",
    });
    assert.equal((event as { language?: string }).language, "en-IN");
  });

  test("an invalid confidence is dropped rather than trusted", () => {
    for (const bad of ["abc", "1.5", "-0.1", ""]) {
      const event = normalizeSttMessage({
        event: "transcript.final",
        text: "x",
        language: "hi-IN",
        language_confidence: bad,
      });
      assert.equal("languageConfidence" in event, false, `confidence ${JSON.stringify(bad)}`);
    }
  });

  test("a numeric confidence is accepted too", () => {
    const event = normalizeSttMessage({
      event: "transcript.final",
      text: "x",
      language: "hi-IN",
      language_confidence: 0.4,
    });
    assert.equal((event as { languageConfidence?: number }).languageConfidence, 0.4);
  });

  test("a language_detected message with the realtime spelling is normalized", () => {
    assert.deepEqual(normalizeSttMessage({ event: "language_detected", language: "or-IN" }), {
      type: "language_detected",
      language: "od-IN",
    });
  });
});

describe("normalizeSttMessage — realtime error frames", () => {
  test("code and is_fatal are kept alongside the message", () => {
    const event = normalizeSttMessage({
      event: "error",
      code: "invalid_config",
      is_fatal: false,
      message: "language_code not supported",
    });
    assert.deepEqual(event, {
      type: "error",
      message: "language_code not supported",
      raw: {
        event: "error",
        code: "invalid_config",
        is_fatal: false,
        message: "language_code not supported",
      },
      code: "invalid_config",
      fatal: false,
    });
  });

  test("an error without code/is_fatal still parses, without inventing them", () => {
    const event = normalizeSttMessage({ event: "error", message: "boom" });
    assert.equal(event.type, "error");
    assert.equal("code" in event, false);
    assert.equal("fatal" in event, false);
  });
});

describe("classifySarvamClose — documented realtime close codes", () => {
  test("1003 is rate limit / quota / invalid key, not retryable", () => {
    assert.deepEqual(classifySarvamClose(1003, "quota exceeded"), {
      kind: "auth_or_quota",
      retryable: false,
      reason: "quota exceeded",
    });
  });

  test("1008 is an inactivity timeout — NOT an auth failure (it used to be treated as one)", () => {
    const info = classifySarvamClose(1008);
    assert.equal(info.kind, "inactivity_timeout");
    assert.equal(info.retryable, true);
  });

  test("4000 is a rejected request (bad model/language/param), never retryable as-is", () => {
    const info = classifySarvamClose(4000, "Unsupported language_code 'od-IN'");
    assert.equal(info.kind, "rejected_request");
    assert.equal(info.retryable, false);
  });

  test("1011 is a Sarvam server error, retryable", () => {
    assert.equal(classifySarvamClose(1011).kind, "server_error");
    assert.equal(classifySarvamClose(1011).retryable, true);
  });

  test("4001/4003 stay auth failures; 1000 is normal; anything else is abnormal", () => {
    assert.equal(classifySarvamClose(4001).kind, "auth_failed");
    assert.equal(classifySarvamClose(4003).kind, "auth_failed");
    assert.equal(classifySarvamClose(1000).kind, "normal");
    assert.equal(classifySarvamClose(1006).kind, "abnormal");
  });

  test("the reason is capped at Sarvam's documented 123 bytes", () => {
    assert.equal(classifySarvamClose(4000, "x".repeat(500)).reason.length, 123);
  });
});

/* ------------------------------------------------------------------ */
/* Connection-level: what actually goes on the wire                     */
/* ------------------------------------------------------------------ */

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((ev: unknown) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    for (const cb of this.listeners.get("open") ?? []) cb({});
  }

  simulateClose(code: number, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    for (const cb of this.listeners.get("close") ?? []) cb({ code, reason });
  }
}

function withFakeWebSocket<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  return fn().finally(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = original;
  });
}

describe("connectSarvamStt / connectSarvamTts — language codes on the wire", () => {
  const originalKey = process.env["SARVAM_API_KEY"];
  afterEach(() => {
    if (originalKey === undefined) delete process.env["SARVAM_API_KEY"];
    else process.env["SARVAM_API_KEY"] = originalKey;
  });

  test("STT keeps language_code=auto as-is", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { connectSarvamStt } = await import("./sarvam-realtime.server.ts");
      const pending = connectSarvamStt({
        language: "auto",
        sampleRateHz: 8000,
        encoding: "mulaw",
        onEvent: () => {},
      });
      const socket = FakeWebSocket.instances[0]!;
      assert.equal(new URL(socket.url).searchParams.get("language_code"), "auto");
      socket.simulateOpen();
      (await pending).close();
    });
  });

  test("STT pinned to Odia sends the realtime endpoint's own code, or-IN", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { connectSarvamStt } = await import("./sarvam-realtime.server.ts");
      const pending = connectSarvamStt({
        language: "od-IN",
        sampleRateHz: 8000,
        encoding: "mulaw",
        onEvent: () => {},
      });
      const socket = FakeWebSocket.instances[0]!;
      assert.equal(new URL(socket.url).searchParams.get("language_code"), "or-IN");
      socket.simulateOpen();
      (await pending).close();
    });
  });

  test("TTS given the STT spelling or-IN still configures bulbul:v3 with od-IN", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { connectSarvamTts } = await import("./sarvam-realtime.server.ts");
      const pending = connectSarvamTts({
        voiceId: "ritu",
        language: "or-IN",
        pace: 1,
        outputCodec: "mulaw",
        outputSampleRateHz: 8000,
        onEvent: () => {},
      });
      const socket = FakeWebSocket.instances[0]!;
      socket.simulateOpen();
      const tts = await pending;
      const config = JSON.parse(socket.sent[0]!) as { data: Record<string, unknown> };
      assert.equal(config.data["language_code"], "od-IN");
      tts.close();
    });
  });

  test("every supported language reaches bulbul:v3 as a code in its documented enum", async () => {
    const { VOICE_LANGUAGES } = await import("./voice-languages.ts");
    const bulbulV3Enum = [
      "bn-IN",
      "en-IN",
      "gu-IN",
      "hi-IN",
      "kn-IN",
      "ml-IN",
      "mr-IN",
      "od-IN",
      "pa-IN",
      "ta-IN",
      "te-IN",
    ];
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    for (const lang of VOICE_LANGUAGES) {
      await withFakeWebSocket(async () => {
        const { connectSarvamTts } = await import("./sarvam-realtime.server.ts");
        const pending = connectSarvamTts({
          voiceId: "ritu",
          language: lang.code,
          pace: 1,
          outputCodec: "mulaw",
          outputSampleRateHz: 8000,
          onEvent: () => {},
        });
        const socket = FakeWebSocket.instances[0]!;
        socket.simulateOpen();
        const tts = await pending;
        const config = JSON.parse(socket.sent[0]!) as { data: Record<string, unknown> };
        assert.ok(
          bulbulV3Enum.includes(config.data["language_code"] as string),
          `${lang.code} → ${String(config.data["language_code"])}`,
        );
        tts.close();
      });
    }
  });

  test("a close before open rejects immediately with a classified error instead of waiting out the connect timeout", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { connectSarvamStt, SarvamRealtimeError } = await import("./sarvam-realtime.server.ts");
      const pending = connectSarvamStt({
        language: "auto",
        sampleRateHz: 8000,
        encoding: "mulaw",
        onEvent: () => {},
      });
      FakeWebSocket.instances[0]!.simulateClose(4000, "Unsupported language_code");
      await assert.rejects(pending, (err: unknown) => {
        assert.ok(err instanceof SarvamRealtimeError);
        assert.equal(err.code, "rejected_request");
        return true;
      });
    });
  });

  test("1008 before open is reported as a timeout, not as rejected credentials", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { connectSarvamTts, SarvamRealtimeError } = await import("./sarvam-realtime.server.ts");
      const pending = connectSarvamTts({
        voiceId: "ritu",
        language: "hi-IN",
        pace: 1,
        outputCodec: "mulaw",
        outputSampleRateHz: 8000,
        onEvent: () => {},
      });
      FakeWebSocket.instances[0]!.simulateClose(1008);
      await assert.rejects(pending, (err: unknown) => {
        assert.ok(err instanceof SarvamRealtimeError);
        assert.equal(err.code, "timeout");
        return true;
      });
    });
  });
});
