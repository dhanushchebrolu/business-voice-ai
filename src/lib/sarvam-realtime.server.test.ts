import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { normalizeSttMessage, normalizeTtsMessage } from "./sarvam-realtime.server.ts";

// These tests intentionally run with SARVAM_API_KEY unset (this repository
// has no real Sarvam credentials anywhere — see PHASE_E_FINAL_REPORT.md
// "Real integration test status"). They verify the one thing that IS
// meaningfully testable without live credentials: that a missing key fails
// fast and clearly, before any socket is opened, rather than hanging or
// throwing something unstructured.
test("connectSarvamStt rejects with a structured error when SARVAM_API_KEY is unset", async () => {
  delete process.env["SARVAM_API_KEY"];
  const { connectSarvamStt, SarvamRealtimeError } = await import("./sarvam-realtime.server.ts");
  await assert.rejects(
    () =>
      connectSarvamStt({
        language: "en-IN",
        sampleRateHz: 8000,
        encoding: "mulaw",
        onEvent: () => {},
      }),
    (err: unknown) => {
      assert.ok(err instanceof SarvamRealtimeError);
      assert.equal(err.code, "not_configured");
      return true;
    },
  );
});

test("connectSarvamTts rejects with a structured error when SARVAM_API_KEY is unset", async () => {
  delete process.env["SARVAM_API_KEY"];
  const { connectSarvamTts, SarvamRealtimeError } = await import("./sarvam-realtime.server.ts");
  await assert.rejects(
    () =>
      connectSarvamTts({
        voiceId: "ritu",
        language: "en-IN",
        pace: 1,
        outputCodec: "mulaw",
        outputSampleRateHz: 8000,
        onEvent: () => {},
      }),
    (err: unknown) => {
      assert.ok(err instanceof SarvamRealtimeError);
      assert.equal(err.code, "not_configured");
      return true;
    },
  );
});

/**
 * Minimal fake of the browser-standard `WebSocket` surface this file's
 * `openSocket` actually uses (constructor(url, protocols), binaryType,
 * addEventListener, send, close, readyState) — just enough to drive
 * connectSarvamStt/connectSarvamTts through a real "open" handshake without
 * a live socket, so the exact URL passed to `new WebSocket(...)` can be
 * asserted directly instead of inferred.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  readonly url: string;
  readonly protocols: string[];
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, ((ev: unknown) => void)[]>();

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Test helper: simulates the server completing the handshake. */
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    for (const cb of this.listeners.get("open") ?? []) cb({});
  }

  /** Test helper: simulates an inbound text frame. */
  simulateMessage(data: string) {
    for (const cb of this.listeners.get("message") ?? []) cb({ data });
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

describe(
  "STT endpoint — production incident regression: a live call against " +
    "/speech-to-text/ws with model=saaras:v3-realtime was rejected by " +
    "Sarvam's own server (close code 4000, \"Invalid model " +
    "'saaras:v3-realtime'. Supported models: 'saarika...\"), proving that " +
    "endpoint only serves the saarika:* (batch/legacy) model family",
  () => {
    const originalKey = process.env["SARVAM_API_KEY"];
    afterEach(() => {
      if (originalKey === undefined) delete process.env["SARVAM_API_KEY"];
      else process.env["SARVAM_API_KEY"] = originalKey;
    });

    test("connectSarvamStt opens a socket against the dedicated realtime endpoint, not the legacy one", async () => {
      process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
      await withFakeWebSocket(async () => {
        const { connectSarvamStt } = await import("./sarvam-realtime.server.ts");
        const connectPromise = connectSarvamStt({
          language: "en-IN",
          sampleRateHz: 8000,
          encoding: "mulaw",
          onEvent: () => {},
        });
        assert.equal(FakeWebSocket.instances.length, 1);
        const socket = FakeWebSocket.instances[0]!;
        const url = new URL(socket.url);
        assert.equal(url.host, "api.sarvam.ai");
        assert.equal(
          url.pathname,
          "/speech-to-text-realtime/ws",
          "must use the realtime-dedicated path, not the legacy /speech-to-text/ws that production proved rejects saaras:v3-realtime",
        );
        assert.equal(
          url.searchParams.get("model"),
          "saaras:v3-realtime",
          "the model itself must stay unchanged — only the endpoint was wrong",
        );
        socket.simulateOpen();
        await connectPromise;
      });
    });
  },
);

describe("STT query param names — production incident round 2: once the endpoint was fixed, Sarvam rejected the connection with \"Missing required query parameter 'language_code'.\" because this file sent the hyphenated `language-code`/`sample-rate` instead of underscored `language_code`/`sample_rate`", () => {
  const originalKey = process.env["SARVAM_API_KEY"];
  afterEach(() => {
    if (originalKey === undefined) delete process.env["SARVAM_API_KEY"];
    else process.env["SARVAM_API_KEY"] = originalKey;
  });

  test("connectSarvamStt sends language_code and sample_rate with underscores, not hyphens", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { connectSarvamStt } = await import("./sarvam-realtime.server.ts");
      const connectPromise = connectSarvamStt({
        language: "te-IN",
        sampleRateHz: 8000,
        encoding: "mulaw",
        onEvent: () => {},
      });
      const socket = FakeWebSocket.instances[0]!;
      const url = new URL(socket.url);
      assert.equal(url.searchParams.get("language_code"), "te-IN");
      assert.equal(url.searchParams.get("sample_rate"), "8000");
      assert.equal(
        url.searchParams.has("language-code"),
        false,
        "the hyphenated param name production proved Sarvam rejects must not be sent",
      );
      assert.equal(url.searchParams.has("sample-rate"), false);
      assert.equal(url.searchParams.get("encoding"), "mulaw");
      socket.simulateOpen();
      await connectPromise;
    });
  });
});

