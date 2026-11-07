/**
 * Stage: STT REST only, on audio saved by an earlier run (no TTS, no
 * WebSocket). `bench/sarvam-speech-smoke.ts --suite stt-rest`.
 *
 *  - plan: the existing plan's STT REST items only (S1, S4, S2, S5, P2, S3,
 *    in the existing priority order, so a limit cuts the saaras:v4
 *    comparison first);
 *  - source audio: loaded from the earlier run's audio directory and checked
 *    against that run's results.json (status, format, rate, bytes, duration);
 *    any mismatch refuses the run;
 *  - cost: exact, from the real audio (each request rounded UP to a whole
 *    second); the retry allowance is sized so that even the worst case
 *    (every allowed retry on the most expensive request) fits the cap;
 *  - cumulative cap: SARVAM_SPEECH_PRIOR_SPEND_INR + this budget <= ₹40;
 *  - no TTS: the ledger's TTS character limits are 0; no WebSocket: the
 *    transport refuses to open one.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWav, wavSamples } from "./audio.ts";
import { realClock, type Clock } from "./clients.ts";
import { harnessDigest, type CliIo } from "./cli.ts";
import { FakeSarvam } from "./fake-sarvam.ts";
import { argValue, parseBudget, resolveSpeechGates } from "./gates.ts";
import { disableNetwork, networkDisabled } from "./network.ts";
import { buildPlan, planHash, type SttItem } from "./plan.ts";
import {
  HARD_CAP_INR,
  Ledger,
  attemptCost,
  parsePrices,
  sttBillableSeconds,
  type Limits,
  type Prices,
} from "./pricing.ts";
import { buildResults, markdownReport } from "./report.ts";
import { runPlan, type ItemResult } from "./runner.ts";
import {
  AuthGuardError,
  authHeaders,
  liveTransport,
  redactor,
  type Transport,
} from "./transport.ts";
import { mkdirSync, writeFileSync } from "node:fs";

type Env = Record<string, string | undefined>;

export const STT_REST_STAGES = [
  "S1-v3-codemix-16k",
  "S4-v3-codemix-8k",
  "S2-v3-transcribe-16k",
  "S5-v3-romanized-src",
  "P2-stt-mulaw-probe",
  "S3-v4-codemix-16k",
] as const;

export function buildSttRestPlan(): SttItem[] {
  return buildPlan().filter(
    (i): i is SttItem =>
      i.kind === "stt-rest" && (STT_REST_STAGES as readonly string[]).includes(i.stage),
  );
}

export interface SourceAudio {
  fixtureId: string;
  samples: Int16Array;
  sampleRate: number;
  sha256: string;
  durationSec: number;
}

/** The saved file name the harness used for an item id (cli.ts onAudio). */
export const audioFileName = (id: string) => `${id.replace(/[^\w.-]+/g, "_")}.wav`;

/**
 * Loads every source clip the plan needs and verifies it against the earlier
 * run's results.json. Throws (refusing the run) on any missing or mismatched clip.
 */
export function loadSourceAudio(
  plan: SttItem[],
  audioDir: string,
  priorResults: { items: ItemResult[] },
): {
  sources: Map<string, SourceAudio>;
  digest: string;
} {
  const sources = new Map<string, SourceAudio>();
  const all = createHash("sha256");
  for (const id of [...new Set(plan.map((i) => i.source))].sort()) {
    const rec = priorResults.items.find((r) => r.id === id);
    if (!rec || rec.status !== "ok" || !rec.audio)
      throw new Error(`source ${id}: not a successful item of the earlier run`);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(join(audioDir, audioFileName(id))));
    } catch {
      throw new Error(`source ${id}: audio file missing`);
    }
    const info = parseWav(bytes);
    if (info.format !== "pcm16" || info.channels !== 1)
      throw new Error(`source ${id}: not mono PCM16`);
    if (info.sampleRate !== rec.audio.sampleRate)
      throw new Error(
        `source ${id}: sample rate ${info.sampleRate} != recorded ${rec.audio.sampleRate}`,
      );
    if (bytes.length !== rec.audio.bytes)
      throw new Error(`source ${id}: ${bytes.length} bytes != recorded ${rec.audio.bytes}`);
    const { samples, sampleRate } = wavSamples(bytes);
    const durationSec = samples.length / sampleRate;
    if (Math.abs(durationSec - rec.audio.durationSec) > 0.01)
      throw new Error(`source ${id}: duration differs from the record`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    all.update(`${id}\0${sha256}\0`);
    sources.set(id, { fixtureId: rec.fixtureId, samples, sampleRate, sha256, durationSec });
  }
  return { sources, digest: all.digest("hex").slice(0, 16) };
}

export interface SttCost {
  requests: number;
  billableSeconds: number;
  plannedExclGst: number;
  plannedInclGst: number;
  maxItemInclGst: number;
  maxItemSeconds: number;
  retryAllowance: number;
  worstCaseInclGst: number;
  byStage: Record<string, { requests: number; seconds: number; inclGst: number }>;
  limits: Limits;
}

