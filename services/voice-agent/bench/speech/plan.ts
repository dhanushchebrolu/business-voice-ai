/**
 * The test plan: every request the harness may make, in order, with its
 * model fixed in the plan (the runner never substitutes another model).
 * The plan, prices and limits are hashed; a live run must be confirmed with
 * that hash, so what is approved is exactly what runs.
 */
import { createHash } from "node:crypto";
import { FIXTURES, V3_VOICES, V4_FLASH_VOICES, type Fixture, type Lang } from "./fixtures.ts";
import {
  attemptCost,
  ttsChars,
  type Limits,
  type Prices,
  type SttModel,
  type TtsModel,
} from "./pricing.ts";

export const PLAN_VERSION = "speech-plan/1";

export type TtsKind = "tts-rest" | "tts-http" | "tts-ws";
export type SttKind = "stt-rest" | "stt-ws";

export interface TtsItem {
  id: string;
  stage: string;
  kind: TtsKind;
  model: TtsModel;
  speaker: string;
  fixtureId: string;
  languageCode: Lang;
  sampleRate: 8000 | 16000;
  /** REST: wav or the isolated mulaw probe; streaming: linear16 (raw PCM). */
  codec: "wav" | "mulaw" | "linear16";
  probe: boolean;
}

export interface SttItem {
  id: string;
  stage: string;
  kind: SttKind;
  model: SttModel;
  mode: "codemix" | "transcribe";
  /** "unknown" = Sarvam auto-detect. */
  languageCode: "unknown" | Lang;
  /** The TTS item whose audio is transcribed. */
  source: string;
  input: "wav16k" | "wav8k" | "mulaw8k" | "pcm16k" | "pcm8k";
  probe: boolean;
}

export type PlanItem = TtsItem | SttItem;
export const isTts = (i: PlanItem): i is TtsItem => i.kind.startsWith("tts");

const byId = (ids: string[]) => ids.map((id) => FIXTURES.find((f) => f.id === id)!).filter(Boolean);
const where = (p: (f: Fixture) => boolean) => FIXTURES.filter(p);
const notRomanized = where((f) => f.variant !== "romanized");
const NATIVE_SINGLE = where((f) => f.variant === "native");
const TELEPHONY = byId([
  ...["te", "hi", "en"].flatMap((l) =>
    ["appointment", "time", "price", "phone-plain", "phone-grouped"].map((c) => `${l}-${c}`),
  ),
  "hi-mix-appointment",
  "hi-mix-phone-plain",
  "te-mix-appointment",
  "te-mix-phone-plain",
  "te-mix-price",
]);
const V4_SET = byId(
  ["te", "hi", "en", "hi-mix"].flatMap((l) =>
    ["appointment", "time", "price", "phone-plain", "closing"].map((c) => `${l}-${c}`),
  ),
);
const LATENCY = byId(["en-appointment", "hi-appointment", "te-appointment", "hi-mix-appointment"]);
const MULAW_PROBE = byId(["en-appointment", "te-appointment"]);

function v4Voice(f: Fixture): string {
  const v =
    V4_FLASH_VOICES[f.variant === "code-mixed" ? `${f.lang}/code-mixed` : f.lang] ??
    V4_FLASH_VOICES[f.lang];
  if (!v) throw new Error(`no bulbul:v4-flash voice for ${f.id}`);
  return v;
}

