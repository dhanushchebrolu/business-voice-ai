/**
 * Sarvam realtime voice WebSocket clients — server-only.
 *
 * Speech-to-text: `saaras:v3-realtime` streaming API.
 * Text-to-speech: `bulbul:v3` streaming API.
 *
 * VERIFICATION NOTE: this environment's network egress is restricted to an
 * allowlisted proxy that does not reach docs.sarvam.ai, so the exact
 * message-level JSON schema below could not be confirmed against Sarvam's
 * live API reference at implementation time (only search-result summaries
 * of it were reachable — see PHASE_E_FINAL_REPORT.md §5 for what was and
 * wasn't confirmed, with sources). What IS used here is deliberately
 * limited to what those summaries actually stated:
 *   - auth via the `api-subscription-key.<key>` WebSocket subprotocol
 *     (the browser-compatible mechanism; Node's WebSocket global has the
 *     same constructor shape and cannot send arbitrary headers either)
 *   - STT: language_code as a connection query param, VAD auto mode by
 *     default, vad.speech_start / vad.speech_end events
 *   - TTS: a `config` message first, then `convert` / `flush` / `ping` /
 *     `close` client messages, `audio` server messages
 * Every incoming message is parsed defensively (`normalizeSttMessage` /
 * normalizeTtsMessage`) against multiple plausible shapes rather than
 * assuming one is correct, and an unrecognized shape is surfaced as a
 * structured `unknown` event (logged, never thrown) instead of crashing the
 * call. This must be re-verified against the live docs — or, better, a real
 * session with SARVAM_API_KEY set — before relying on it in production;
 * see the Phase E report's "Real integration test status".
 */

const STT_WS_URL = "wss://api.sarvam.ai/speech-to-text/ws";
const TTS_WS_URL = "wss://api.sarvam.ai/text-to-speech/ws";

export const SARVAM_REALTIME_MODELS = {
  stt: "saaras:v3-realtime",
  tts: "bulbul:v3",
} as const;

function apiKey(): string {
  const key = process.env["SARVAM_API_KEY"];
  if (!key)
    throw new SarvamRealtimeError(
      "not_configured",
      "The AI voice provider is not configured for this workspace.",
    );
  return key;
}

function authSubprotocol(): string {
  return `api-subscription-key.${apiKey()}`;
}

export class SarvamRealtimeError extends Error {
  code: "not_configured" | "auth_failed" | "connect_failed" | "timeout" | "protocol_error";
  constructor(code: SarvamRealtimeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const CONNECT_TIMEOUT_MS = 8_000;

async function openSocket(url: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<WebSocket> {
  const socket = new WebSocket(url, [authSubprotocol()]);
  socket.binaryType = "arraybuffer";
  return await new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new SarvamRealtimeError("timeout", "Timed out connecting to the AI voice provider."));
    }, timeoutMs);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(
          new SarvamRealtimeError("connect_failed", "Could not connect to the AI voice provider."),
        );
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (ev) => {
        clearTimeout(timer);
        if (ev.code === 1008 || ev.code === 4001 || ev.code === 4003) {
          reject(
            new SarvamRealtimeError(
              "auth_failed",
              "The AI voice provider rejected the platform credentials.",
            ),
          );
        }
      },
      { once: true },
    );
  });
}

/* ------------------------------------------------------------------ */
/* STT — saaras:v3-realtime                                            */
/* ------------------------------------------------------------------ */

export type SttEvent =
  | { type: "partial_transcript"; text: string; language?: string | undefined }
  | { type: "final_transcript"; text: string; language?: string | undefined }
  | { type: "speech_start" }
  | { type: "speech_end" }
  | { type: "language_detected"; language: string }
  | { type: "error"; message: string }
  | { type: "closed"; code: number; reason: string }
  | { type: "unknown"; raw: unknown };

export interface SttSession {
  sendAudioFrame(data: Uint8Array): void;
  close(): void;
}

export interface ConnectSttOptions {
  /** BCP-47-ish Sarvam language code (e.g. "te-IN"), or "unknown" for auto-detect. */
  language: string;
  sampleRateHz: number;
  encoding: "linear16" | "mulaw";
  onEvent: (event: SttEvent) => void;
}

function normalizeSttMessage(raw: unknown): SttEvent {
  if (typeof raw !== "object" || raw === null) return { type: "unknown", raw };
  const msg = raw as Record<string, unknown>;
  const kind = String(msg["type"] ?? msg["event"] ?? "");

  if (kind === "vad.speech_start" || kind === "speech_start") return { type: "speech_start" };
  if (kind === "vad.speech_end" || kind === "speech_end") return { type: "speech_end" };

  if (kind === "error") {
    const message =
      typeof msg["message"] === "string" ? (msg["message"] as string) : "Speech recognition error";
    return { type: "error", message };
  }

  // Two plausible transcript envelopes: a flat {type:"transcript", transcript, is_final}
  // and a nested {type:"data", data:{transcript, is_final|metrics}} (the shape confirmed
  // for Sarvam's legacy, non-realtime streaming API — kept as a fallback since the
  // realtime envelope could not be independently confirmed).
  const data = (msg["data"] as Record<string, unknown> | undefined) ?? msg;
  const transcript = data["transcript"];
  if (typeof transcript === "string") {
    const isFinal =
      Boolean(data["is_final"] ?? msg["is_final"]) ||
      kind === "final_transcript" ||
      kind === "transcript.final";
    const language =
      typeof data["language_code"] === "string" ? (data["language_code"] as string) : undefined;
    return isFinal
      ? { type: "final_transcript", text: transcript, language }
      : { type: "partial_transcript", text: transcript, language };
  }

  if (kind === "language_detected" && typeof msg["language_code"] === "string") {
    return { type: "language_detected", language: msg["language_code"] as string };
  }

  return { type: "unknown", raw };
}

