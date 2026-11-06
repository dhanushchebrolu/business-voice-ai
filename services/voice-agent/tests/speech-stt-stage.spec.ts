/**
 * STT REST stage (bench/speech/stt-stage.ts): STT only, on audio saved by an
 * earlier run; no TTS, no WebSocket; exact cost; cumulative cap. Offline:
 * network kill switch for the whole file; Sarvam is the in-process fake.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Clock } from "../bench/speech/clients.ts";
import { main } from "../bench/speech/cli.ts";
import { FakeSarvam } from "../bench/speech/fake-sarvam.ts";
import { FIXTURES } from "../bench/speech/fixtures.ts";
import { disableNetwork, type NetworkGuard } from "../bench/speech/network.ts";
import { buildPlan, type PlanItem } from "../bench/speech/plan.ts";
import { Ledger, type Prices } from "../bench/speech/pricing.ts";
import { buildResults } from "../bench/speech/report.ts";
import { runPlan } from "../bench/speech/runner.ts";
import {
  STT_REST_STAGES,
  audioFileName,
  buildSttRestPlan,
  loadSourceAudio,
  restOnly,
  sttCost,
} from "../bench/speech/stt-stage.ts";

const P: Prices = {
  sttPerMinute: 0.49,
  ttsPer1k: { "bulbul:v3": 3, "bulbul:v4-flash": 2 },
  gstRate: 0.18,
};
const clock: Clock = { now: () => performance.now(), sleep: async () => {} };
const ENV = {
  SARVAM_PRICE_STT_INR_PER_MIN: "0.49",
  SARVAM_PRICE_TTS_V3_INR_PER_1K_CHARS: "3.00",
  SARVAM_PRICE_TTS_V4_FLASH_INR_PER_1K_CHARS: "2.00",
  SARVAM_GST_RATE: "0.18",
  SARVAM_SPEECH_BUDGET_INR: "7",
  SARVAM_SPEECH_PRIOR_SPEND_INR: "15.5359",
  SARVAM_SPEECH_AUTH_MODE: "proxy-injected",
};
const LIVE_ENV = {
  ...ENV,
  SARVAM_SPEECH_APPROVED: "yes",
  HTTPS_PROXY: "http://127.0.0.1:9",
  NODE_USE_ENV_PROXY: "1",
};

let guard: NetworkGuard;
let dir: string;
let fake: FakeSarvam;
/** An "earlier run": the fake's TTS for T1/T2/T4, saved like cli.ts saves audio, plus its results.json. */
before(async () => {
  guard = disableNetwork();
  dir = mkdtempSync(join(tmpdir(), "stt-stage-"));
  mkdirSync(join(dir, "audio"));
  fake = new FakeSarvam();
  const tts: PlanItem[] = buildPlan().filter((i) =>
    ["T1-v3-16k", "T2-v3-8k", "T4-v3-romanized"].includes(i.stage),
  );
  const ledger = new Ledger(P, {
    capInclGst: 40,
    ttsChars: { "bulbul:v3": 1e6, "bulbul:v4-flash": 1e6 },
    sttSeconds: 1e6,
    maxAttempts: 1e6,
  });
  const out = await runPlan(tts, {
    transport: fake,
    ledger,
    headers: {},
    clock,
    redact: (x) => x,
    timeoutMs: 2000,
    minIntervalMs: 0,
    retryBackoffMs: 0,
    realtimeStreaming: false,
    onAudio: (id, audio) => writeFileSync(join(dir, "audio", audioFileName(id)), audio),
  });
  writeFileSync(
    join(dir, "results.json"),
    JSON.stringify(buildResults(tts.length, out, ledger, { mode: "test" })),
  );
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  guard.restore();
});