export function buildPlan(): PlanItem[] {
  const items: PlanItem[] = [];
  const tts = (
    stage: string,
    kind: TtsKind,
    model: TtsModel,
    f: Fixture,
    speaker: string,
    sampleRate: 8000 | 16000,
    codec: TtsItem["codec"],
    probe = false,
  ) =>
    items.push({
      id: `${stage}:${f.id}${speaker === V3_VOICES.production || model !== "bulbul:v3" ? "" : `:${speaker}`}`,
      stage,
      kind,
      model,
      speaker,
      fixtureId: f.id,
      languageCode: f.lang,
      sampleRate,
      codec,
      probe,
    });
  const stt = (
    stage: string,
    kind: SttKind,
    model: SttModel,
    mode: SttItem["mode"],
    source: string,
    languageCode: SttItem["languageCode"],
    input: SttItem["input"],
    probe = false,
  ) =>
    items.push({
      id: `${stage}:${source}`,
      stage,
      kind,
      model,
      mode,
      languageCode,
      source,
      input,
      probe,
    });

  // --- TTS (bulbul:v3 = production model, priya = production voice) ---
  for (const f of notRomanized)
    tts("T1-v3-16k", "tts-rest", "bulbul:v3", f, V3_VOICES.production, 16000, "wav");
  for (const f of TELEPHONY)
    tts("T2-v3-8k", "tts-rest", "bulbul:v3", f, V3_VOICES.production, 8000, "wav");
  for (const f of where((x) => x.lang === "en-IN" && x.variant === "native"))
    for (const voice of [V3_VOICES.englishFemale, V3_VOICES.englishMale])
      tts("T3-v3-en-voices", "tts-rest", "bulbul:v3", f, voice, 16000, "wav");
  for (const f of where((x) => x.variant === "romanized"))
    tts("T4-v3-romanized", "tts-rest", "bulbul:v3", f, V3_VOICES.production, 16000, "wav");
  for (const f of V4_SET)
    tts("T5-v4flash", "tts-rest", "bulbul:v4-flash", f, v4Voice(f), 16000, "wav");
  for (const f of LATENCY)
    tts("T6-http-stream", "tts-http", "bulbul:v3", f, V3_VOICES.production, 16000, "linear16");
  for (const f of LATENCY)
    tts("T7-ws-stream", "tts-ws", "bulbul:v3", f, V3_VOICES.production, 16000, "linear16");
  for (const f of MULAW_PROBE)
    tts(
      "P1-tts-mulaw-probe",
      "tts-rest",
      "bulbul:v3",
      f,
      V3_VOICES.production,
      8000,
      "mulaw",
      true,
    );

  // --- STT on that audio, in priority order: production model first, comparisons last,
  // so a volume limit reached on longer-than-estimated audio cuts the comparisons first. ---
  for (const f of notRomanized)
    stt(
      "S1-v3-codemix-16k",
      "stt-rest",
      "saaras:v3",
      "codemix",
      `T1-v3-16k:${f.id}`,
      "unknown",
      "wav16k",
    );
  for (const f of TELEPHONY)
    stt(
      "S4-v3-codemix-8k",
      "stt-rest",
      "saaras:v3",
      "codemix",
      `T2-v3-8k:${f.id}`,
      "unknown",
      "wav8k",
    );
  for (const f of NATIVE_SINGLE)
    stt(
      "S2-v3-transcribe-16k",
      "stt-rest",
      "saaras:v3",
      "transcribe",
      `T1-v3-16k:${f.id}`,
      f.lang,
      "wav16k",
    );
  for (const f of LATENCY)
    stt("S6-ws-16k", "stt-ws", "saaras:v3", "codemix", `T1-v3-16k:${f.id}`, "unknown", "pcm16k");
  for (const f of byId(["hi-appointment", "te-appointment"]))
    stt("S7-ws-8k", "stt-ws", "saaras:v3", "codemix", `T2-v3-8k:${f.id}`, "unknown", "pcm8k");
  for (const f of where((x) => x.variant === "romanized"))
    stt(
      "S5-v3-romanized-src",
      "stt-rest",
      "saaras:v3",
      "codemix",
      `T4-v3-romanized:${f.id}`,
      "unknown",
      "wav16k",
    );
  for (const f of byId(["hi-phone-plain", "te-phone-plain"]))
    stt(
      "P2-stt-mulaw-probe",
      "stt-rest",
      "saaras:v3",
      "codemix",
      `T2-v3-8k:${f.id}`,
      "unknown",
      "mulaw8k",
      true,
    );
  for (const f of notRomanized)
    stt(
      "S3-v4-codemix-16k",
      "stt-rest",
      "saaras:v4",
      "codemix",
      `T1-v3-16k:${f.id}`,
      "unknown",
      "wav16k",
    );

  return items;
}

/** Planning estimate of speech duration (the ledger uses the real duration at run time). */
export const ESTIMATE_SECONDS_PER_CHAR = 0.085;
export const estimateSeconds = (chars: number): number =>
  Math.max(1.5, 0.5 + chars * ESTIMATE_SECONDS_PER_CHAR);

export interface PlanSummary {
  version: string;
  requests: number;
  probes: number;
  ttsChars: Record<TtsModel, number>;
  sttSecondsEstimate: number;
  /** Planned cost with no retries, excl. and incl. GST (STT from the duration estimate). */
  estimateExclGst: number;
  estimateInclGst: number;
  byStage: Record<string, { requests: number; costInclGst: number }>;
}

export function textOf(item: TtsItem): string {
  return FIXTURES.find((f) => f.id === item.fixtureId)!.text;
}

export function summarize(plan: PlanItem[], prices: Prices): PlanSummary {
  const chars: Record<TtsModel, number> = { "bulbul:v3": 0, "bulbul:v4-flash": 0 };
  let seconds = 0;
  let excl = 0;
  const byStage: PlanSummary["byStage"] = {};
  const tts = new Map(plan.filter(isTts).map((t) => [t.id, t]));
  for (const i of plan) {
    let cost: number;
    if (isTts(i)) {
      const c = ttsChars(textOf(i));
      chars[i.model] += c;
      cost = attemptCost(prices, { kind: "tts", model: i.model, chars: c });
    } else {
      const src = tts.get(i.source);
      if (!src) throw new Error(`plan: ${i.id} has no source ${i.source}`);
      const s = estimateSeconds(ttsChars(textOf(src)));
      seconds += Math.ceil(s);
      cost = attemptCost(prices, { kind: "stt", seconds: s });
    }
    excl += cost;
    const st = (byStage[i.stage] ??= { requests: 0, costInclGst: 0 });
    st.requests++;
    st.costInclGst += cost * (1 + prices.gstRate);
  }
  return {
    version: PLAN_VERSION,
    requests: plan.length,
    probes: plan.filter((i) => i.probe).length,
    ttsChars: chars,
    sttSecondsEstimate: seconds,
    estimateExclGst: excl,
    estimateInclGst: excl * (1 + prices.gstRate),
    byStage,
  };
}

/** Defaults sized to the approved scope (research: 6,000 + 1,200 TTS chars; ~700 s STT). */
export function defaultLimits(capInclGst: number, plan: PlanItem[]): Limits {
  return {
    capInclGst,
    ttsChars: { "bulbul:v3": 6000, "bulbul:v4-flash": 1200 },
    sttSeconds: 720,
    // Every planned request once, plus at most 20 retries in total.
    maxAttempts: plan.length + 20,
  };
}

export function planHash(
  plan: PlanItem[],
  prices: Prices,
  limits: Limits,
  extra: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: PLAN_VERSION, plan, prices, limits, extra }))
    .digest("hex")
    .slice(0, 16);
}
