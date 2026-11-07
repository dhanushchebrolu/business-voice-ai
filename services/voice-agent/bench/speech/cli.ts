/**
 * Sarvam speech harness entry point (bench/sarvam-speech-smoke.ts).
 *
 *   (default)   --dry-run   plan, volumes, cost estimate and plan hash; network disabled
 *               --simulate  full run against the in-process fake; network disabled;
 *                           writes results.json + report.md
 *               --live      PAID: every gate in gates.ts must hold, including
 *                           --confirm-plan <hash from a dry run with the same prices/budget>
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realClock, type Clock } from "./clients.ts";
import { FakeSarvam } from "./fake-sarvam.ts";
import { argValue, parseBudget, resolveSpeechGates } from "./gates.ts";
import { disableNetwork, networkDisabled } from "./network.ts";
import { buildPlan, defaultLimits, planHash, summarize, type PlanItem } from "./plan.ts";
import { Ledger, parsePrices, type Prices } from "./pricing.ts";
import { buildResults, markdownReport } from "./report.ts";
import { runPlan } from "./runner.ts";
import { authHeaders, liveTransport, redactor, type Transport } from "./transport.ts";

type Env = Record<string, string | undefined>;

export interface CliIo {
  log: (line: string) => void;
  clock?: Clock;
  /** Test seam: the transport for --simulate (default: a fresh FakeSarvam). */
  fake?: Transport;
}

/** Published pay-as-you-go prices (2026-11-03), used ONLY to label simulation spend. */
const SIMULATION_PRICES: Prices = {
  sttPerMinute: 0.49,
  ttsPer1k: { "bulbul:v3": 3, "bulbul:v4-flash": 2 },
  gstRate: 0.18,
};

function writeResults(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

/**
 * Digest of the code that will run: every harness file plus the imported
 * auth guard and gate helpers. Part of the plan hash, so a confirmed hash is
 * invalidated by ANY code change, not only by plan or price changes.
 */
export function harnessDigest(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    ...readdirSync(here)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(here, f)),
    join(here, "..", "sarvam-speech-smoke.ts"),
    join(here, "..", "smoke-gates.ts"),
    join(here, "..", "..", "src", "agent", "sarvam-llm.ts"),
  ].sort();
  const h = createHash("sha256");
  for (const f of files)
    h.update(`${f.slice(f.lastIndexOf("voice-agent"))}\0`)
      .update(readFileSync(f))
      .update("\0");
  return h.digest("hex").slice(0, 16);
}

function hashFor(plan: PlanItem[], prices: Prices, budget: number, authMode: string) {
  const limits = defaultLimits(budget, plan);
  return { limits, hash: planHash(plan, prices, limits, { authMode, code: harnessDigest() }) };
}