describe('TTS config message — production incident: the WS handshake and tts_connected succeed, but Sarvam rejects the first config message with "Input parameters has to be a valid dictionary." because this file sent `target_language_code` instead of the documented `language_code` field, plus further schema bugs in the same payload (`model` sent as a data field instead of a query param, a bogus `output_audio_bitrate` field, and a missing `speech_sample_rate` — codec and sample rate are independent settings, and bulbul:v3 defaults to 24000 Hz regardless of codec)', () => {
  const originalKey = process.env["SARVAM_API_KEY"];
  afterEach(() => {
    if (originalKey === undefined) delete process.env["SARVAM_API_KEY"];
    else process.env["SARVAM_API_KEY"] = originalKey;
  });

  async function connectAndCaptureConfig() {
    const { connectSarvamTts } = await import("./sarvam-realtime.server.ts");
    // The config send happens synchronously once openSocket's promise
    // resolves, so simulateOpen() must fire before awaiting connect.
    const connectPromise = connectSarvamTts({
      voiceId: "ritu",
      language: "hi-IN",
      pace: 1,
      outputCodec: "mulaw",
      outputSampleRateHz: 8000,
      onEvent: () => {},
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.simulateOpen();
    await connectPromise;
    return socket;
  }

  test("connectSarvamTts sends model=bulbul:v3 as a WS URL query param, mirroring STT's proven-correct shape", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const socket = await connectAndCaptureConfig();
      const url = new URL(socket.url);
      assert.equal(url.host, "api.sarvam.ai");
      assert.equal(url.pathname, "/text-to-speech/ws");
      assert.equal(url.searchParams.get("model"), "bulbul:v3");
    });
  });

  test("connectSarvamTts sends a config message using the documented language_code field, not target_language_code", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const socket = await connectAndCaptureConfig();

      assert.equal(socket.sent.length, 1, "exactly one message (config) must be sent on connect");
      const configMessage = JSON.parse(socket.sent[0] as string) as {
        type: string;
        data: Record<string, unknown>;
      };
      assert.equal(configMessage.type, "config");
      assert.equal(typeof configMessage.data, "object");
      assert.ok(
        !Array.isArray(configMessage.data),
        "data must serialize as a JSON object, not an array",
      );

      assert.equal(
        configMessage.data["language_code"],
        "hi-IN",
        "must use the documented `language_code` field",
      );
      assert.equal(
        "target_language_code" in configMessage.data,
        false,
        'the field name production proved Sarvam rejects ("Input parameters has to be a valid dictionary") must not be sent',
      );
      assert.equal(configMessage.data["speaker"], "ritu");
      assert.equal(configMessage.data["output_audio_codec"], "mulaw");
      assert.equal(
        configMessage.data["speech_sample_rate"],
        "8000",
        "speech_sample_rate must be a STRING — a current working Sarvam implementation sends it as a string, not a number",
      );
      assert.equal(typeof configMessage.data["speech_sample_rate"], "string");
    });
  });

  test("connectSarvamTts sends speech_sample_rate as a string matching opts.outputSampleRateHz exactly — never a hardcoded value", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { connectSarvamTts } = await import("./sarvam-realtime.server.ts");
      const connectPromise = connectSarvamTts({
        voiceId: "ritu",
        language: "en-IN",
        pace: 1,
        outputCodec: "linear16",
        outputSampleRateHz: 16000,
        onEvent: () => {},
      });
      const socket = FakeWebSocket.instances[0]!;
      socket.simulateOpen();
      await connectPromise;
      const configMessage = JSON.parse(socket.sent[0] as string) as {
        data: Record<string, unknown>;
      };
      assert.equal(
        configMessage.data["speech_sample_rate"],
        "16000",
        "speech_sample_rate must track whatever the bridge actually declared (as a string), not a hardcoded 8000 — a non-Vobiz bridge with a different rate must not silently get 8000",
      );
      assert.equal(typeof configMessage.data["speech_sample_rate"], "string");
    });
  });

  test("connectSarvamTts never puts model inside the config data object — it belongs only in the WS URL query string", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const socket = await connectAndCaptureConfig();
      const configMessage = JSON.parse(socket.sent[0] as string) as {
        data: Record<string, unknown>;
      };
      assert.equal(
        "model" in configMessage.data,
        false,
        "model is a connection-level query param, not a data field — sending it as both/either in data is the schema bug production proved",
      );
    });
  });

  test("connectSarvamTts never sends output_audio_bitrate — the sample rate belongs in speech_sample_rate, not a bitrate field", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const socket = await connectAndCaptureConfig();
      const configMessage = JSON.parse(socket.sent[0] as string) as {
        data: Record<string, unknown>;
      };
      assert.equal(
        "output_audio_bitrate" in configMessage.data,
        false,
        "output_audio_bitrate named a compressed-codec bitrate (kbps), never a valid field for bulbul:v3 — must not be reintroduced even after adding speech_sample_rate",
      );
    });
  });

  test("the exact Vobiz call shape: output_audio_codec mulaw + speech_sample_rate 8000 together, matching Vobiz's own declared NATIVE_FORMAT", async () => {
    // Mirrors vobiz-media-bridge.server.ts's NATIVE_FORMAT = { encoding:
    // "mulaw", sampleRateHz: 8000 } verbatim, without importing or touching
    // that file — this is the exact opts a real Vobiz call produces via
    // voice-runtime.server.ts's outputCodecFor()/outboundFormat.sampleRateHz.
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const socket = await connectAndCaptureConfig();
      const configMessage = JSON.parse(socket.sent[0] as string) as {
        data: Record<string, unknown>;
      };
      assert.deepEqual(
        {
          output_audio_codec: configMessage.data["output_audio_codec"],
          speech_sample_rate: configMessage.data["speech_sample_rate"],
        },
        { output_audio_codec: "mulaw", speech_sample_rate: "8000" },
      );
    });
  });
});