/** Exact cost of the plan on the real audio, and limits that keep even the worst case within the cap. */
export function sttCost(
  plan: SttItem[],
  sources: Map<string, SourceAudio>,
  prices: Prices,
  capInclGst: number,
): SttCost {
  let seconds = 0;
  let excl = 0;
  let maxItem = 0;
  let maxSec = 0;
  const byStage: SttCost["byStage"] = {};
  for (const i of plan) {
    const s = sources.get(i.source)!;
    const sec = s.durationSec; // resampling 16k<->8k keeps duration
    const c = attemptCost(prices, { kind: "stt", seconds: sec });
    seconds += sttBillableSeconds(sec);
    excl += c;
    maxItem = Math.max(maxItem, c * (1 + prices.gstRate));
    maxSec = Math.max(maxSec, sttBillableSeconds(sec));
    const st = (byStage[i.stage] ??= { requests: 0, seconds: 0, inclGst: 0 });
    st.requests++;
    st.seconds += sttBillableSeconds(sec);
    st.inclGst += c * (1 + prices.gstRate);
  }
  const planned = excl * (1 + prices.gstRate);
  const retryAllowance = Math.max(0, Math.min(20, Math.floor((capInclGst - planned) / maxItem)));
  return {
    requests: plan.length,
    billableSeconds: seconds,
    plannedExclGst: excl,
    plannedInclGst: planned,
    maxItemInclGst: maxItem,
    maxItemSeconds: maxSec,
    retryAllowance,
    worstCaseInclGst: planned + retryAllowance * maxItem,
    byStage,
    limits: {
      capInclGst,
      ttsChars: { "bulbul:v3": 0, "bulbul:v4-flash": 0 }, // no TTS in this stage
      sttSeconds: seconds + retryAllowance * maxSec,
      maxAttempts: plan.length + retryAllowance,
    },
  };
}

export function parsePriorSpend(env: Env): number | string {
  const raw = env.SARVAM_SPEECH_PRIOR_SPEND_INR;
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw.trim()))
    return "SARVAM_SPEECH_PRIOR_SPEND_INR must be the spend of earlier runs (incl. GST), e.g. 15.5359";
  return Number(raw);
}

/** A transport that refuses WebSockets (this stage is REST only). */
export function restOnly(t: Transport): Transport {
  return {
    name: t.name,
    fetch: t.fetch,
    openSocket: () => {
      throw new AuthGuardError("WebSocket connections are disabled in the STT REST stage");
    },
  };
}

export async function mainSttRest(argv: readonly string[], env: Env, io: CliIo): Promise<number> {
  // Offline (dry run / simulate): the whole path runs with the network kill switch installed.
  const ownGuard = !argv.includes("--live") && !networkDisabled() ? disableNetwork() : null;
  try {
    return await runSttRest(argv, env, io);
  } finally {
    ownGuard?.restore();
  }
}