export async function main(argv: readonly string[], env: Env, io: CliIo): Promise<number> {
  const suite = argValue(argv, "--suite");
  if (suite === "stt-rest") return (await import("./stt-stage.ts")).mainSttRest(argv, env, io);
  if (suite !== undefined || (argv.includes("--suite") && suite === undefined)) {
    io.log("refusing to run: --suite must be stt-rest (or omitted for the full plan).");
    return 2;
  }
  const live = argv.includes("--live");
  const simulate = argv.includes("--simulate");
  if (live && simulate) {
    io.log("refusing to run: choose one of --live or --simulate.");
    return 2;
  }
  const plan = buildPlan();
  const clock = io.clock ?? realClock;
  const authMode = env.SARVAM_SPEECH_AUTH_MODE || "api-key";

  if (!live) {
    // Offline: nothing in this process may reach the network. (If a caller,
    // e.g. a test, already installed the kill switch, it stays in charge.)
    const ownGuard = networkDisabled() ? null : disableNetwork();
    const guard = ownGuard ?? { blocked: [] as Array<{ api: string; target: string }> };
    try {
      const entered = parsePrices(env);
      const budget = parseBudget(env);
      const prices = entered.ok ? entered.prices : SIMULATION_PRICES;
      const s = summarize(plan, prices);
      io.log(`speech plan ${s.version}: ${s.requests} requests (${s.probes} isolated probes)`);
      io.log(
        `TTS characters: bulbul:v3 ${s.ttsChars["bulbul:v3"]}, bulbul:v4-flash ${s.ttsChars["bulbul:v4-flash"]}; STT ≈ ${s.sttSecondsEstimate} s (estimate)`,
      );
      io.log(
        `estimated cost, no retries: ₹${s.estimateExclGst.toFixed(2)} excl. GST, ₹${s.estimateInclGst.toFixed(2)} incl. ${(prices.gstRate * 100).toFixed(0)}% GST` +
          (entered.ok
            ? " (entered prices)"
            : " (published pay-as-you-go prices; enter actual prices for a live run)"),
      );
      if (entered.ok && typeof budget === "number") {
        const { hash } = hashFor(plan, entered.prices, budget, authMode);
        io.log(`harness code digest: ${harnessDigest()}`);
        io.log(
          `plan hash for --confirm-plan (plan + prices + ₹${budget} cap + ${authMode} + code): ${hash}`,
        );
      } else {
        io.log(`no plan hash: ${!entered.ok ? entered.reason : budget}`);
      }
      if (!simulate) return 0;

      const out = argValue(argv, "--out");
      if (!out) {
        io.log("refusing to run: --simulate needs --out <dir>.");
        return 2;
      }
      const budgetInr = typeof budget === "number" ? budget : 40;
      const ledger = new Ledger(prices, defaultLimits(budgetInr, plan));
      const transport = io.fake ?? new FakeSarvam();
      const outcome = await runPlan(plan, {
        transport,
        ledger,
        headers: {},
        clock,
        redact: (x) => x,
        timeoutMs: 10_000,
        minIntervalMs: 0,
        retryBackoffMs: 0,
        realtimeStreaming: false,
        log: () => {},
      });
      const results = buildResults(plan.length, outcome, ledger, {
        mode: "simulate",
        planHash: hashFor(plan, prices, budgetInr, authMode).hash,
        prices,
        pricesSource: entered.ok ? "entered" : "published pay-as-you-go (simulation label only)",
        finishedAt: new Date().toISOString(),
        node: process.version,
        networkBlockedAttempts: guard.blocked.length,
      });
      writeResults(out, {
        "results.json": JSON.stringify(results, null, 2),
        "report.md": markdownReport(results),
      });
      io.log(
        `simulation: ${results.summary.requests.ok}/${plan.length} ok, stop: ${results.summary.stopReason ?? "none"}; wrote ${out}/results.json and report.md`,
      );
      io.log(`network attempts blocked during the run: ${guard.blocked.length}`);
      return 0;
    } finally {
      ownGuard?.restore();
    }
  }

  // ---------------- LIVE (paid) ----------------
  const g = resolveSpeechGates(env, argv);
  if (!g.ok) {
    io.log(`refusing to run: ${g.reason}`);
    return 2;
  }
  const { limits, hash } = hashFor(plan, g.prices, g.budgetInr, g.auth.mode);
  if (g.confirm !== hash) {
    io.log(
      "refusing to run: --confirm-plan does not match this plan, prices and budget (run a dry run to get the hash).",
    );
    return 2;
  }
  const s = summarize(plan, g.prices);
  if (s.estimateInclGst > g.budgetInr) {
    io.log(
      `refusing to run: the plan's estimate (₹${s.estimateInclGst.toFixed(2)} incl. GST) exceeds the ₹${g.budgetInr} cap.`,
    );
    return 2;
  }
  const redact = redactor(g.auth.mode === "api-key" ? [g.auth.apiKey] : []);
  const ledger = new Ledger(g.prices, limits);
  const audioDir = join(g.out, "audio");
  if (argv.includes("--save-audio")) mkdirSync(audioDir, { recursive: true });
  const outcome = await runPlan(plan, {
    transport: liveTransport(g.auth),
    ledger,
    headers: authHeaders(g.auth),
    clock,
    redact,
    timeoutMs: 30_000,
    minIntervalMs: 1100, // < 60 requests/minute (pay-as-you-go REST limit)
    retryBackoffMs: 2000,
    realtimeStreaming: true,
    onAudio: argv.includes("--save-audio")
      ? (id, audio, ext) =>
          writeFileSync(join(audioDir, `${id.replace(/[^\w.-]+/g, "_")}.${ext}`), audio)
      : undefined,
    log: (l) => io.log(redact(l)),
  });
  const results = buildResults(plan.length, outcome, ledger, {
    mode: "live",
    planHash: hash,
    prices: g.prices,
    pricesSource: "entered",
    authMode: g.auth.mode,
    finishedAt: new Date().toISOString(),
    node: process.version,
  });
  const json = redact(JSON.stringify(results, null, 2));
  writeResults(g.out, { "results.json": json, "report.md": redact(markdownReport(results)) });
  io.log(
    redact(
      `live run: ₹${ledger.spentInclGst.toFixed(4)} incl. GST of ₹${g.budgetInr}; stop: ${outcome.stopReason ?? "none"}; wrote ${g.out}`,
    ),
  );
  return outcome.stopReason && /authentication|credits|consecutive|refused/.test(outcome.stopReason)
    ? 1
    : 0;
}