describe('TTS text/flush wire messages — production incident round 3: the 422 "Input parameters has to be a valid dictionary" persisted unchanged across two config-only fixes, revealing the real bug was never the config — sendText() sent {"type":"convert",...}, but the current protocol\'s text-input type is "text"; "convert" was never a recognized type', () => {
  async function connectAndGetSession() {
    const { connectSarvamTts } = await import("./sarvam-realtime.server.ts");
    const connectPromise = connectSarvamTts({
      voiceId: "ritu",
      language: "hi-IN",
      pace: 1,
      outputCodec: "mulaw",
      outputSampleRateHz: 8000,
      onEvent: () => {},
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.simulateOpen();
    const session = await connectPromise;
    return { socket, session };
  }

  const originalKey = process.env["SARVAM_API_KEY"];
  afterEach(() => {
    if (originalKey === undefined) delete process.env["SARVAM_API_KEY"];
    else process.env["SARVAM_API_KEY"] = originalKey;
  });

  test('sendText sends {"type":"text","data":{"text":...}} — never "convert"', async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { socket, session } = await connectAndGetSession();
      session.sendText("Hello, thanks for calling.");

      assert.equal(socket.sent.length, 2, "config, then this one text message");
      const textMessage = JSON.parse(socket.sent[1] as string) as {
        type: string;
        data: Record<string, unknown>;
      };
      assert.equal(textMessage.type, "text", 'must be "text", not "convert"');
      assert.equal(typeof textMessage.data, "object");
      assert.ok(!Array.isArray(textMessage.data));
      assert.equal(typeof textMessage.data["text"], "string");
      assert.equal(textMessage.data["text"], "Hello, thanks for calling.");
    });
  });

  test("sendText is valid, parseable JSON with exactly the type/data top-level keys", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { socket, session } = await connectAndGetSession();
      session.sendText("hi");
      const raw = socket.sent[1] as string;
      assert.doesNotThrow(() => JSON.parse(raw), "must be valid JSON");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), ["data", "type"]);
      assert.deepEqual(Object.keys(parsed["data"] as object).sort(), ["text"]);
    });
  });

  test('flush sends valid JSON {"type":"flush"} with no data field', async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { socket, session } = await connectAndGetSession();
      session.flush();
      assert.equal(socket.sent.length, 2, "config, then this one flush message");
      const raw = socket.sent[1] as string;
      assert.doesNotThrow(() => JSON.parse(raw));
      const flushMessage = JSON.parse(raw) as Record<string, unknown>;
      assert.deepEqual(flushMessage, { type: "flush" });
    });
  });

  test("an empty string is never sent as a text message (sendText no-ops on falsy text, matching speak()'s per-chunk loop)", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { socket, session } = await connectAndGetSession();
      session.sendText("");
      assert.equal(
        socket.sent.length,
        1,
        "only the config message — sendText('') must not send anything",
      );
    });
  });
});