async function runSttRest(argv: readonly string[], env: Env, io: CliIo): Promise<number> {
  const live = argv.includes("--live");
  const plan = buildSttRestPlan();
  const audioDir = argValue(argv, "--stt-audio-from");
  if (!audioDir) {
    io.log(
      "refusing to run: --stt-audio-from <earlier run>/audio is required (this stage makes no TTS requests).",
    );
    return 2;
  }
  const resultsPath = argValue(argv, "--stt-audio-results") ?? join(audioDir, "..", "results.json");
  const prior = parsePriorSpend(env);
  const budget = parseBudget(env);
  const prices = parsePrices(env);
  for (const v of [prior, budget])
    if (typeof v === "string") return (io.log(`refusing to run: ${v}`), 2);
  if (!prices.ok) return (io.log(`refusing to run: ${prices.reason}`), 2);
  if ((prior as number) + (budget as number) > HARD_CAP_INR + 1e-9) {
    io.log(
      `refusing to run: prior spend ₹${prior} + this budget ₹${budget} exceeds the cumulative ₹${HARD_CAP_INR} cap.`,
    );
    return 2;
  }
  let loaded: ReturnType<typeof loadSourceAudio>;
  try {
    loaded = loadSourceAudio(plan, audioDir, JSON.parse(readFileSync(resultsPath, "utf8")));
  } catch (e) {
    io.log(`refusing to run: source audio check failed: ${(e as Error).message}`);
    return 2;
  }
  const cost = sttCost(plan, loaded.sources, prices.prices, budget as number);
  const authMode = env.SARVAM_SPEECH_AUTH_MODE || "api-key";
  const hash = planHash(plan, prices.prices, cost.limits, {
    authMode,
    code: harnessDigest(),
    suite: "stt-rest",
    priorSpendInr: prior,
    sourceAudio: loaded.digest,
  });
  io.log(
    `STT REST stage: ${cost.requests} requests (${plan.filter((i) => i.probe).length} mu-law probes), ${loaded.sources.size} verified source clips (digest ${loaded.digest})`,
  );
  for (const [k, v] of Object.entries(cost.byStage))
    io.log(
      `  ${k}: ${v.requests} requests, ${v.seconds} s billable, ₹${v.inclGst.toFixed(4)} incl. GST`,
    );
  io.log(
    `billable audio: ${cost.billableSeconds} s (${(cost.billableSeconds / 60).toFixed(2)} min, each request rounded up to a whole second)`,
  );
  io.log(
    `planned cost: ₹${cost.plannedExclGst.toFixed(4)} excl. GST, ₹${cost.plannedInclGst.toFixed(4)} incl. ${(prices.prices.gstRate * 100).toFixed(0)}% GST`,
  );
  io.log(
    `retry allowance ${cost.retryAllowance} (most expensive request ₹${cost.maxItemInclGst.toFixed(4)}); worst case ₹${cost.worstCaseInclGst.toFixed(4)} of the ₹${budget} cap`,
  );
  io.log(
    `cumulative: prior ₹${prior} + this cap ₹${budget} = ₹${((prior as number) + (budget as number)).toFixed(4)} <= ₹${HARD_CAP_INR}`,
  );
  io.log(`harness code digest: ${harnessDigest()}`);
  io.log(
    `plan hash for --confirm-plan (stt-rest + plan + prices + cap + prior spend + source audio + ${authMode} + code): ${hash}`,
  );
  if (cost.plannedInclGst > (budget as number)) {
    io.log(
      `refusing to run: planned cost ₹${cost.plannedInclGst.toFixed(4)} exceeds the ₹${budget} cap.`,
    );
    return 2;
  }

  const sources = new Map(
    [...loaded.sources].map(([k, v]) => [
      k,
      { fixtureId: v.fixtureId, samples: v.samples, sampleRate: v.sampleRate },
    ]),
  );
  const clock: Clock = io.clock ?? realClock;
  if (!live) {
    if (!argv.includes("--simulate")) return 0;
    const out = argValue(argv, "--out");
    if (!out) return (io.log("refusing to run: --simulate needs --out <dir>."), 2);
    {
      const ledger = new Ledger(prices.prices, cost.limits);
      const outcome = await runPlan(plan, {
        transport: restOnly(io.fake ?? new FakeSarvam()),
        ledger,
        headers: {},
        clock,
        redact: (x) => x,
        timeoutMs: 10_000,
        minIntervalMs: 0,
        retryBackoffMs: 0,
        realtimeStreaming: false,
        preloaded: sources,
      });
      const results = buildResults(plan.length, outcome, ledger, {
        mode: "simulate",
        suite: "stt-rest",
        planHash: hash,
        prices: prices.prices,
        finishedAt: new Date().toISOString(),
      });
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
      writeFileSync(join(out, "report.md"), markdownReport(results));
      io.log(
        `simulation: ${results.summary.requests.ok}/${plan.length} ok; stop: ${results.summary.stopReason ?? "none"}`,
      );
      return 0;
    }
  }

  // ---------------- LIVE (paid) ----------------
  const g = resolveSpeechGates(env, argv);
  if (!g.ok) return (io.log(`refusing to run: ${g.reason}`), 2);
  if (g.confirm !== hash) {
    io.log(
      "refusing to run: --confirm-plan does not match this stage's plan, prices, budget, prior spend, source audio and code (run the dry run to get the hash).",
    );
    return 2;
  }
  const redact = redactor(g.auth.mode === "api-key" ? [g.auth.apiKey] : []);
  const ledger = new Ledger(g.prices, cost.limits);
  const outcome = await runPlan(plan, {
    transport: restOnly(liveTransport(g.auth)),
    ledger,
    headers: authHeaders(g.auth),
    clock,
    redact,
    timeoutMs: 30_000,
    minIntervalMs: 1100, // < 60 requests/minute (pay-as-you-go STT REST limit)
    retryBackoffMs: 2000,
    realtimeStreaming: true,
    preloaded: sources,
    log: (l) => io.log(redact(l)),
  });
  const spent = ledger.spentInclGst;
  const results = buildResults(plan.length, outcome, ledger, {
    mode: "live",
    suite: "stt-rest",
    planHash: hash,
    prices: g.prices,
    pricesSource: "entered",
    authMode: g.auth.mode,
    priorSpendInclGstInr: prior,
    cumulativeSpendInclGstInr: Number(((prior as number) + spent).toFixed(4)),
    sourceAudioDigest: loaded.digest,
    finishedAt: new Date().toISOString(),
    node: process.version,
  });
  mkdirSync(g.out, { recursive: true });
  writeFileSync(join(g.out, "results.json"), redact(JSON.stringify(results, null, 2)));
  writeFileSync(join(g.out, "report.md"), redact(markdownReport(results)));
  io.log(
    redact(
      `live STT REST run: ₹${spent.toFixed(4)} incl. GST of ₹${g.budgetInr} (cumulative ₹${((prior as number) + spent).toFixed(4)} of ₹${HARD_CAP_INR}); stop: ${outcome.stopReason ?? "none"}; wrote ${g.out}`,
    ),
  );
  return outcome.stopReason && /authentication|credits|consecutive|refused/.test(outcome.stopReason)
    ? 1
    : 0;
}
