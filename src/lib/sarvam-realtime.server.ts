/**
 * Sarvam realtime voice WebSocket clients — server-only.
 *
 * Speech-to-text: `saaras:v3-realtime` streaming API.
 * Text-to-speech: `bulbul:v3` streaming API.
 *
 * STT ENDPOINT — CONFIRMED BY PRODUCTION: a live call against
 * `/speech-to-text/ws` with `model=saaras:v3-realtime` was rejected by
 * Sarvam's own server with close code 4000, reason "Invalid model
 * 'saaras:v3-realtime'. Supported models: 'saarika...'" — proving
 * `/speech-to-text/ws` is the batch/legacy endpoint (saarika:* models
 * only), not the realtime one. Fixed: STT now connects to
 * `/speech-to-text-realtime/ws`.
 *
 * STT QUERY PARAM NAMES — CONFIRMED BY PRODUCTION (round 2): the realtime
 * endpoint then rejected the connection with "Missing required query
 * parameter 'language_code'." — this file was sending `language-code`
 * (hyphenated). Fixed to `language_code` (underscore); `sample-rate` was
 * the identical bug and is now `sample_rate` too. `model` and `encoding`
 * were already spelled correctly. `vad-signals` remains unconfirmed either
 * way (no production evidence yet) and was left untouched.
 *
 * TTS CONFIG FIELD NAME — CONFIRMED BY PRODUCTION: the WS handshake and
 * `tts_connected` succeed, but the server rejects the first `config`
 * message with "Input parameters has to be a valid dictionary." This file
 * was sending `target_language_code`; the documented config contract is
 * `{"type":"config","data":{"language_code":"...","speaker":"..."}}`.
 * Fixed to `language_code`.
 *
 * TTS CONFIG SCHEMA — `model` CONFIRMED BY PRODUCTION, `speech_sample_rate`
 * per user-supplied Sarvam documentation (not yet independently verified by
 * a live call the way the fixes above were — this sandbox still cannot
 * reach docs.sarvam.ai directly; see the VERIFICATION NOTE below). `model`
 * is a connection-level query param
 * (`?model=bulbul:v3` on TTS_WS_URL), exactly mirroring STT's
 * `?model=saaras:v3-realtime` — not a `data` field, which is why the
 * documented minimal contract above never lists it. `output_audio_bitrate`
 * has been removed outright: "bitrate" names a compressed-codec property
 * (kbps), not a sample rate, so it was never a valid field for a PCM/
 * companded codec like mulaw.
 *
 * CORRECTION (do not repeat this mistake): an earlier revision of this
 * comment claimed `output_audio_codec: "mulaw"` alone fully declared the
 * output format because mulaw is a fixed-rate telephony codec. That is
 * wrong — codec and sample rate are independent, separately-negotiated
 * settings in Sarvam's realtime API, and bulbul:v3's documented default
 * sample rate is 24000 Hz regardless of codec (8000 Hz is supported, but
 * only if asked for). `speech_sample_rate` is now sent explicitly in
 * `config.data` alongside `output_audio_codec`. Getting this wrong would
 * not have surfaced as a connection error — Sarvam would have happily
 * generated 24kHz audio that the Vobiz bridge forwards byte-for-byte
 * (declaring mulaw/8kHz the whole time) without resampling, producing
 * corrupted/garbled audio on a live call with no error anywhere in the
 * logs. `outputSampleRateHz` (`ConnectTtsOptions`, see its own doc
 * comment) is the single source for this value — never hardcode 8000
 * elsewhere in this file. voice-runtime.server.ts's
 * `first_outbound_audio_frame` diagnostic is verification only: it logs
 * the declared format next to whatever metadata Sarvam's own audio event
 * happens to carry, so a mismatch is visible after the fact — it is not
 * itself what makes the format correct; `speech_sample_rate` in the config
 * message is.
 *
 * TTS MESSAGE TYPE — the 422 "Input parameters has to be a valid
 * dictionary" persisted, UNCHANGED, across both of the above fixes
 * (`language_code`, then `speech_sample_rate`) — strong evidence the config
 * message was never the actual problem. `sendText()` sent
 * `{"type":"convert","data":{"text":...}}`; the current protocol's
 * text-input message type is `"text"`, not `"convert"` — `convert` was
 * never a recognized type at all. Fixed to `type: "text"`. Also sending
 * `speech_sample_rate` as a STRING (`"8000"`), not a number — per a
 * current working Sarvam implementation (user-supplied; like the fields
 * above, not independently verifiable from this sandbox). `flush`
 * (`{"type":"flush"}`, no `data`) was already correct and is unchanged.
 * `tts:config_sent`/`tts:text_sent`/`tts:flush_sent` diagnostics (see
 * connectSarvamTts) now trace every outbound frame's safe shape, since
 * synchronous fire-and-forget sends make log *order* alone insufficient to
 * attribute a later `tts_error` to a specific message. If the 422 recurs
 * after this fix, `tts_error`'s `raw` field (see `extractErrorDetail`
 * below) combined with these per-send traces will show exactly which
 * frame Sarvam rejected and why.
 *
 * VERIFICATION NOTE (re-checked, still unresolved for everything below this
 * line — see docs/voice-pipeline-testing.md): this sandbox's network egress
 * cannot reach docs.sarvam.ai or any other documentation host directly
 * (confirmed again on a second pass: WebFetch to docs.sarvam.ai,
 * docs.pipecat.ai, docs.slng.ai, and a personal blog all returned
 * EGRESS_BLOCKED). WebSearch itself works (routed differently) and a
 * third-party community Rust SDK (github.com/skundu42/sarvam-rs) was
 * reachable via raw.githubusercontent.com — neither is Sarvam's own primary
 * documentation, so nothing below is "confirmed"; it is the most specific,
 * sourced information obtainable without a live SARVAM_API_KEY call.
 *
 * CONFIRMED (converging from multiple independent sources):
 *   - TTS: `wss://api.sarvam.ai/text-to-speech/ws`, config message first,
 *     then `text`/`flush`/`close` client message types, `bulbul:v3`. (This
 *     file sent `convert` instead of `text` until the TTS MESSAGE TYPE fix
 *     below — a stale, incorrect value in this very doc comment, not just
 *     the code; the two had drifted apart.)
 *   - Auth: an `api-subscription-key` mechanism (this file uses it as a WS
 *     subprotocol — the one auth-attachment method available to a browser-
 *     compatible `WebSocket` constructor, which Node's global also is).
 *
 * NOT CONFIRMED — specific, actionable leads (highest-value diagnostic: if
 * STT connects but never emits a single transcript event for audio that is
 * clearly being sent, check these in order):
 *   1. STT audio transport: this file sends raw binary frames
 *      (`socket.send(data)` on a `Uint8Array`). The same SDK instead
 *      base64-encodes each chunk and sends a JSON **text** frame:
 *      `{"event":"audio_input","audio":"<base64>"}`. If real audio frames
 *      produce zero STT events, this is the first thing to try.
 *   2. STT `vad-signals` query param casing: unlike `language_code`/
 *      `sample_rate` (confirmed underscored by production), this one has no
 *      direct evidence either way and was deliberately left as-is.
 *   3. TTS `pace` config field: still unconfirmed either way — not part of
 *      the minimal documented contract, but nothing in production evidence
 *      suggests it's wrong either (unlike `model`/`output_audio_bitrate`,
 *      now fixed — see the TTS notes above), and it's needed for the
 *      configurable speaking rate feature, so left unchanged.
 *   4. TTS WS path: by analogy with STT's confirmed endpoint bug, Sarvam may
 *      also require a dedicated realtime path (e.g.
 *      `/text-to-speech-realtime/ws`) distinct from `/text-to-speech/ws` for
 *      `bulbul:v3`. Still an unconfirmed hypothesis, not evidence — nothing
 *      in production has named an unsupported model/endpoint for TTS the
 *      way it did for STT.
 * Every incoming message is parsed defensively (`normalizeSttMessage` /
 * `normalizeTtsMessage`) against multiple plausible shapes rather than
 * assuming one is correct, and an unrecognized shape is surfaced as a
 * structured `unknown` event (logged, never thrown) instead of crashing the
 * call — this bounds the blast radius of any of the above being wrong, but
 * does not fix a wrong connection URL or a wrong audio-transport shape,
 * which need an actual code change once confirmed.
 *
 * See also sarvam.server.ts's own doc comment: its chat model was updated
 * to "sarvam-105b-conversations" (from "sarvam-m") and its batch STT model
 * to "saaras:v3" (from "saaras:v2.5") on user-supplied reference, not an
 * independently-reachable doc — same unresolved-until-a-real-call caveat as
 * everything in this file. The realtime models below ("saaras:v3-realtime",
 * "bulbul:v3") were not part of that change and remain as they were.
 */

