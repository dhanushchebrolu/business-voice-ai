/**
 * In-process fake of the Sarvam speech endpoints, for --simulate and tests.
 * No sockets: it is a Transport object. It speaks the documented request /
 * response shapes, produces deterministic tone audio (never speech), and
 * maps each clip back to its text by exact duration so the STT side can
 * answer with the expected transcript (or a configured corruption of it).
 *
 * It records every call (endpoint, model, voice, mode, language, and the
 * NAMES of headers only) and can inject faults per call.
 */
import { muLawEncode, muLawToWav, parseWav, pcm16ToWav, tone, wavSamples } from "./audio.ts";
import type { SocketLike, Transport } from "./transport.ts";

export type Endpoint = "tts" | "tts-stream" | "tts-ws" | "stt" | "stt-ws";

export interface FakeCall {
  endpoint: Endpoint;
  model: string | null;
  speaker: string | null;
  mode: string | null;
  language: string | null;
  sampleRate: number | null;
  codec: string | null;
  headerNames: string[];
}

export type FaultResponse =
  | { status: number; body?: unknown }
  | { transport: true }
  | { timeout: true }
  | { wsClose: number; reason?: string }
  | { malformed: true }
  | { silent: true };

export interface Fault {
  when: (call: FakeCall, n: number) => boolean;
  respond: FaultResponse;
  /** How many times it fires (default 1). */
  times?: number;
}

export interface FakeOptions {
  faults?: Fault[];
  /** Change what STT "hears" (e.g. drop digits) to exercise the metrics. */
  corrupt?: (text: string, call: FakeCall) => string;
}

const MS_PER_CHAR = 70;

export class FakeSarvam implements Transport {
  readonly name = "fake" as const;
  readonly calls: FakeCall[] = [];
  private readonly texts = new Map<number, string>(); // clip duration (ms) -> text
  private nextMs = 0;
  private readonly faults: Array<Fault & { left: number }>;
  private readonly corrupt: NonNullable<FakeOptions["corrupt"]>;

  constructor(o: FakeOptions = {}) {
    this.faults = (o.faults ?? []).map((f) => ({ ...f, left: f.times ?? 1 }));
    this.corrupt = o.corrupt ?? ((t) => t);
  }

  private fault(call: FakeCall): FaultResponse | null {
    const n = this.calls.length;
    for (const f of this.faults)
      if (f.left > 0 && f.when(call, n)) {
        f.left--;
        return f.respond;
      }
    return null;
  }

  /** A clip whose exact duration (whole ms, 16-sample aligned) identifies its text. */
  private synth(text: string, rate: number): Int16Array {
    let ms = Math.max(400, text.length * MS_PER_CHAR) + (this.nextMs += 1);
    while (this.texts.has(ms)) ms++;
    this.texts.set(ms, text);
    const s = tone(220 + (ms % 300), ms, rate);
    return s;
  }

  private hear(samples: number, rate: number): string {
    const ms = Math.round((samples / rate) * 1000);
    return this.texts.get(ms) ?? this.texts.get(ms - 1) ?? this.texts.get(ms + 1) ?? "";
  }

  private record(c: FakeCall): FakeCall {
    this.calls.push(c);
    return c;
  }

  fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const headerNames = [...new Headers(init?.headers).keys()].sort();
    if (url.pathname === "/text-to-speech" || url.pathname === "/text-to-speech/stream") {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const call = this.record({
        endpoint: url.pathname.endsWith("stream") ? "tts-stream" : "tts",
        model: String(b.model ?? ""),
        speaker: String(b.speaker ?? ""),
        mode: null,
        language: String(b.language_code ?? ""),
        sampleRate: Number(b.speech_sample_rate),
        codec: String(b.output_audio_codec ?? ""),
        headerNames,
      });
      const f = this.fault(call);
      if (f) {
        const early = this.faultResponse(f);
        if (early) return early;
      }
      const rate = Number(b.speech_sample_rate);
      const samples = f && "silent" in f ? new Int16Array(rate) : this.synth(String(b.text), rate);
      if (call.endpoint === "tts-stream") {
        const raw = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
        const parts = [raw.subarray(0, raw.length >> 1), raw.subarray(raw.length >> 1)];
        return new Response(
          new ReadableStream({
            start(c) {
              for (const p of parts) c.enqueue(new Uint8Array(p));
              c.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "audio/l16", "x-request-id": `fake_${this.calls.length}` },
          },
        );
      }
      const audio =
        call.codec === "mulaw" ? muLawToWav(muLawEncode(samples), rate) : pcm16ToWav(samples, rate);
      const body =
        f && "malformed" in f
          ? { request_id: "x", audios: [] }
          : {
              request_id: `fake_${this.calls.length}`,
              audios: [Buffer.from(audio).toString("base64")],
            };
      return Response.json(body);
    }
    if (url.pathname === "/speech-to-text") {
      const form = init?.body as FormData;
      const file = form.get("file") as Blob;
      const call = this.record({
        endpoint: "stt",
        model: String(form.get("model")),
        speaker: null,
        mode: String(form.get("mode")),
        language: String(form.get("language_code")),
        sampleRate: null,
        codec: null,
        headerNames,
      });
      const bytes = new Uint8Array(await file.arrayBuffer());
      call.sampleRate = parseWav(bytes).sampleRate;
      const f = this.fault(call);
      if (f) {
        const early = this.faultResponse(f);
        if (early) return early;
        if ("malformed" in f) return Response.json({ request_id: "x" });
      }
      const { samples, sampleRate } = wavSamples(bytes);
      const text = this.corrupt(this.hear(samples.length, sampleRate), call);
      return Response.json({
        request_id: `fake_${this.calls.length}`,
        transcript: text,
        language_code: /[ఀ-౿]/.test(text) ? "te-IN" : /[ऀ-ॿ]/.test(text) ? "hi-IN" : "en-IN",
        language_probability: 0.9,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  private faultResponse(f: FaultResponse): Response | null {
    if ("transport" in f) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    if ("timeout" in f)
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if ("status" in f)
      return Response.json(f.body ?? { error: { message: "injected", code: "injected_error" } }, {
        status: f.status,
      });
    return null; // malformed / silent are handled by the caller
  }

  openSocket(url: string, headers: Record<string, string>): SocketLike {
    const u = new URL(url);
    const tts = u.pathname === "/text-to-speech/ws";
    const call = this.record({
      endpoint: tts ? "tts-ws" : "stt-ws",
      model: u.searchParams.get("model"),
      speaker: null,
      mode: u.searchParams.get("mode"),
      language: u.searchParams.get("language-code"),
      sampleRate: Number(u.searchParams.get("sample_rate")) || null,
      codec: null,
      headerNames: Object.keys(headers)
        .map((h) => h.toLowerCase())
        .sort(),
    });
    const f = this.fault(call);
    if (f && "transport" in f)
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    return new FakeSocket(this, call, f, tts);
  }

  /** @internal used by FakeSocket */
  _synth(text: string, rate: number): Int16Array {
    return this.synth(text, rate);
  }
  /** @internal */
  _hear(samples: number, rate: number, call: FakeCall): string {
    return this.corrupt(this.hear(samples, rate), call);
  }
}

type Listener = (ev: never) => void;

class FakeSocket implements SocketLike {
  readyState = 0;
  private readonly listeners: Record<string, Listener[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  private config: Record<string, unknown> = {};
  private text = "";
  private received = 0;

  private readonly fake: FakeSarvam;
  private readonly call: FakeCall;
  private readonly fault: FaultResponse | null;
  private readonly tts: boolean;

  constructor(fake: FakeSarvam, call: FakeCall, fault: FaultResponse | null, tts: boolean) {
    this.fake = fake;
    this.call = call;
    this.fault = fault;
    this.tts = tts;
    setTimeout(() => {
      this.readyState = 1;
      this.emit("open", {});
    }, 0);
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners[type]!.push(fn);
  }

  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners[type]!) (l as (e: unknown) => void)(ev);
  }

  private reply(obj: unknown): void {
    setTimeout(
      () => this.readyState === 1 && this.emit("message", { data: JSON.stringify(obj) }),
      0,
    );
  }

  send(data: string): void {
    const m = JSON.parse(data) as Record<string, unknown>;
    if (this.fault && "wsClose" in this.fault) {
      const f = this.fault;
      setTimeout(() => this.close(f.wsClose, f.reason ?? "injected"), 0);
      return;
    }
    if (this.fault && "status" in this.fault) {
      this.reply({ type: "error", data: { message: "injected", code: String(this.fault.status) } });
      return;
    }
    if (this.tts) {
      if (m.type === "config") this.config = (m.data ?? {}) as Record<string, unknown>;
      if (m.type === "text") this.text += String((m.data as { text?: string }).text ?? "");
      if (m.type === "flush") {
        this.call.speaker = String(this.config.speaker ?? "");
        this.call.language = String(this.config.language_code ?? "");
        this.call.codec = String(this.config.output_audio_codec ?? "");
        const rate = Number(this.config.speech_sample_rate);
        this.call.sampleRate = rate;
        const s = this.fake._synth(this.text, rate);
        const raw = Buffer.from(s.buffer, s.byteOffset, s.byteLength);
        for (const part of [raw.subarray(0, raw.length >> 1), raw.subarray(raw.length >> 1)])
          this.reply({ type: "audio", data: { audio: part.toString("base64") } });
        this.reply({ type: "event", data: { event_type: "final" } });
      }
      return;
    }
    const audio = (m.audio ?? null) as { data?: string } | null;
    if (audio?.data) this.received += Buffer.from(audio.data, "base64").length / 2;
    if (m.type === "flush") {
      const text = this.fake._hear(this.received, this.call.sampleRate ?? 16000, this.call);
      this.reply({ type: "events", data: { signal_type: "END_SPEECH" } });
      this.reply({
        type: "data",
        data: { transcript: text, request_id: `fake_ws_${this.received}`, language_code: null },
      });
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.emit("close", { code, reason }), 0);
  }
}