describe("STT REST stage: plan", () => {
  const plan = buildSttRestPlan();
  test("exactly the STT REST items of the existing plan: 160 requests, no TTS, no WebSocket", () => {
    assert.equal(plan.length, 160);
    assert.ok(plan.every((i) => i.kind === "stt-rest"));
    assert.deepEqual([...new Set(plan.map((i) => i.stage))], [...STT_REST_STAGES]);
    assert.deepEqual([...new Set(plan.map((i) => i.model))].sort(), ["saaras:v3", "saaras:v4"]);
  });
  test("covers 8 kHz telephony, the mu-law probes, romanized-source audio and every language/variant", () => {
    assert.equal(plan.filter((i) => i.input === "wav8k").length, 20);
    assert.equal(plan.filter((i) => i.input === "mulaw8k" && i.probe).length, 2);
    assert.equal(plan.filter((i) => i.stage === "S5-v3-romanized-src").length, 8);
    const covered = new Set(
      plan
        .map((i) => FIXTURES.find((f) => f.id === i.source.split(":")[1])!)
        .map((f) => `${f.lang}/${f.variant}`),
    );
    for (const k of [
      "en-IN/native",
      "hi-IN/native",
      "te-IN/native",
      "hi-IN/code-mixed",
      "te-IN/code-mixed",
      "hi-IN/romanized",
      "te-IN/romanized",
    ])
      assert.ok(covered.has(k), k);
    const cats = new Set(
      plan.map((i) => FIXTURES.find((f) => f.id === i.source.split(":")[1])!.category),
    );
    for (const c of ["appointment", "date", "time", "price", "phone-plain", "phone-grouped"])
      assert.ok(cats.has(c as never), c);
  });
});

