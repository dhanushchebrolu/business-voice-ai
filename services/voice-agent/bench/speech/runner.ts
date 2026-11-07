/**
 * Executes a speech plan against a Transport (live or fake) under a Ledger.
 *
 * Safeguards, all enforced here:
 *  - the ledger is checked before EVERY attempt (retries included); if the
 *    attempt could exceed the cap or a volume limit, the run stops before
 *    sending it;
 *  - every attempt that may have reached Sarvam is billed in full, failed
 *    or not; only locally refused attempts (guard, network disabled) are free;
 *  - at most one retry, and only for retryable failures (429, 5xx, timeout,
 *    transport, dropped socket);
 *  - the run stops on 401/403 (auth), 402 (out of credits), three
 *    consecutive transport failures, or five consecutive identical
 *    non-retryable errors (a systematic request problem);
 *  - the model sent is always the plan item's model: requests are built
 *    from the plan item only, and no code path picks another model on error
 *    (tests/speech-harness.spec.ts checks what was actually sent).
 */
import {
  AudioFormatError,
  frames,
  muLawEncode,
  muLawToWav,
  parseWav,
  pcm16ToWav,
  resample,
  rms,
  wavSamples,
} from "./audio.ts";
import {
  SpeechCallError,
  sttRest,
  sttWebSocket,
  ttsHttpStream,
  ttsRest,
  ttsWebSocket,
  type CallContext,
  type Clock,
} from "./clients.ts";
import { FIXTURES, type Fixture } from "./fixtures.ts";
import { cer, checkEntities, wer, type EntityResult } from "./metrics.ts";
import { isTts, textOf, type PlanItem, type SttItem, type TtsItem } from "./plan.ts";
import { ttsChars, type Attempt, type Ledger } from "./pricing.ts";
import type { Transport } from "./transport.ts";

export interface AttemptRecord {
  n: number;
  outcome: "ok" | SpeechCallError["kind"] | "invalid";
  status: number | null;
  code: string | null;
  requestId: string | null;
  ms: Record<string, number>;
  billed: boolean;
  costInclGst: number;
  error?: string;
}

export interface ItemResult {
  id: string;
  stage: string;
  kind: PlanItem["kind"];
  model: string;
  speaker?: string;
  mode?: string;
  languageRequested: string;
  fixtureId: string;
  lang: string;
  variant: string;
  category: string;
  probe: boolean;
  status: "ok" | "failed" | "skipped" | "not-run";
  note?: string;
  attempts: AttemptRecord[];
  validation: { ok: boolean; problems: string[] };
  audio?: { format: string; sampleRate: number; durationSec: number; bytes: number; rms: number };
  transcript?: string;
  expected?: string;
  detectedLanguage?: string | null;
  metrics?: { cer: number; wer: number; entities: EntityResult[] };
}

export interface RunOptions {
  transport: Transport;
  ledger: Ledger;
  headers: Record<string, string>;
  clock: Clock;
  redact: (s: string) => string;
  timeoutMs: number;
  /** Minimum gap between requests (rate limits: 60/min on pay-as-you-go). */
  minIntervalMs: number;
  retryBackoffMs: number;
  /** STT WebSocket audio is sent in real time (a call) unless false (tests). */
  realtimeStreaming: boolean;
  onAudio?: (itemId: string, audio: Uint8Array, ext: string) => void;
  log?: (line: string) => void;
  /** Source audio from an earlier run (STT-only stages): item id -> verified PCM16. */
  preloaded?: Map<string, { fixtureId: string; samples: Int16Array; sampleRate: number }>;
}