describe("normalizeTtsMessage audio event — surfaces whatever format metadata Sarvam includes alongside the payload (if any), so callers can verify actual output format against what was declared rather than assuming a match", () => {
  test("meta carries every field of the audio event's data object except the base64 payload itself", () => {
    const event = normalizeTtsMessage({
      type: "audio",
      data: { audio: Buffer.from("hi").toString("base64"), sample_rate: 8000, format: "mulaw" },
    });
    assert.equal(event.type, "audio");
    assert.deepEqual((event as { meta?: Record<string, unknown> }).meta, {
      sample_rate: 8000,
      format: "mulaw",
    });
  });

  test("meta is an empty object (not undefined) when Sarvam's audio event carries no extra fields", () => {
    const event = normalizeTtsMessage({
      type: "audio",
      data: { audio: Buffer.from("hi").toString("base64") },
    });
    assert.equal(event.type, "audio");
    assert.deepEqual((event as { meta?: Record<string, unknown> }).meta, {});
  });
});

describe(
  "TTS/STT error-detail extraction — production incident: both tts_error " +
    'messages logged in production ("Speech synthesis error", "Speech ' +
    "synthesis connection error\") were this file's own hardcoded fallback " +
    "text, not Sarvam's verbatim message, because the old normalizer only " +
    "ever checked a `message` field. Sarvam's error frame shape was never " +
    "independently confirmed, so this checks several plausible field names " +
    "rather than assuming one.",
  () => {
    test("normalizeTtsMessage surfaces a top-level `error` field when `message` is absent", () => {
      const event = normalizeTtsMessage({
        type: "error",
        error: "model not supported on this endpoint",
      });
      assert.deepEqual(event, {
        type: "error",
        message: "model not supported on this endpoint",
        raw: { type: "error", error: "model not supported on this endpoint" },
      });
    });

    test("normalizeTtsMessage surfaces a nested data.detail field", () => {
      const raw = { type: "error", data: { detail: "invalid target_language_code" } };
      const event = normalizeTtsMessage(raw);
      assert.equal(event.type, "error");
      assert.equal((event as { message: string }).message, "invalid target_language_code");
    });

    test("normalizeTtsMessage still prefers an explicit `message` field when present", () => {
      const event = normalizeTtsMessage({
        type: "error",
        message: "explicit message wins",
        error: "ignored",
      });
      assert.equal((event as { message: string }).message, "explicit message wins");
    });

    test("normalizeTtsMessage falls back to the generic string only when no known field is present", () => {
      const event = normalizeTtsMessage({
        type: "error",
        unexpected_field: "nothing recognizable here",
      });
      assert.equal((event as { message: string }).message, "Speech synthesis error");
    });

    test("normalizeSttMessage applies the same broadened extraction for STT error frames", () => {
      const event = normalizeSttMessage({ type: "error", reason: "invalid sample-rate" });
      assert.equal(event.type, "error");
      assert.equal((event as { message: string }).message, "invalid sample-rate");
    });

    test("error events never include anything resembling the outgoing API key (which is sent only as a WS auth subprotocol, never echoed in an inbound payload)", () => {
      const event = normalizeTtsMessage({
        type: "error",
        message: "boom",
        data: { extra: "detail" },
      });
      const serialized = JSON.stringify(event);
      assert.doesNotMatch(serialized, /api-subscription-key/);
      assert.doesNotMatch(serialized, /SARVAM_API_KEY/);
    });
  },
);

