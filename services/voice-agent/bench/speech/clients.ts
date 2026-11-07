/**
 * Isolated Sarvam speech clients for the harness (not used by production).
 * Request/response shapes follow Sarvam's documentation (2026-11-03):
 *  - TTS REST   POST /text-to-speech          JSON in, { request_id, audios: [base64 WAV] } out
 *               https://docs.sarvam.ai/api-reference/text-to-speech/convert
 *  - TTS stream POST /text-to-speech/stream   same JSON in, raw audio bytes out
 *               https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/http-stream
 *  - TTS WS     wss /text-to-speech/ws        config -> text -> flush; audio / event(final) / error
 *               https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket
 *  - STT REST   POST /speech-to-text          multipart; { request_id, transcript, language_code, ... }
 *               https://docs.sarvam.ai/api-reference/speech-to-text/transcribe
 *  - STT WS     wss /speech-to-text/ws        { audio: { data, encoding, sample_rate } } ... flush, end_of_stream;
 *               data / events / error
 *               https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api
 * The model is always the caller's: nothing here picks or substitutes one.
 */
import { SARVAM_API, SARVAM_WS, type SocketLike, type Transport } from "./transport.ts";

export type FailureKind =
  | "http" // a response with a non-2xx status
  | "transport" // no response (DNS, reset, refused)
  | "timeout"
  | "ws-closed" // socket closed before the exchange completed
  | "protocol" // a 2xx answer that does not match the documented shape
  | "guard"; // refused locally before sending (auth guard / network disabled)

export class SpeechCallError extends Error {
  override name = "SpeechCallError";
  readonly kind: FailureKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly closeCode: number | null;
  constructor(
    kind: FailureKind,
    message: string,
    status: number | null = null,
    code: string | null = null,
    closeCode: number | null = null,
  ) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.closeCode = closeCode;
  }
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface CallContext {
  transport: Transport;
  headers: Record<string, string>;
  clock: Clock;
  timeoutMs: number;
  redact: (s: string) => string;
}

/**
 * Credential-shaped tokens never leave the process, including ones this
 * process never held (in proxy-injected mode the key is only in the proxy,
 * so an error body that echoed it could not be redacted by value).
 */
export function scrubTokens(s: string): string {
  return s
    .replace(/\b(?:sk|api|key|token|bearer|secret)[_\-:= ]+[A-Za-z0-9._-]{8,}/gi, "[REDACTED]")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, "[REDACTED]");
}

const snippet = (ctx: CallContext, s: string) =>
  scrubTokens(ctx.redact(s)).replace(/\s+/g, " ").slice(0, 240);

async function httpError(ctx: CallContext, res: Response): Promise<SpeechCallError> {
  let code: string | null = null;
  let msg = "";
  try {
    const text = await res.text();
    msg = text;
    const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
    code = j.error?.code ?? null;
    msg = j.error?.message ?? text;
  } catch {
    /* not JSON */
  }
  return new SpeechCallError("http", `HTTP ${res.status}: ${snippet(ctx, msg)}`, res.status, code);
}

function classify(e: unknown, ctx: CallContext): SpeechCallError {
  if (e instanceof SpeechCallError) return e;
  const err = e as Error;
  if (
    err?.name === "NetworkDisabledError" ||
    err?.name === "AuthGuardError" ||
    err?.name === "SarvamAuthGuardError"
  )
    return new SpeechCallError("guard", snippet(ctx, err.message));
  if (err?.name === "AbortError" || err?.name === "TimeoutError")
    return new SpeechCallError("timeout", "request timed out");
  const cause = (err as { cause?: { code?: string } })?.cause?.code;
  return new SpeechCallError(
    "transport",
    snippet(ctx, `${err?.message ?? String(e)}${cause ? ` (${cause})` : ""}`),
  );
}

/* ------------------------------------------------------------------ TTS */

export interface TtsRequest {
  model: string;
  speaker: string;
  languageCode: string;
  text: string;
  sampleRate: number;
  codec: "wav" | "mulaw" | "linear16";
}