describe("STT REST stage: source audio is verified against the earlier run", () => {
  const plan = buildSttRestPlan();
  const results = () => JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
  test("all 78 source clips load and verify", () => {
    const { sources, digest } = loadSourceAudio(plan, join(dir, "audio"), results());
    assert.equal(sources.size, 78);
    assert.match(digest, /^[0-9a-f]{16}$/);
  });
  test("a missing, altered or unrecorded clip refuses the run", () => {
    const tmp = mkdtempSync(join(tmpdir(), "stt-tamper-"));
    try {
      const target = audioFileName("T1-v3-16k:en-greeting");
      // altered: one byte appended (byte count differs from the record)
      for (const f of plan.map((i) => audioFileName(i.source)))
        writeFileSync(join(tmp, f), readFileSync(join(dir, "audio", f)));
      writeFileSync(
        join(tmp, target),
        Buffer.concat([readFileSync(join(dir, "audio", target)), Buffer.from([0])]),
      );
      assert.throws(() => loadSourceAudio(plan, tmp, results()), /bytes != recorded/);
      rmSync(join(tmp, target));
      assert.throws(() => loadSourceAudio(plan, tmp, results()), /audio file missing/);
      const r = results();
      r.items = r.items.filter((i: { id: string }) => i.id !== "T1-v3-16k:en-greeting");
      assert.throws(() => loadSourceAudio(plan, join(dir, "audio"), r), /not a successful item/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("STT REST stage: cost and limits", () => {
  const plan = buildSttRestPlan();
  test("worst case (every allowed retry on the most expensive request) fits the cap; TTS limits are zero", () => {
    const { sources } = loadSourceAudio(
      plan,
      join(dir, "audio"),
      JSON.parse(readFileSync(join(dir, "results.json"), "utf8")),
    );
    for (const cap of [7, 3, 1]) {
      const c = sttCost(plan, sources, P, cap);
      if (c.plannedInclGst <= cap)
        assert.ok(c.worstCaseInclGst <= cap + 1e-9, `cap ${cap}: worst ${c.worstCaseInclGst}`);
      assert.deepEqual(c.limits.ttsChars, { "bulbul:v3": 0, "bulbul:v4-flash": 0 });
      assert.equal(c.limits.maxAttempts, plan.length + c.retryAllowance);
      assert.ok(c.retryAllowance <= 20);
    }
  });
  test("a TTS attempt is refused by this stage's ledger; a WebSocket by its transport", () => {
    const { sources } = loadSourceAudio(
      plan,
      join(dir, "audio"),
      JSON.parse(readFileSync(join(dir, "results.json"), "utf8")),
    );
    const l = new Ledger(P, sttCost(plan, sources, P, 7).limits);
    assert.equal(l.check({ kind: "tts", model: "bulbul:v3", chars: 1 }).ok, false);
    assert.equal(l.check({ kind: "tts", model: "bulbul:v4-flash", chars: 1 }).ok, false);
    assert.throws(
      () => restOnly(fake).openSocket("wss://api.sarvam.ai/speech-to-text/ws", {}),
      /WebSocket connections are disabled/,
    );
  });
});

describe("STT REST stage: CLI gates", () => {
  const run = async (argv: string[], env: Record<string, string | undefined>) => {
    const lines: string[] = [];
    const code = await main(["node", "x", "--suite", "stt-rest", ...argv], env, {
      log: (l) => lines.push(l),
      clock,
      fake,
    });
    return { code, text: lines.join("\n") };
  };
  const audio = () => ["--stt-audio-from", join(dir, "audio")];
  test("cumulative cap: prior spend + budget over ₹40 is refused; prior spend is required", async () => {
    assert.match(
      (await run(audio(), { ...ENV, SARVAM_SPEECH_PRIOR_SPEND_INR: "33.01" })).text,
      /exceeds the cumulative ₹40 cap/,
    );
    assert.match(
      (await run(audio(), { ...ENV, SARVAM_SPEECH_PRIOR_SPEND_INR: undefined })).text,
      /SARVAM_SPEECH_PRIOR_SPEND_INR/,
    );
    assert.equal(
      (await run(audio(), { ...ENV, SARVAM_SPEECH_PRIOR_SPEND_INR: "33" })).code,
      0,
      "exactly ₹40 is allowed",
    );
  });
  test("the saved-audio directory is required (no TTS fallback)", async () => {
    assert.match((await run([], ENV)).text, /--stt-audio-from/);
  });
  test("a plan that does not fit the budget is refused with its exact cost", async () => {
    const r = await run(audio(), { ...ENV, SARVAM_PRICE_STT_INR_PER_MIN: "9.99" });
    assert.equal(r.code, 2);
    assert.match(r.text, /refusing to run: planned cost ₹\d+\.\d{4} exceeds the ₹7 cap/);
  });
  test("an unknown suite is refused", async () => {
    const lines: string[] = [];
    assert.equal(
      await main(["node", "x", "--suite", "everything"], ENV, { log: (l) => lines.push(l), clock }),
      2,
    );
  });
  test("live: a stale or wrong hash is refused", async () => {
    const r = await run(
      [...audio(), "--live", "--out", join(dir, "o1"), "--confirm-plan", "1aaccae8539925be"],
      LIVE_ENV,
    );
    assert.equal(r.code, 2);
    assert.match(r.text, /--confirm-plan does not match/);
  });
  test("live with the right hash, offline: blocked at the first request, nothing billed, no WebSocket, no TTS", async () => {
    const dry = await run(audio(), ENV);
    const hash = /plan hash for --confirm-plan[^:]*: ([0-9a-f]{16})/.exec(dry.text)![1]!;
    const before = guard.blocked.length;
    const r = await run(
      [...audio(), "--live", "--out", join(dir, "o2"), "--confirm-plan", hash],
      LIVE_ENV,
    );
    assert.equal(r.code, 1);
    const res = JSON.parse(readFileSync(join(dir, "o2", "results.json"), "utf8"));
    assert.equal(res.summary.attempts.billed, 0);
    assert.match(res.summary.stopReason, /refused locally/);
    assert.deepEqual(
      guard.blocked.slice(before).map((b) => [b.api, b.target]),
      [["fetch", "api.sarvam.ai"]],
    );
  });
  test("simulation: all 160 STT requests succeed against the fake; only STT REST endpoints are called", async () => {
    const callsBefore = fake.calls.length;
    const out = join(dir, "sim");
    const r = await run([...audio(), "--simulate", "--out", out], ENV);
    assert.equal(r.code, 0, r.text);
    const res = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
    assert.equal(res.summary.requests.ok, 160);
    const calls = fake.calls.slice(callsBefore);
    assert.equal(calls.length, 160);
    assert.deepEqual([...new Set(calls.map((c) => c.endpoint))], ["stt"]);
    assert.ok(res.summary.criteria[1].pass, "fake transcripts are perfect, so entities pass");
  });
});