function captureInfoLogs() {
  const calls: { event: string; data: unknown }[] = [];
  const original = console.info;
  console.info = (event: unknown, data?: unknown) => {
    calls.push({ event: String(event), data });
  };
  return {
    calls,
    restore: () => {
      console.info = original;
    },
  };
}

describe("tts:config_sent / tts:text_sent / tts:flush_sent — temporary per-send diagnostics (production incident: synchronous fire-and-forget sends made log order alone insufficient to tell which outbound frame a later tts_error belonged to). Safe fields only: never the API key/auth subprotocol, never audio, never more than a short preview of spoken text.", () => {
  const originalKey = process.env["SARVAM_API_KEY"];
  afterEach(() => {
    if (originalKey === undefined) delete process.env["SARVAM_API_KEY"];
    else process.env["SARVAM_API_KEY"] = originalKey;
  });

  test("tts:config_sent logs safe config shape/type info — never the raw auth subprotocol or API key", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret-xyz987";
    const logs = captureInfoLogs();
    try {
      await withFakeWebSocket(async () => {
        const { connectSarvamTts } = await import("./sarvam-realtime.server.ts");
        const connectPromise = connectSarvamTts({
          voiceId: "ritu",
          language: "hi-IN",
          pace: 1,
          outputCodec: "mulaw",
          outputSampleRateHz: 8000,
          onEvent: () => {},
        });
        FakeWebSocket.instances[0]!.simulateOpen();
        await connectPromise;
      });
    } finally {
      logs.restore();
    }

    const entry = logs.calls.find((c) => c.event === "tts:config_sent");
    assert.ok(entry, "expected tts:config_sent to fire");
    const data = entry!.data as Record<string, unknown>;
    assert.deepEqual(data["topLevelKeys"], ["type", "data"]);
    assert.equal(data["codec"], "mulaw");
    assert.equal(data["sampleRateValue"], "8000");
    assert.equal(data["sampleRateType"], "string");
    assert.equal(data["languageCode"], "hi-IN");
    assert.equal(data["speaker"], "ritu");

    const serialized = JSON.stringify(logs.calls);
    assert.doesNotMatch(serialized, /test-key-not-a-real-secret-xyz987/);
    assert.doesNotMatch(serialized, /api-subscription-key/);
  });

  test("tts:text_sent logs only a length and a <=20-char preview — never the full text", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    const longText =
      "This sentence is deliberately much longer than twenty characters so the preview truncation is actually exercised.";
    const logs = captureInfoLogs();
    try {
      await withFakeWebSocket(async () => {
        const { connectSarvamTts } = await import("./sarvam-realtime.server.ts");
        const connectPromise = connectSarvamTts({
          voiceId: "ritu",
          language: "hi-IN",
          pace: 1,
          outputCodec: "mulaw",
          outputSampleRateHz: 8000,
          onEvent: () => {},
        });
        FakeWebSocket.instances[0]!.simulateOpen();
        const session = await connectPromise;
        session.sendText(longText);
      });
    } finally {
      logs.restore();
    }

    const entry = logs.calls.find((c) => c.event === "tts:text_sent");
    assert.ok(entry, "expected tts:text_sent to fire");
    const data = entry!.data as Record<string, unknown>;
    assert.equal(data["textType"], "string");
    assert.equal(data["textLength"], longText.length);
    assert.equal(data["textPreview"], longText.slice(0, 20));
    assert.ok((data["textPreview"] as string).length <= 20);

    const serialized = JSON.stringify(logs.calls);
    assert.doesNotMatch(
      serialized,
      /deliberately much longer than twenty characters/,
      "the full transcript must never appear in logs, only the 20-char preview",
    );
  });

  test("tts:flush_sent logs the exact safe flush shape", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    const logs = captureInfoLogs();
    try {
      await withFakeWebSocket(async () => {
        const { connectSarvamTts } = await import("./sarvam-realtime.server.ts");
        const connectPromise = connectSarvamTts({
          voiceId: "ritu",
          language: "hi-IN",
          pace: 1,
          outputCodec: "mulaw",
          outputSampleRateHz: 8000,
          onEvent: () => {},
        });
        FakeWebSocket.instances[0]!.simulateOpen();
        const session = await connectPromise;
        session.flush();
      });
    } finally {
      logs.restore();
    }

    const entry = logs.calls.find((c) => c.event === "tts:flush_sent");
    assert.ok(entry, "expected tts:flush_sent to fire");
    assert.deepEqual(entry!.data, { shape: { type: "flush" } });
  });
});