function ttsBody(r: TtsRequest) {
  return {
    text: r.text,
    language_code: r.languageCode, // current API reference name
    model: r.model,
    speaker: r.speaker,
    speech_sample_rate: r.sampleRate,
    output_audio_codec: r.codec,
  };
}

export interface TtsRestResult {
  requestId: string | null;
  audio: Uint8Array;
  ms: { headers: number; total: number };
}

export async function ttsRest(ctx: CallContext, r: TtsRequest): Promise<TtsRestResult> {
  const t0 = ctx.clock.now();
  let res: Response;
  try {
    res = await ctx.transport.fetch(`${SARVAM_API}/text-to-speech`, {
      method: "POST",
      headers: { ...ctx.headers, "content-type": "application/json" },
      body: JSON.stringify(ttsBody(r)),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (e) {
    throw classify(e, ctx);
  }
  const headers = ctx.clock.now() - t0;
  if (!res.ok) throw await httpError(ctx, res);
  let j: { request_id?: unknown; audios?: unknown };
  try {
    j = (await res.json()) as typeof j;
  } catch {
    throw new SpeechCallError("protocol", "TTS response is not JSON", res.status);
  }
  if (!Array.isArray(j.audios) || j.audios.length !== 1 || typeof j.audios[0] !== "string")
    throw new SpeechCallError(
      "protocol",
      "TTS response must have exactly one base64 audio",
      res.status,
    );
  const audio = new Uint8Array(Buffer.from(j.audios[0], "base64"));
  if (!audio.length) throw new SpeechCallError("protocol", "TTS audio is empty", res.status);
  return {
    requestId: typeof j.request_id === "string" ? j.request_id : null,
    audio,
    ms: { headers, total: ctx.clock.now() - t0 },
  };
}

export interface TtsStreamResult {
  requestId: string | null;
  audio: Uint8Array;
  contentType: string | null;
  ms: { headers: number; firstByte: number; total: number };
}

export async function ttsHttpStream(ctx: CallContext, r: TtsRequest): Promise<TtsStreamResult> {
  const t0 = ctx.clock.now();
  let res: Response;
  try {
    res = await ctx.transport.fetch(`${SARVAM_API}/text-to-speech/stream`, {
      method: "POST",
      headers: { ...ctx.headers, "content-type": "application/json" },
      body: JSON.stringify(ttsBody(r)),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (e) {
    throw classify(e, ctx);
  }
  const headers = ctx.clock.now() - t0;
  if (!res.ok) throw await httpError(ctx, res);
  if (!res.body) throw new SpeechCallError("protocol", "stream response has no body", res.status);
  const chunks: Uint8Array[] = [];
  let firstByte = -1;
  try {
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (firstByte < 0 && c.length) firstByte = ctx.clock.now() - t0;
      chunks.push(c);
    }
  } catch (e) {
    throw classify(e, ctx);
  }
  const audio = new Uint8Array(Buffer.concat(chunks));
  if (!audio.length) throw new SpeechCallError("protocol", "stream returned no audio", res.status);
  return {
    requestId: res.headers.get("x-request-id") ?? res.headers.get("request-id"),
    audio,
    contentType: res.headers.get("content-type"),
    ms: { headers, firstByte, total: ctx.clock.now() - t0 },
  };
}

/** Runs one WebSocket exchange; resolves when `done` says so, rejects on close/error/timeout. */
function socketExchange<T>(
  ctx: CallContext,
  url: string,
  onOpen: (ws: SocketLike) => void | Promise<void>,
  onMessage: (msg: Record<string, unknown>, ws: SocketLike) => T | undefined,
): Promise<{ value: T; openMs: number }> {
  return new Promise((resolve, reject) => {
    const t0 = ctx.clock.now();
    let ws: SocketLike;
    let settled = false;
    let openMs = -1;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      try {
        ws?.close(1000, "done");
      } catch {
        /* already closed */
      }
    };
    const timer = setTimeout(
      () => finish(() => reject(new SpeechCallError("timeout", "WebSocket exchange timed out"))),
      ctx.timeoutMs,
    );
    try {
      ws = ctx.transport.openSocket(url, ctx.headers);
    } catch (e) {
      clearTimeout(timer);
      settled = true;
      reject(classify(e, ctx));
      return;
    }
    ws.addEventListener("open", () => {
      openMs = ctx.clock.now() - t0;
      Promise.resolve(onOpen(ws)).catch((e) => finish(() => reject(classify(e, ctx))));
    });
    ws.addEventListener("message", (ev) => {
      if (settled) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(
          typeof ev.data === "string"
            ? ev.data
            : Buffer.from(ev.data as ArrayBuffer).toString("utf8"),
        );
      } catch {
        finish(() => reject(new SpeechCallError("protocol", "non-JSON WebSocket message")));
        return;
      }
      if (msg.type === "error") {
        const d = (msg.data ?? {}) as { message?: string; code?: string | number };
        const status = /^\d{3}$/.test(String(d.code ?? "")) ? Number(d.code) : null;
        finish(() =>
          reject(
            new SpeechCallError(
              "http",
              `WebSocket error: ${snippet(ctx, String(d.message ?? "unknown"))}`,
              status,
              d.code == null ? null : String(d.code),
            ),
          ),
        );
        return;
      }
      try {
        const v = onMessage(msg, ws);
        if (v !== undefined) finish(() => resolve({ value: v, openMs }));
      } catch (e) {
        finish(() => reject(classify(e, ctx)));
      }
    });
    ws.addEventListener("close", (ev) =>
      finish(() =>
        reject(
          new SpeechCallError(
            "ws-closed",
            `socket closed (${ev.code}) ${snippet(ctx, ev.reason ?? "")}`,
            null,
            null,
            ev.code,
          ),
        ),
      ),
    );
    ws.addEventListener("error", () =>
      finish(() => reject(new SpeechCallError("transport", "WebSocket error before completion"))),
    );
  });
}

export interface TtsWsResult {
  audio: Uint8Array;
  ms: { open: number; firstAudio: number; total: number };
}

export async function ttsWebSocket(ctx: CallContext, r: TtsRequest): Promise<TtsWsResult> {
  const url = `${SARVAM_WS}/text-to-speech/ws?${new URLSearchParams({ model: r.model, send_completion_event: "true" })}`;
  const t0 = ctx.clock.now();
  let sentAt = 0;
  let firstAudio = -1;
  const chunks: Buffer[] = [];
  const { value, openMs } = await socketExchange(
    ctx,
    url,
    (ws) => {
      ws.send(
        JSON.stringify({
          type: "config",
          data: {
            speaker: r.speaker,
            language_code: r.languageCode,
            speech_sample_rate: r.sampleRate,
            output_audio_codec: r.codec,
          },
        }),
      );
      sentAt = ctx.clock.now();
      ws.send(JSON.stringify({ type: "text", data: { text: r.text } }));
      ws.send(JSON.stringify({ type: "flush" }));
    },
    (msg) => {
      if (msg.type === "audio") {
        const b64 = (msg.data as { audio?: unknown } | undefined)?.audio;
        if (typeof b64 !== "string")
          throw new SpeechCallError("protocol", "audio message without base64 data");
        if (firstAudio < 0) firstAudio = ctx.clock.now() - sentAt;
        chunks.push(Buffer.from(b64, "base64"));
        return undefined;
      }
      if (
        msg.type === "event" &&
        (msg.data as { event_type?: string } | undefined)?.event_type === "final"
      )
        return true;
      return undefined;
    },
  );
  void value;
  const audio = new Uint8Array(Buffer.concat(chunks));
  if (!audio.length) throw new SpeechCallError("protocol", "no audio before the final event");
  return { audio, ms: { open: openMs, firstAudio, total: ctx.clock.now() - t0 } };
}

/* ------------------------------------------------------------------ STT */

export interface SttResult {
  requestId: string | null;
  transcript: string;
  languageCode: string | null;
  languageProbability: number | null;
  ms: Record<string, number>;
}

export async function sttRest(
  ctx: CallContext,
  r: { model: string; mode: string; languageCode: string; audio: Uint8Array; filename: string },
): Promise<SttResult> {
  const form = new FormData();
  form.append("file", new Blob([r.audio], { type: "audio/wav" }), r.filename);
  form.append("model", r.model);
  form.append("mode", r.mode);
  form.append("language_code", r.languageCode);
  const t0 = ctx.clock.now();
  let res: Response;
  try {
    res = await ctx.transport.fetch(`${SARVAM_API}/speech-to-text`, {
      method: "POST",
      headers: { ...ctx.headers },
      body: form,
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (e) {
    throw classify(e, ctx);
  }
  const headers = ctx.clock.now() - t0;
  if (!res.ok) throw await httpError(ctx, res);
  let j: Record<string, unknown>;
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new SpeechCallError("protocol", "STT response is not JSON", res.status);
  }
  if (typeof j.transcript !== "string")
    throw new SpeechCallError("protocol", "STT response has no transcript", res.status);
  return {
    requestId: typeof j.request_id === "string" ? j.request_id : null,
    transcript: j.transcript,
    languageCode: typeof j.language_code === "string" ? j.language_code : null,
    languageProbability: typeof j.language_probability === "number" ? j.language_probability : null,
    ms: { headers, total: ctx.clock.now() - t0 },
  };
}

export async function sttWebSocket(
  ctx: CallContext,
  r: {
    model: string;
    mode: string;
    languageCode: string;
    sampleRate: 8000 | 16000;
    frames: Int16Array[];
    frameMs: number;
    realtime: boolean;
  },
): Promise<SttResult> {
  const url = `${SARVAM_WS}/speech-to-text/ws?${new URLSearchParams({
    model: r.model,
    mode: r.mode,
    "language-code": r.languageCode,
    sample_rate: String(r.sampleRate),
    input_audio_codec: "pcm_s16le",
    vad_signals: "true",
  })}`;
  const t0 = ctx.clock.now();
  let audioDoneAt = -1;
  let firstTranscript = -1;
  const parts: string[] = [];
  let requestId: string | null = null;
  let languageCode: string | null = null;
  const { openMs } = await socketExchange(
    ctx,
    url,
    async (ws) => {
      for (const f of r.frames) {
        const b = Buffer.from(f.buffer, f.byteOffset, f.byteLength);
        ws.send(
          JSON.stringify({
            audio: { data: b.toString("base64"), encoding: "audio/wav", sample_rate: r.sampleRate },
          }),
        );
        if (r.realtime) await ctx.clock.sleep(r.frameMs); // paced like a live call
      }
      audioDoneAt = ctx.clock.now();
      ws.send(JSON.stringify({ type: "flush" }));
      ws.send(
        JSON.stringify({
          type: "end_of_stream",
          audio: { data: "", encoding: "audio/wav", sample_rate: r.sampleRate },
        }),
      );
    },
    (msg) => {
      if (msg.type !== "data") return undefined; // "events" (VAD) are informational
      const d = (msg.data ?? {}) as {
        transcript?: unknown;
        request_id?: unknown;
        language_code?: unknown;
      };
      if (typeof d.transcript !== "string")
        throw new SpeechCallError("protocol", "data message without transcript");
      if (firstTranscript < 0) firstTranscript = ctx.clock.now() - t0;
      if (d.transcript) parts.push(d.transcript);
      if (typeof d.request_id === "string") requestId = d.request_id;
      if (typeof d.language_code === "string") languageCode = d.language_code;
      // The transcript after all audio was sent completes the exchange.
      return audioDoneAt >= 0 ? true : undefined;
    },
  );
  return {
    requestId,
    transcript: parts.join(" ").trim(),
    languageCode,
    languageProbability: null,
    ms: {
      open: openMs,
      firstTranscript,
      finalAfterAudio: audioDoneAt >= 0 ? ctx.clock.now() - audioDoneAt : -1,
      total: ctx.clock.now() - t0,
    },
  };
}