export async function connectSarvamStt(opts: ConnectSttOptions): Promise<SttSession> {
  const url = new URL(STT_WS_URL);
  url.searchParams.set("model", SARVAM_REALTIME_MODELS.stt);
  url.searchParams.set("language-code", opts.language);
  url.searchParams.set("sample-rate", String(opts.sampleRateHz));
  url.searchParams.set("encoding", opts.encoding);
  // Server-driven VAD (the documented default) — no manual speech_start/end framing needed.
  url.searchParams.set("vad-signals", "true");

  const socket = await openSocket(url.toString());

  socket.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return; // binary frames from this endpoint are not expected inbound
    try {
      opts.onEvent(normalizeSttMessage(JSON.parse(ev.data)));
    } catch {
      opts.onEvent({ type: "unknown", raw: ev.data });
    }
  });
  socket.addEventListener("close", (ev) => {
    opts.onEvent({ type: "closed", code: ev.code, reason: ev.reason });
  });
  socket.addEventListener("error", () => {
    opts.onEvent({ type: "error", message: "Speech recognition connection error" });
  });

  return {
    sendAudioFrame(data: Uint8Array) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close(1000, "done");
    },
  };
}

/* ------------------------------------------------------------------ */
/* TTS — bulbul:v3 streaming                                           */
/* ------------------------------------------------------------------ */

export type TtsEvent =
  | { type: "audio"; data: Uint8Array }
  | { type: "flushed" }
  | { type: "error"; message: string }
  | { type: "closed"; code: number; reason: string }
  | { type: "unknown"; raw: unknown };

export interface TtsSession {
  /** Streams one chunk of text to be synthesized (call repeatedly as sentences complete). */
  sendText(text: string): void;
  /** Forces synthesis of whatever text has been sent so far, without waiting for more. */
  flush(): void;
  close(): void;
}

export interface ConnectTtsOptions {
  voiceId: string;
  language: string;
  pace: number;
  /** Output codec the telephony leg expects — resolved from the audio bridge's outbound format. */
  outputCodec: "mulaw" | "linear16" | "wav";
  outputSampleRateHz: number;
  onEvent: (event: TtsEvent) => void;
}

function normalizeTtsMessage(raw: unknown): TtsEvent {
  if (typeof raw !== "object" || raw === null) return { type: "unknown", raw };
  const msg = raw as Record<string, unknown>;
  const kind = String(msg["type"] ?? msg["event"] ?? "");

  if (kind === "audio") {
    const data = (msg["data"] as Record<string, unknown> | undefined) ?? msg;
    const audio = data["audio"];
    if (typeof audio === "string") {
      try {
        return { type: "audio", data: Uint8Array.from(Buffer.from(audio, "base64")) };
      } catch {
        return { type: "error", message: "Malformed audio chunk from the AI voice provider" };
      }
    }
  }
  if (kind === "flushed" || kind === "flush_ack") return { type: "flushed" };
  if (kind === "error") {
    const message =
      typeof msg["message"] === "string" ? (msg["message"] as string) : "Speech synthesis error";
    return { type: "error", message };
  }
  return { type: "unknown", raw };
}

export async function connectSarvamTts(opts: ConnectTtsOptions): Promise<TtsSession> {
  const socket = await openSocket(TTS_WS_URL);

  socket.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      opts.onEvent(normalizeTtsMessage(JSON.parse(ev.data)));
    } catch {
      opts.onEvent({ type: "unknown", raw: ev.data });
    }
  });
  socket.addEventListener("close", (ev) => {
    opts.onEvent({ type: "closed", code: ev.code, reason: ev.reason });
  });
  socket.addEventListener("error", () => {
    opts.onEvent({ type: "error", message: "Speech synthesis connection error" });
  });

  // Config must be the first message on the socket (documented requirement).
  socket.send(
    JSON.stringify({
      type: "config",
      data: {
        target_language_code: opts.language,
        speaker: opts.voiceId,
        model: SARVAM_REALTIME_MODELS.tts,
        pace: Math.min(2, Math.max(0.5, opts.pace)),
        output_audio_codec: opts.outputCodec,
        output_audio_bitrate: opts.outputSampleRateHz,
      },
    }),
  );

  return {
    sendText(text: string) {
      if (!text) return;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "convert", data: { text } }));
      }
    },
    flush() {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "flush" }));
    },
    close() {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "close" }));
        socket.close(1000, "done");
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
  };
}