describe('STT outbound audio wire shape — production incident round 3 (after TTS was fixed and confirmed working): STT connects and accepts query params with no error, but never produces a transcript. sendAudioFrame sent the raw Uint8Array as a BINARY WebSocket frame with no JSON envelope at all; the current realtime protocol expects a JSON text frame {"event":"audio_input","audio":"<base64>"}', () => {
  const originalKey = process.env["SARVAM_API_KEY"];
  afterEach(() => {
    if (originalKey === undefined) delete process.env["SARVAM_API_KEY"];
    else process.env["SARVAM_API_KEY"] = originalKey;
  });

  async function connectAndGetSttSession(opts?: {
    sampleRateHz?: number;
    encoding?: "linear16" | "mulaw";
  }) {
    const { connectSarvamStt } = await import("./sarvam-realtime.server.ts");
    const connectPromise = connectSarvamStt({
      language: "hi-IN",
      sampleRateHz: opts?.sampleRateHz ?? 8000,
      encoding: opts?.encoding ?? "mulaw",
      onEvent: () => {},
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.simulateOpen();
    const session = await connectPromise;
    return { socket, session };
  }

  test('sendAudioFrame sends a JSON TEXT frame {"event":"audio_input","audio":"<base64>"}, never a raw binary frame', async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { socket, session } = await connectAndGetSttSession();
      const audio = new Uint8Array([1, 2, 3, 4, 5]);
      session.sendAudioFrame(audio);

      assert.equal(socket.sent.length, 1);
      const sent = socket.sent[0];
      assert.equal(
        typeof sent,
        "string",
        "must be a JSON text frame, not a binary Uint8Array frame",
      );
      const parsed = JSON.parse(sent as string) as Record<string, unknown>;
      assert.equal(parsed["event"], "audio_input");
      assert.equal(typeof parsed["audio"], "string");
      assert.equal(parsed["audio"], Buffer.from(audio).toString("base64"));
    });
  });

  test("sendAudioFrame base64-encodes the exact same bytes handed to it — no resampling, no re-encoding of the audio data itself", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { socket, session } = await connectAndGetSttSession();
      // Arbitrary mulaw-looking bytes — the point is round-tripping them
      // unchanged, not that they decode to anything meaningful.
      const audio = new Uint8Array([0xff, 0x00, 0x7e, 0x81, 0x55]);
      session.sendAudioFrame(audio);
      const parsed = JSON.parse(socket.sent[0] as string) as { audio: string };
      const roundTripped = new Uint8Array(Buffer.from(parsed.audio, "base64"));
      assert.deepEqual(Array.from(roundTripped), Array.from(audio));
    });
  });

  test("multiple sendAudioFrame calls each produce their own audio_input message, in order", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { socket, session } = await connectAndGetSttSession();
      session.sendAudioFrame(new Uint8Array([1]));
      session.sendAudioFrame(new Uint8Array([2]));
      session.sendAudioFrame(new Uint8Array([3]));
      assert.equal(socket.sent.length, 3);
      for (const raw of socket.sent) {
        const parsed = JSON.parse(raw as string) as Record<string, unknown>;
        assert.equal(parsed["event"], "audio_input");
      }
    });
  });
});