const STT_WS_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws";
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

/**
 * Extracts a human-readable error detail from a Sarvam error frame, trying
 * several plausible field names rather than assuming `message` — added
 * after production proved `normalizeTtsMessage`'s old `message`-only check
 * was silently discarding Sarvam's actual rejection text for TTS (the
 * observed "Speech synthesis error" was this file's own generic fallback,
 * not anything Sarvam sent). Never reads from the outgoing auth
 * subprotocol/API key — this only inspects an inbound server payload.
 */
function extractErrorDetail(msg: Record<string, unknown>): string | undefined {
  const data = (msg["data"] as Record<string, unknown> | undefined) ?? msg;
  for (const source of [data, msg]) {
    for (const key of [
      "message",
      "error",
      "detail",
      "reason",
      "error_message",
      "error_description",
    ]) {
      const value = source[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return undefined;
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
  | { type: "error"; message: string; raw?: unknown }
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

export function normalizeSttMessage(raw: unknown): SttEvent {
  if (typeof raw !== "object" || raw === null) return { type: "unknown", raw };
  const msg = raw as Record<string, unknown>;
  const kind = String(msg["type"] ?? msg["event"] ?? "");

  if (kind === "vad.speech_start" || kind === "speech_start") return { type: "speech_start" };
  if (kind === "vad.speech_end" || kind === "speech_end") return { type: "speech_end" };

  if (kind === "error") {
    const message = extractErrorDetail(msg) ?? "Speech recognition error";
    return { type: "error", message, raw: msg };
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
  url.searchParams.set("language_code", opts.language);
  url.searchParams.set("sample_rate", String(opts.sampleRateHz));
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
  | { type: "audio"; data: Uint8Array; meta?: Record<string, unknown> }
  | { type: "flushed" }
  | { type: "error"; message: string; raw?: unknown }
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
  /**
   * Sample rate the telephony leg expects — resolved from the audio
   * bridge's outbound format. Sent to Sarvam as `speech_sample_rate`
   * (separate from `outputCodec`/`output_audio_codec`: codec and sample
   * rate are independent settings, and bulbul:v3 otherwise defaults to
   * 24000 Hz regardless of codec — see connectSarvamTts). Also kept for
   * the caller's own format-verification diagnostics
   * (declaredTtsOutputSampleRateHz in voice-runtime.server.ts), which
   * verify the declared value was honored — they don't by themselves
   * cause it to be.
   */
  outputSampleRateHz: number;
  onEvent: (event: TtsEvent) => void;
}

export function normalizeTtsMessage(raw: unknown): TtsEvent {
  if (typeof raw !== "object" || raw === null) return { type: "unknown", raw };
  const msg = raw as Record<string, unknown>;
  const kind = String(msg["type"] ?? msg["event"] ?? "");

  if (kind === "audio") {
    const data = (msg["data"] as Record<string, unknown> | undefined) ?? msg;
    const audio = data["audio"];
    if (typeof audio === "string") {
      try {
        const decoded = Uint8Array.from(Buffer.from(audio, "base64"));
        // Pass through whatever else Sarvam included alongside the audio
        // payload (e.g. a sample rate or codec field, if it sends one) so
        // callers can verify the actual output format matches what was
        // declared in the config message, instead of trusting it blindly —
        // see onTtsEvent's first_outbound_audio_frame diagnostic.
        const meta: Record<string, unknown> = { ...data };
        delete meta["audio"];
        return { type: "audio", data: decoded, meta };
      } catch {
        return { type: "error", message: "Malformed audio chunk from the AI voice provider" };
      }
    }
  }
  if (kind === "flushed" || kind === "flush_ack") return { type: "flushed" };
  if (kind === "error") {
    const message = extractErrorDetail(msg) ?? "Speech synthesis error";
    return { type: "error", message, raw: msg };
  }
  return { type: "unknown", raw };
}

export async function connectSarvamTts(opts: ConnectTtsOptions): Promise<TtsSession> {
  const url = new URL(TTS_WS_URL);
  url.searchParams.set("model", SARVAM_REALTIME_MODELS.tts);

  const socket = await openSocket(url.toString());

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
  // model is a connection-level query param (set above), matching STT's
  // proven-correct shape, not a config field. output_audio_codec and
  // speech_sample_rate are separate, independent settings — codec alone
  // does NOT imply a sample rate: Sarvam's documented default for
  // bulbul:v3 is 24000 Hz regardless of codec, with 8000 Hz supported for
  // streaming. Both must be declared explicitly, or Sarvam will generate
  // 24kHz audio that a mulaw/8kHz telephony bridge forwards byte-for-byte
  // without resampling — not a connection error, just corrupted/garbled
  // audio on the call. See this file's module doc for why bitrate
  // specifically was still wrong (a compressed-codec bitrate, not a sample
  // rate — never reintroduce output_audio_bitrate). speech_sample_rate is
  // sent as a STRING, not a number — per a current working Sarvam
  // implementation (user-supplied; not independently verifiable from this
  // sandbox, see module doc's VERIFICATION NOTE).
  const configPayload = {
    type: "config",
    data: {
      language_code: opts.language,
      speaker: opts.voiceId,
      pace: Math.min(2, Math.max(0.5, opts.pace)),
      output_audio_codec: opts.outputCodec,
      speech_sample_rate: String(opts.outputSampleRateHz),
    },
  };
  // TEMPORARY DIAGNOSTIC (production incident: Sarvam rejects the TTS
  // session with a 422 "Input parameters has to be a valid dictionary"
  // even after two rounds of config-only fixes — this traces every send on
  // the wire so the next call shows the exact sequence rather than
  // inferring it from log order, which synchronous fire-and-forget sends
  // make unreliable. Safe fields only: never the API key/auth subprotocol,
  // never audio, never the full transcript (text gets only a length and a
  // ≤20-char preview — see tts:text_sent below).
  console.info("tts:config_sent", {
    topLevelKeys: Object.keys(configPayload),
    dataKeys: Object.keys(configPayload.data),
    dataValueTypes: Object.fromEntries(
      Object.entries(configPayload.data).map(([k, v]) => [k, typeof v]),
    ),
    modelInUrl: url.searchParams.get("model"),
    codec: configPayload.data.output_audio_codec,
    sampleRateValue: configPayload.data.speech_sample_rate,
    sampleRateType: typeof configPayload.data.speech_sample_rate,
    languageCode: configPayload.data.language_code,
    speaker: configPayload.data.speaker,
    pace: configPayload.data.pace,
  });
  socket.send(JSON.stringify(configPayload));

  return {
    sendText(text: string) {
      if (!text) return;
      if (socket.readyState === WebSocket.OPEN) {
        // "text", not "convert" — per the current Sarvam realtime TTS
        // protocol (user-supplied); "convert" was never a recognized
        // message type, and is the leading suspect for the persistent 422
        // that survived two unrelated config-field fixes.
        const textPayload = { type: "text", data: { text } };
        console.info("tts:text_sent", {
          topLevelKeys: Object.keys(textPayload),
          dataKeys: Object.keys(textPayload.data),
          dataType: typeof textPayload.data,
          textType: typeof textPayload.data.text,
          textLength: text.length,
          textPreview: text.slice(0, 20),
        });
        socket.send(JSON.stringify(textPayload));
      }
    },
    flush() {
      if (socket.readyState === WebSocket.OPEN) {
        const flushPayload = { type: "flush" };
        console.info("tts:flush_sent", { shape: flushPayload });
        socket.send(JSON.stringify(flushPayload));
      }
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