export interface RunOutcome {
  items: ItemResult[];
  stopReason: string | null;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2; // one retry
const MAX_TRANSPORT_STREAK = 3;
const MAX_SAME_ERROR_STREAK = 5;

type Pcm = { samples: Int16Array; sampleRate: number };

function fixtureOf(id: string): Fixture {
  return FIXTURES.find((f) => f.id === id)!;
}

function baseResult(item: PlanItem, fixtureId: string): ItemResult {
  const f = fixtureOf(fixtureId);
  return {
    id: item.id,
    stage: item.stage,
    kind: item.kind,
    model: item.model,
    ...(isTts(item) ? { speaker: item.speaker } : { mode: item.mode }),
    languageRequested: isTts(item) ? item.languageCode : item.languageCode,
    fixtureId,
    lang: f.lang,
    variant: f.variant,
    category: f.category,
    probe: item.probe,
    status: "not-run",
    attempts: [],
    validation: { ok: false, problems: [] },
  };
}

/** Raw PCM16 (linear16) or a WAV container -> samples. */
function decodeTtsAudio(item: TtsItem, bytes: Uint8Array): Pcm & { format: string } {
  const isWav =
    bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF";
  if (isWav) {
    const info = parseWav(bytes);
    const { samples, sampleRate } = wavSamples(bytes);
    return { samples, sampleRate, format: info.format };
  }
  if (item.codec !== "linear16")
    throw new AudioFormatError(`expected a WAV container for codec ${item.codec}`);
  if (bytes.length % 2) throw new AudioFormatError("raw PCM16 with an odd byte count");
  const copy = new Uint8Array(bytes);
  return { samples: new Int16Array(copy.buffer), sampleRate: item.sampleRate, format: "pcm16" };
}

export async function runPlan(plan: PlanItem[], o: RunOptions): Promise<RunOutcome> {
  const log = o.log ?? (() => {});
  const ctx: CallContext = {
    transport: o.transport,
    headers: o.headers,
    clock: o.clock,
    timeoutMs: o.timeoutMs,
    redact: o.redact,
  };
  const audioBySource = new Map<string, Pcm>(
    [...(o.preloaded ?? [])].map(([id, a]) => [
      id,
      { samples: a.samples, sampleRate: a.sampleRate },
    ]),
  );
  const results: ItemResult[] = [];
  let stopReason: string | null = null;
  let transportStreak = 0;
  let sameError: { key: string; n: number } = { key: "", n: 0 };
  let lastRequestAt = -Infinity;

  for (const item of plan) {
    const source = isTts(item)
      ? item
      : (plan.find((p): p is TtsItem => isTts(p) && p.id === item.source) ??
        o.preloaded?.get(item.source));
    if (!source) throw new Error(`plan error: ${item.id} has no TTS source`);
    const fixtureId = source.fixtureId;
    const r = baseResult(item, fixtureId);
    results.push(r);
    if (stopReason) continue;

    // ---- prepare (STT needs the TTS audio it transcribes) ----
    let sttAudio: {
      wav?: Uint8Array;
      pcmFrames?: Int16Array[];
      sampleRate: 8000 | 16000;
      seconds: number;
    } | null = null;
    if (!isTts(item)) {
      const src = audioBySource.get(item.source);
      if (!src) {
        r.status = "skipped";
        r.note = "source audio unavailable (its TTS request did not produce valid audio)";
        continue;
      }
      const rate: 8000 | 16000 = item.input.endsWith("8k") ? 8000 : 16000;
      const pcm = resample(src.samples, src.sampleRate, rate);
      const seconds = pcm.length / rate;
      sttAudio =
        item.input === "mulaw8k"
          ? { wav: muLawToWav(muLawEncode(pcm), rate), sampleRate: rate, seconds }
          : item.input.startsWith("pcm")
            ? { pcmFrames: frames(pcm, rate, 100), sampleRate: rate, seconds }
            : { wav: pcm16ToWav(pcm, rate), sampleRate: rate, seconds };
      r.expected = fixtureOf(fixtureId).text;
    }
    const attempt: Attempt = isTts(item)
      ? { kind: "tts", model: item.model, chars: ttsChars(textOf(item)) }
      : { kind: "stt", seconds: sttAudio!.seconds };

    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      const allowed = o.ledger.check(attempt);
      if (!allowed.ok) {
        stopReason = `stopped before sending ${item.id}: ${allowed.reason}`;
        r.note = stopReason;
        break;
      }
      const wait = lastRequestAt + o.minIntervalMs - o.clock.now();
      if (wait > 0) await o.clock.sleep(wait);
      lastRequestAt = o.clock.now();
      const rec: AttemptRecord = {
        n,
        outcome: "ok",
        status: 200,
        code: null,
        requestId: null,
        ms: {},
        billed: false,
        costInclGst: 0,
      };
      r.attempts.push(rec);
      try {
        if (isTts(item)) {
          const req = {
            model: item.model,
            speaker: item.speaker,
            languageCode: item.languageCode,
            text: textOf(item),
            sampleRate: item.sampleRate,
            codec: item.codec,
          };
          const res =
            item.kind === "tts-rest"
              ? await ttsRest(ctx, req)
              : item.kind === "tts-http"
                ? await ttsHttpStream(ctx, req)
                : await ttsWebSocket(ctx, req);
          rec.requestId = "requestId" in res ? res.requestId : null;
          rec.ms = res.ms;
          o.ledger.billed(attempt);
          rec.billed = true;
          rec.costInclGst = allowed.costInclGst;
          // validate
          const problems: string[] = [];
          let pcm: (Pcm & { format: string }) | null = null;
          try {
            pcm = decodeTtsAudio(item, res.audio);
          } catch (e) {
            problems.push(`audio: ${(e as Error).message}`);
          }
          if (pcm) {
            const expectFormat = item.codec === "mulaw" ? "mulaw" : "pcm16";
            const duration = pcm.samples.length / pcm.sampleRate;
            const level = rms(pcm.samples);
            if (pcm.format !== expectFormat)
              problems.push(`format ${pcm.format}, expected ${expectFormat}`);
            if (pcm.sampleRate !== item.sampleRate)
              problems.push(`sample rate ${pcm.sampleRate}, expected ${item.sampleRate}`);
            const maxSec = Math.max(5, ttsChars(textOf(item)) * 0.3);
            if (duration < 0.3 || duration > maxSec)
              problems.push(`duration ${duration.toFixed(2)} s outside 0.3-${maxSec.toFixed(1)} s`);
            if (level < 50) problems.push(`audio is (near) silent (rms ${level.toFixed(1)})`);
            r.audio = {
              format: pcm.format,
              sampleRate: pcm.sampleRate,
              durationSec: duration,
              bytes: res.audio.length,
              rms: Math.round(level),
            };
            if (!problems.length)
              audioBySource.set(item.id, { samples: pcm.samples, sampleRate: pcm.sampleRate });
          }
          o.onAudio?.(item.id, res.audio, item.codec === "linear16" ? "pcm" : "wav");
          r.validation = { ok: problems.length === 0, problems };
          r.status = problems.length ? "failed" : "ok";
          if (problems.length) rec.outcome = "invalid";
        } else {
          const a = sttAudio!;
          const res =
            item.kind === "stt-rest"
              ? await sttRest(ctx, {
                  model: item.model,
                  mode: item.mode,
                  languageCode: item.languageCode,
                  audio: a.wav!,
                  filename: `${item.id.replace(/[^\w.-]+/g, "_")}.wav`,
                })
              : await sttWebSocket(ctx, {
                  model: item.model,
                  mode: item.mode,
                  languageCode: item.languageCode,
                  sampleRate: a.sampleRate,
                  frames: a.pcmFrames!,
                  frameMs: 100,
                  realtime: o.realtimeStreaming,
                });
          rec.requestId = res.requestId;
          rec.ms = res.ms;
          o.ledger.billed(attempt);
          rec.billed = true;
          rec.costInclGst = allowed.costInclGst;
          const f = fixtureOf(fixtureId);
          r.transcript = o.redact(res.transcript);
          r.detectedLanguage = res.languageCode;
          r.metrics = {
            cer: cer(f.text, res.transcript),
            wer: wer(f.text, res.transcript),
            entities: checkEntities(f.entities, res.transcript),
          };
          const problems: string[] = [];
          if (!res.transcript.trim()) problems.push("empty transcript");
          if (!res.requestId) problems.push("no request_id");
          r.validation = { ok: problems.length === 0, problems };
          r.status = problems.length ? "failed" : "ok";
          if (problems.length) rec.outcome = "invalid";
        }
        transportStreak = 0;
        sameError = { key: "", n: 0 };
        break; // success (or a valid-but-wrong answer, which is not retried)
      } catch (e) {
        const err =
          e instanceof SpeechCallError
            ? e
            : new SpeechCallError("protocol", o.redact((e as Error)?.message ?? String(e)));
        rec.outcome = err.kind;
        rec.status = err.status;
        rec.code = err.code;
        rec.error = o.redact(err.message);
        if (err.kind === "guard") {
          o.ledger.notSent();
          stopReason = `stopped: request refused locally (${err.message})`;
          r.status = "failed";
          break;
        }
        // May have reached Sarvam: billed in full.
        o.ledger.billed(attempt);
        rec.billed = true;
        rec.costInclGst = allowed.costInclGst;
        r.status = "failed";
        r.validation = { ok: false, problems: [err.message] };
        if (err.status === 401 || err.status === 403) {
          stopReason = `stopped: authentication rejected (HTTP ${err.status})`;
          break;
        }
        if (err.status === 402) {
          stopReason = "stopped: Sarvam credits exhausted (HTTP 402)";
          break;
        }
        const noResponse =
          err.kind === "transport" || err.kind === "timeout" || err.kind === "ws-closed";
        transportStreak = noResponse ? transportStreak + 1 : 0;
        if (transportStreak >= MAX_TRANSPORT_STREAK) {
          stopReason = `stopped: ${MAX_TRANSPORT_STREAK} consecutive connection failures`;
          break;
        }
        const retryable = noResponse || (err.status !== null && RETRYABLE_STATUS.has(err.status));
        if (!retryable) {
          const key = `${err.kind}:${err.status}:${err.code}`;
          sameError = sameError.key === key ? { key, n: sameError.n + 1 } : { key, n: 1 };
          if (!item.probe && sameError.n >= MAX_SAME_ERROR_STREAK) {
            stopReason = `stopped: ${MAX_SAME_ERROR_STREAK} consecutive identical errors (${key}) — systematic request problem`;
          }
          break;
        }
        if (n < MAX_ATTEMPTS) {
          log(`retrying ${item.id} after ${err.kind}${err.status ? ` ${err.status}` : ""}`);
          await o.clock.sleep(o.retryBackoffMs);
        }
      }
    }
    log(`${r.status.padEnd(7)} ${item.id}  spent ₹${o.ledger.spentInclGst.toFixed(4)}`);
  }
  for (const r of results)
    if (r.status === "not-run" && !r.note && stopReason) r.note = "not run: the run was stopped";
  return { items: results, stopReason };
}