function captureSttInfoLogs() {
  const calls: { event: string; data: unknown }[] = [];
  const original = console.info;
  console.info = (event: unknown, data?: unknown) => {
    calls.push({ event: String(event), data });
  };
  return {
    calls,
    restore: () => {
      console.info = original;
    },
  };
}

describe("stt:audio_sent / stt:event_received — temporary per-send/per-receive diagnostics (production incident: STT connects and accepts audio with no error, but never produces a transcript — this traces every outbound audio frame and inbound wire message so a silently-ignored call is distinguishable from one that never got any audio at all). Safe fields only: never the base64 audio, never the full transcript text.", () => {
  const originalKey = process.env["SARVAM_API_KEY"];
  afterEach(() => {
    if (originalKey === undefined) delete process.env["SARVAM_API_KEY"];
    else process.env["SARVAM_API_KEY"] = originalKey;
  });

  test("stt:audio_sent logs length/duration/sequence/format metadata — never the base64 audio itself", async () => {
    const logs = captureSttInfoLogs();
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    try {
      await withFakeWebSocket(async () => {
        const { connectSarvamStt } = await import("./sarvam-realtime.server.ts");
        const connectPromise = connectSarvamStt({
          language: "hi-IN",
          sampleRateHz: 8000,
          encoding: "mulaw",
          onEvent: () => {},
        });
        FakeWebSocket.instances[0]!.simulateOpen();
        const session = await connectPromise;
        // 160 bytes at 8kHz mulaw (1 byte/sample) = 20ms — the real Vobiz frame size.
        session.sendAudioFrame(new Uint8Array(160));
      });
    } finally {
      logs.restore();
    }

    const entry = logs.calls.find((c) => c.event === "stt:audio_sent");
    assert.ok(entry, "expected stt:audio_sent to fire");
    const data = entry!.data as Record<string, unknown>;
    assert.equal(data["byteLength"], 160);
    assert.equal(data["durationMs"], 20);
    assert.equal(data["sequence"], 1);
    assert.equal(data["sampleRateHz"], 8000);
    assert.equal(data["encoding"], "mulaw");
    assert.equal(data["event"], "audio_input");
    assert.equal(typeof data["base64Length"], "number");

    const serialized = JSON.stringify(logs.calls);
    assert.doesNotMatch(serialized, /test-key-not-a-real-secret/);
  });

  test("stt:audio_sent computes durationMs correctly for linear16 (2 bytes/sample)", async () => {
    const logs = captureSttInfoLogs();
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    try {
      await withFakeWebSocket(async () => {
        const { connectSarvamStt } = await import("./sarvam-realtime.server.ts");
        const connectPromise = connectSarvamStt({
          language: "en-IN",
          sampleRateHz: 8000,
          encoding: "linear16",
          onEvent: () => {},
        });
        FakeWebSocket.instances[0]!.simulateOpen();
        const session = await connectPromise;
        // 320 bytes at 8kHz linear16 (2 bytes/sample) = 160 samples = 20ms.
        session.sendAudioFrame(new Uint8Array(320));
      });
    } finally {
      logs.restore();
    }

    const entry = logs.calls.find((c) => c.event === "stt:audio_sent");
    const data = entry!.data as Record<string, unknown>;
    assert.equal(data["durationMs"], 20);
  });

  test("stt:event_received logs transcript presence/length but never the transcript text itself", async () => {
    const logs = captureSttInfoLogs();
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    try {
      await withFakeWebSocket(async () => {
        const { connectSarvamStt } = await import("./sarvam-realtime.server.ts");
        const connectPromise = connectSarvamStt({
          language: "hi-IN",
          sampleRateHz: 8000,
          encoding: "mulaw",
          onEvent: () => {},
        });
        const socket = FakeWebSocket.instances[0]!;
        socket.simulateOpen();
        await connectPromise;
        socket.simulateMessage(
          JSON.stringify({ type: "final_transcript", transcript: "a secret caller said this" }),
        );
      });
    } finally {
      logs.restore();
    }

    const entry = logs.calls.find((c) => c.event === "stt:event_received");
    assert.ok(entry, "expected stt:event_received to fire");
    const data = entry!.data as Record<string, unknown>;
    assert.equal(data["hasTranscript"], true);
    assert.equal(data["transcriptLength"], "a secret caller said this".length);
    assert.equal(data["isError"], false);

    const serialized = JSON.stringify(logs.calls);
    assert.doesNotMatch(serialized, /a secret caller said this/);
  });

  test("stt:event_received surfaces an error's code/message safely when the wire event is an error", async () => {
    const logs = captureSttInfoLogs();
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    try {
      await withFakeWebSocket(async () => {
        const { connectSarvamStt } = await import("./sarvam-realtime.server.ts");
        const connectPromise = connectSarvamStt({
          language: "hi-IN",
          sampleRateHz: 8000,
          encoding: "mulaw",
          onEvent: () => {},
        });
        const socket = FakeWebSocket.instances[0]!;
        socket.simulateOpen();
        await connectPromise;
        socket.simulateMessage(
          JSON.stringify({ type: "error", data: { code: 422, message: "bad request" } }),
        );
      });
    } finally {
      logs.restore();
    }

    const entry = logs.calls.find((c) => c.event === "stt:event_received");
    assert.ok(entry);
    const data = entry!.data as Record<string, unknown>;
    assert.equal(data["isError"], true);
    assert.equal(data["errorCode"], 422);
    assert.equal(data["errorMessage"], "bad request");
  });
});
