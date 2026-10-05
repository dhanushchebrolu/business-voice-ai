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

describe('TTS config message — production incident: the WS handshake and tts_connected succeed, but Sarvam rejects the first config message with "Input parameters has to be a valid dictionary." because this file sent `target_language_code` instead of the documented `language_code` field', () => {
  const originalKey = process.env["SARVAM_API_KEY"];
  afterEach(() => {
    if (originalKey === undefined) delete process.env["SARVAM_API_KEY"];
    else process.env["SARVAM_API_KEY"] = originalKey;
  });

  test("connectSarvamTts sends a config message using the documented language_code field, not target_language_code", async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-a-real-secret";
    await withFakeWebSocket(async () => {
      const { connectSarvamTts } = await import("./sarvam-realtime.server.ts");
      const socket = (() => {
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
        const s = FakeWebSocket.instances[0]!;
        s.simulateOpen();
        return connectPromise.then(() => s);
      })();
      const s = await socket;

      assert.equal(s.sent.length, 1, "exactly one message (config) must be sent on connect");
      const configMessage = JSON.parse(s.sent[0] as string) as {
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
      // Unconfirmed-but-unchanged fields: still present, not blindly
      // stripped out without evidence they're the actual cause.
      assert.equal(configMessage.data["model"], "bulbul:v3");
      assert.equal(configMessage.data["output_audio_codec"], "mulaw");
      assert.equal(configMessage.data["output_audio_bitrate"], 8000);
    });
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
