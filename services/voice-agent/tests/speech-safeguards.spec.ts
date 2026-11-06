/**
 * Phase 3 speech harness: financial, network, authentication and secret
 * safeguards. Everything here is offline: the network kill switch is
 * installed for the whole file (loopback allowed only for the one test that
 * proves loopback works), and Sarvam is only ever the in-process fake.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https, { request as namedHttpsRequest } from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import dns from "node:dns";
import { after, before, describe, test } from "node:test";
import type { Clock } from "../bench/speech/clients.ts";
import { harnessDigest, main } from "../bench/speech/cli.ts";
import { scrubTokens } from "../bench/speech/clients.ts";
import { FakeSarvam, type Fault } from "../bench/speech/fake-sarvam.ts";
import { resolveSpeechGates } from "../bench/speech/gates.ts";
import {
  NetworkDisabledError,
  disableNetwork,
  type NetworkGuard,
} from "../bench/speech/network.ts";
import {
  buildPlan,
  defaultLimits,
  planHash,
  textOf,
  type PlanItem,
  type TtsItem,
} from "../bench/speech/plan.ts";
import {
  HARD_CAP_INR,
  Ledger,
  attemptCost,
  parsePrices,
  type Prices,
} from "../bench/speech/pricing.ts";
import { buildResults, markdownReport } from "../bench/speech/report.ts";
import { runPlan, type RunOptions } from "../bench/speech/runner.ts";
import { authHeaders, liveTransport, redactor, type Transport } from "../bench/speech/transport.ts";

const P: Prices = {
  sttPerMinute: 0.49,
  ttsPer1k: { "bulbul:v3": 3, "bulbul:v4-flash": 2 },
  gstRate: 0.18,
};
const clock: Clock = { now: () => performance.now(), sleep: async () => {} };
const FULL = buildPlan();
const pick = (...ids: string[]): PlanItem[] => ids.map((id) => FULL.find((i) => i.id === id)!);
const ledger = (capInclGst = 40, plan: PlanItem[] = FULL) =>
  new Ledger(P, defaultLimits(capInclGst, plan));
const opts = (transport: Transport, l: Ledger, extra: Partial<RunOptions> = {}): RunOptions => ({
  transport,
  ledger: l,
  headers: {},
  clock,
  redact: (x) => x,
  timeoutMs: 2000,
  minIntervalMs: 0,
  retryBackoffMs: 0,
  realtimeStreaming: false,
  ...extra,
});
const TTS_EN = "T1-v3-16k:en-appointment";
const TTS_HI = "T1-v3-16k:hi-appointment";
const STT_EN = "S1-v3-codemix-16k:T1-v3-16k:en-appointment";
const fault = (when: Fault["when"], respond: Fault["respond"], times = 1): Fault => ({
  when,
  respond,
  times,
});
const EN_CHARS = textOf(FULL.find((i) => i.id === TTS_EN) as TtsItem).length;

let guard: NetworkGuard;
before(() => {
  guard = disableNetwork();
});
after(() => guard.restore());

/* ------------------------------------------------------------------ prices */

describe("prices are entered at runtime, never defaulted", () => {
  const ENV = {
    SARVAM_PRICE_STT_INR_PER_MIN: "0.49",
    SARVAM_PRICE_TTS_V3_INR_PER_1K_CHARS: "3.00",
    SARVAM_PRICE_TTS_V4_FLASH_INR_PER_1K_CHARS: "2",
    SARVAM_GST_RATE: "0.18",
  };
  test("all four values parse", () => {
    assert.deepEqual(parsePrices(ENV), { ok: true, prices: P });
  });
  for (const k of Object.keys(ENV))
    test(`missing ${k} is refused by name`, () => {
      const r = parsePrices({ ...ENV, [k]: undefined });
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, new RegExp(k));
    });
  test("anything but a plain in-range number is refused", () => {
    for (const bad of ["₹3", "3/1000", "1e2", "-1", "0.49 ", " ", "NaN", "999"])
      assert.equal(
        parsePrices({ ...ENV, SARVAM_PRICE_TTS_V3_INR_PER_1K_CHARS: bad }).ok,
        bad === "0.49 ",
        bad,
      );
    assert.equal(
      parsePrices({ ...ENV, SARVAM_GST_RATE: "18" }).ok,
      false,
      "GST is a rate (0.18), not a percentage",
    );
  });
  test("cost model: TTS per character; STT per second, rounded up per request", () => {
    assert.equal(attemptCost(P, { kind: "tts", model: "bulbul:v3", chars: 1000 }), 3);
    assert.equal(attemptCost(P, { kind: "tts", model: "bulbul:v4-flash", chars: 500 }), 1);
    assert.equal(attemptCost(P, { kind: "stt", seconds: 60.01 }), (61 / 60) * 0.49);
    assert.equal(attemptCost(P, { kind: "stt", seconds: 0.2 }), (1 / 60) * 0.49);
  });
});

/* ------------------------------------------------------------------ ledger */

describe("ledger: hard cap and volume limits", () => {
  test(`the cap can never be set above ₹${HARD_CAP_INR} incl. GST`, () => {
    assert.throws(() => ledger(40.01));
    assert.throws(() => ledger(0));
    assert.doesNotThrow(() => ledger(40));
  });
  test("an attempt is refused if its full cost (incl. GST) would cross the cap; exactly reaching it is allowed", () => {
    const one = 3 * 1.18; // 1,000 v3 characters incl. GST
    const l = new Ledger(P, {
      capInclGst: one * 2,
      ttsChars: { "bulbul:v3": 1e9, "bulbul:v4-flash": 1e9 },
      sttSeconds: 1e9,
      maxAttempts: 100,
    });
    const a = { kind: "tts", model: "bulbul:v3", chars: 1000 } as const;
    assert.ok(l.check(a).ok);
    l.billed(a);
    assert.ok(l.check(a).ok, "reaching the cap exactly is fine");
    l.billed(a);
    const r = l.check({ kind: "tts", model: "bulbul:v3", chars: 1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /spending cap/);
  });
  test("character, second and attempt limits are enforced", () => {
    const l = new Ledger(P, {
      capInclGst: 40,
      ttsChars: { "bulbul:v3": 100, "bulbul:v4-flash": 10 },
      sttSeconds: 5,
      maxAttempts: 2,
    });
    assert.equal(l.check({ kind: "tts", model: "bulbul:v4-flash", chars: 11 }).ok, false);
    assert.equal(l.check({ kind: "stt", seconds: 5.01 }).ok, false, "5.01 s bills as 6 s");
    l.billed({ kind: "stt", seconds: 1 });
    l.billed({ kind: "stt", seconds: 1 });
    const r = l.check({ kind: "stt", seconds: 1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /request limit/);
  });
});

/* ------------------------------------------------------------------ runner: money */

describe("runner: stops before the cap and bills every attempt that may have reached Sarvam", () => {
  test("a tiny cap stops the run before the request that would cross it; spend never exceeds it", async () => {
    const fake = new FakeSarvam();
    const l = ledger(1); // ₹1
    const out = await runPlan(FULL, opts(fake, l));
    assert.match(out.stopReason ?? "", /spending cap/);
    assert.ok(l.spentInclGst <= 1 + 1e-9, `spent ₹${l.spentInclGst}`);
    assert.equal(
      fake.calls.length,
      l.billedAttempts,
      "every billed attempt is a call that was made",
    );
    assert.ok(out.items.some((i) => i.status === "not-run"));
  });

  test("a retry is a second, separately billed attempt", async () => {
    const fake = new FakeSarvam({ faults: [fault((c) => c.endpoint === "tts", { status: 503 })] });
    const l = ledger();
    const out = await runPlan(pick(TTS_EN), opts(fake, l));
    const item = out.items[0]!;
    assert.equal(item.status, "ok");
    assert.deepEqual(
      item.attempts.map((a) => [a.outcome, a.status, a.billed]),
      [
        ["http", 503, true],
        ["ok", 200, true],
      ],
    );
    assert.equal(l.billedAttempts, 2);
    const one = l.costInclGst({ kind: "tts", model: "bulbul:v3", chars: EN_CHARS });
    assert.ok(Math.abs(l.spentInclGst - 2 * one) < 1e-9, "both attempts charged in full");
  });

  test("failed requests are charged in full (5xx twice: two charges, item failed)", async () => {
    const fake = new FakeSarvam({
      faults: [fault((c) => c.endpoint === "tts", { status: 500 }, 2)],
    });
    const l = ledger();
    const out = await runPlan(pick(TTS_EN), opts(fake, l));
    assert.equal(out.items[0]!.status, "failed");
    assert.equal(l.billedAttempts, 2);
  });

  test("the cap covers retries: if the retry cannot fit, it is not sent", async () => {
    const cost = new Ledger(P, defaultLimits(40, FULL)).costInclGst({
      kind: "tts",
      model: "bulbul:v3",
      chars: EN_CHARS,
    });
    const fake = new FakeSarvam({ faults: [fault((c) => c.endpoint === "tts", { status: 503 })] });
    const l = new Ledger(P, { ...defaultLimits(40, FULL), capInclGst: cost * 1.5 });
    const out = await runPlan(pick(TTS_EN), opts(fake, l));
    assert.equal(fake.calls.length, 1, "the retry was never sent");
    assert.match(out.stopReason ?? "", /spending cap/);
  });

  test("an attempt refused locally (guard / network disabled) is free and stops the run", async () => {
    const blocked: Transport = {
      name: "live",
      fetch: (async () => {
        throw new NetworkDisabledError("fetch", "api.sarvam.ai");
      }) as typeof fetch,
      openSocket: () => {
        throw new NetworkDisabledError("WebSocket", "api.sarvam.ai");
      },
    };
    const l = ledger();
    const out = await runPlan(pick(TTS_EN, TTS_HI), opts(blocked, l));
    assert.equal(l.billedAttempts, 0);
    assert.equal(l.spentInclGst, 0);
    assert.equal(l.freeAttempts, 1);
    assert.match(out.stopReason ?? "", /refused locally/);
    assert.equal(out.items[1]!.status, "not-run");
  });
});

/* ------------------------------------------------------------------ runner: stops */

describe("runner: stop conditions", () => {
  for (const status of [401, 403, 402])
    test(`HTTP ${status} stops the whole run immediately (no retry, nothing further sent)`, async () => {
      const fake = new FakeSarvam({ faults: [fault(() => true, { status })] });
      const out = await runPlan(pick(TTS_EN, TTS_HI), opts(fake, ledger()));
      assert.equal(fake.calls.length, 1);
      assert.match(
        out.stopReason ?? "",
        status === 402 ? /credits exhausted/ : /authentication rejected/,
      );
      assert.equal(out.items[1]!.status, "not-run");
    });

  test("three consecutive connection failures stop the run (retries count)", async () => {
    const fake = new FakeSarvam({ faults: [fault(() => true, { transport: true }, 99)] });
    const out = await runPlan(
      pick(TTS_EN, TTS_HI, "T1-v3-16k:te-appointment"),
      opts(fake, ledger()),
    );
    assert.equal(fake.calls.length, 3);
    assert.match(out.stopReason ?? "", /3 consecutive connection failures/);
  });

  test("429 and timeouts are retried once, then the next request proceeds", async () => {
    const fake = new FakeSarvam({
      faults: [
        fault((c, n) => n === 1, { status: 429 }),
        fault((c, n) => n === 3, { timeout: true }),
      ],
    });
    const out = await runPlan(pick(TTS_EN, TTS_HI), opts(fake, ledger()));
    assert.deepEqual(
      out.items.map((i) => [i.status, i.attempts.length]),
      [
        ["ok", 2],
        ["ok", 2],
      ],
    );
    assert.equal(out.stopReason, null);
  });

  test("a dropped WebSocket (1011) is retried once", async () => {
    const fake = new FakeSarvam({
      faults: [fault((c) => c.endpoint === "tts-ws", { wsClose: 1011, reason: "server error" })],
    });
    const out = await runPlan(pick("T7-ws-stream:en-appointment"), opts(fake, ledger()));
    assert.deepEqual(
      out.items[0]!.attempts.map((a) => a.outcome),
      ["ws-closed", "ok"],
    );
  });

  test("five identical non-retryable errors in a row stop the run (systematic request problem); 4xx is not retried", async () => {
    const fake = new FakeSarvam({
      faults: [
        fault(
          () => true,
          { status: 422, body: { error: { code: "invalid_request_error", message: "bad field" } } },
          99,
        ),
      ],
    });
    const plan = FULL.filter((i) => i.stage === "T1-v3-16k").slice(0, 8);
    const out = await runPlan(plan, opts(fake, ledger()));
    assert.equal(fake.calls.length, 5, "no retries for 422, and the run stopped at the fifth");
    assert.match(out.stopReason ?? "", /5 consecutive identical errors/);
  });

  test("an isolated probe's failures never stop the run", async () => {
    const fake = new FakeSarvam({
      faults: [fault((c) => c.codec === "mulaw", { status: 400 }, 99)],
    });
    const plan = [...FULL.filter((i) => i.stage === "P1-tts-mulaw-probe"), ...pick(TTS_EN)];
    const out = await runPlan(plan, opts(fake, ledger()));
    assert.deepEqual(
      out.items.map((i) => i.status),
      ["failed", "failed", "ok"],
    );
    assert.equal(out.stopReason, null);
  });
});

/* ------------------------------------------------------------------ no fallback */

describe("never falls back to another model", () => {
  test("when saaras:v4 / bulbul:v4-flash fail, every call still carries the plan's model", async () => {
    const fake = new FakeSarvam({
      faults: [
        fault(
          (c) => c.model === "saaras:v4" || c.model === "bulbul:v4-flash",
          { status: 400, body: { error: { code: "model_not_supported" } } },
          999,
        ),
      ],
    });
    const plan = [
      ...pick(TTS_EN, "T5-v4flash:en-appointment", STT_EN),
      FULL.find((i) => i.id === "S3-v4-codemix-16k:T1-v3-16k:en-appointment")!,
    ];
    const out = await runPlan(plan, opts(fake, ledger()));
    const sent = out.items.flatMap((i) => i.attempts.map(() => i.model));
    assert.deepEqual(
      fake.calls.map((c) => c.model),
      sent,
      "each call's model is exactly its plan item's",
    );
    assert.deepEqual(
      out.items.map((i) => [i.model, i.status]),
      [
        ["bulbul:v3", "ok"],
        ["bulbul:v4-flash", "failed"],
        ["saaras:v3", "ok"],
        ["saaras:v4", "failed"],
      ],
    );
    assert.equal(
      fake.calls.filter((c) => c.model === "saaras:v3").length,
      1,
      "v4 failure did not trigger a v3 call",
    );
  });
});

/* ------------------------------------------------------------------ live gates */

describe("live mode gates", () => {
  const OK_ENV = {
    SARVAM_SPEECH_APPROVED: "yes",
    SARVAM_SPEECH_BUDGET_INR: "40",
    SARVAM_PRICE_STT_INR_PER_MIN: "0.49",
    SARVAM_PRICE_TTS_V3_INR_PER_1K_CHARS: "3",
    SARVAM_PRICE_TTS_V4_FLASH_INR_PER_1K_CHARS: "2",
    SARVAM_GST_RATE: "0.18",
    SARVAM_SPEECH_AUTH_MODE: "proxy-injected",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NODE_USE_ENV_PROXY: "1",
  };
  const ARGV = ["node", "x", "--live", "--out", "/tmp/x", "--confirm-plan", "abc"];
  const NODE = "v22.23.4";
  const refuses = (env: Record<string, string | undefined>, argv: string[], re: RegExp) => {
    const g = resolveSpeechGates(env, argv, NODE);
    assert.equal(g.ok, false);
    if (!g.ok) assert.match(g.reason, re);
  };
  test("all gates hold -> ok", () => {
    const g = resolveSpeechGates(OK_ENV, ARGV, NODE);
    assert.ok(g.ok && g.budgetInr === 40 && g.auth.mode === "proxy-injected");
  });
  test("each gate refuses on its own", () => {
    refuses(OK_ENV, ["node", "x", "--out", "/tmp/x", "--confirm-plan", "abc"], /--live/);
    for (const v of [undefined, "", "YES", "true"])
      refuses({ ...OK_ENV, SARVAM_SPEECH_APPROVED: v }, ARGV, /SARVAM_SPEECH_APPROVED=yes/);
    for (const v of [undefined, "0", "40.5", "41", "100", "abc"])
      refuses({ ...OK_ENV, SARVAM_SPEECH_BUDGET_INR: v }, ARGV, /SARVAM_SPEECH_BUDGET_INR/);
    refuses(
      { ...OK_ENV, SARVAM_PRICE_STT_INR_PER_MIN: undefined },
      ARGV,
      /SARVAM_PRICE_STT_INR_PER_MIN/,
    );
    refuses({ ...OK_ENV, SARVAM_API_KEY: "sk_x" }, ARGV, /unset SARVAM_API_KEY/);
    refuses({ ...OK_ENV, HTTPS_PROXY: undefined }, ARGV, /HTTPS_PROXY/);
    refuses({ ...OK_ENV, NODE_USE_ENV_PROXY: undefined }, ARGV, /NODE_USE_ENV_PROXY=1/);
    refuses({ ...OK_ENV, NO_PROXY: "api.sarvam.ai" }, ARGV, /NO_PROXY/);
    refuses({ ...OK_ENV, SARVAM_SPEECH_AUTH_MODE: "proxy" }, ARGV, /api-key or proxy-injected/);
    refuses({ ...OK_ENV, SARVAM_SPEECH_AUTH_MODE: undefined }, ARGV, /SARVAM_API_KEY is not set/);
    refuses(OK_ENV, ["node", "x", "--live", "--confirm-plan", "abc"], /--out/);
    refuses(OK_ENV, ["node", "x", "--live", "--out", "/tmp/x"], /--confirm-plan/);
    refuses(
      OK_ENV,
      ["node", "x", "--live", "--out", "/tmp/x", "--confirm-plan", "--simulate"],
      /--confirm-plan/,
    );
  });

  test("the plan hash binds plan, prices, budget and auth mode", () => {
    const plan = buildPlan();
    const h = (p: Prices, cap: number, mode = "proxy-injected") =>
      planHash(plan, p, defaultLimits(cap, plan), { authMode: mode });
    assert.equal(h(P, 40), h(P, 40));
    assert.notEqual(h(P, 40), h(P, 30));
    assert.notEqual(h(P, 40), h({ ...P, sttPerMinute: 0.45 }, 40));
    assert.notEqual(h(P, 40), h(P, 40, "api-key"));
  });

  test("CLI live: a wrong --confirm-plan hash is refused; the network is never touched", async () => {
    const lines: string[] = [];
    const before = guard.blocked.length;
    const code = await main(ARGV, OK_ENV, { log: (l) => lines.push(l), clock });
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /--confirm-plan does not match/);
    assert.equal(guard.blocked.length, before);
  });

  test("CLI live, fully approved with the right hash: in this offline phase the kill switch blocks the first request; nothing is billed", async () => {
    // Get the hash exactly as an operator would: from a dry run with the same prices and budget.
    const dry: string[] = [];
    await main(["node", "x"], OK_ENV, { log: (l) => dry.push(l), clock });
    const hash = /plan hash for --confirm-plan[^:]*: ([0-9a-f]{16})/.exec(dry.join("\n"))?.[1];
    assert.ok(hash, dry.join("\n"));
    const dir = mkdtempSync(join(tmpdir(), "speech-live-"));
    try {
      const lines: string[] = [];
      const before = guard.blocked.length;
      const code = await main(
        ["node", "x", "--live", "--out", dir, "--confirm-plan", hash],
        OK_ENV,
        { log: (l) => lines.push(l), clock },
      );
      assert.equal(code, 1);
      const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
      assert.match(results.summary.stopReason, /refused locally/);
      assert.equal(results.summary.spend.inclGstInr, 0);
      assert.equal(results.summary.attempts.billed, 0);
      assert.deepEqual(
        guard.blocked.slice(before).map((b) => b.target),
        ["api.sarvam.ai"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI live: a plan whose estimate exceeds the budget is refused before any request", async () => {
    const env = { ...OK_ENV, SARVAM_SPEECH_BUDGET_INR: "5" };
    const dry: string[] = [];
    await main(["node", "x"], env, { log: (l) => dry.push(l), clock });
    const hash = /plan hash for --confirm-plan[^:]*: ([0-9a-f]{16})/.exec(dry.join("\n"))![1]!;
    const lines: string[] = [];
    const code = await main(
      ["node", "x", "--live", "--out", "/tmp/unused", "--confirm-plan", hash],
      env,
      { log: (l) => lines.push(l), clock },
    );
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /exceeds the ₹5 cap/);
  });
});

/* ------------------------------------------------------------------ network kill switch */

describe("network kill switch", () => {
  const expectBlocked = (fn: () => unknown) =>
    assert.throws(fn, (e: Error) => e instanceof NetworkDisabledError);

  test("fetch, WebSocket, http(s), net, tls, dns and http2 are all blocked before connecting", async () => {
    await assert.rejects(fetch("https://api.sarvam.ai/text-to-speech"), NetworkDisabledError);
    expectBlocked(() => new WebSocket("wss://api.sarvam.ai/speech-to-text/ws"));
    expectBlocked(() => https.request("https://api.sarvam.ai/"));
    expectBlocked(() => namedHttpsRequest("https://api.sarvam.ai/")); // named ESM import, bound at load
    expectBlocked(() => http.get({ host: "example.com", path: "/" }));
    expectBlocked(() => net.connect(443, "api.sarvam.ai"));
    expectBlocked(() => tls.connect({ host: "api.sarvam.ai", port: 443 }));
    expectBlocked(() => dns.lookup("api.sarvam.ai", () => {}));
    const { connect } = await import("node:http2");
    expectBlocked(() => connect("https://api.sarvam.ai"));
    assert.ok(guard.blocked.some((b) => b.api === "WebSocket" && b.target === "api.sarvam.ai"));
  });

  test("loopback can be allowed for local fakes; everything else stays blocked", async () => {
    guard.restore();
    guard = disableNetwork({ allowLoopback: true });
    const srv = http.createServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const { port } = srv.address() as net.AddressInfo;
      assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
      await assert.rejects(fetch("https://api.sarvam.ai/"), NetworkDisabledError);
    } finally {
      srv.close();
      guard.restore();
      guard = disableNetwork();
    }
  });

  test("restore() puts the real functions back", () => {
    const g = guard;
    g.restore();
    assert.equal(typeof https.request, "function");
    assert.doesNotThrow(() => new URL("https://api.sarvam.ai")); // sanity
    guard = disableNetwork();
  });
});

/* ------------------------------------------------------------------ auth */

describe("authentication safeguards (live transport, exercised offline)", () => {
  test("credential headers per mode: none when the proxy injects, exactly one key otherwise", () => {
    assert.deepEqual(authHeaders({ mode: "proxy-injected" }), {});
    assert.deepEqual(authHeaders({ mode: "api-key", apiKey: "sk_live_canary_1" }), {
      "api-subscription-key": "sk_live_canary_1",
    });
  });

  test("proxy mode: a request carrying any credential header is refused by the guard (never reaches the kill switch)", async () => {
    const t = liveTransport({ mode: "proxy-injected" });
    const before = guard.blocked.length;
    for (const h of ["api-subscription-key", "authorization", "api-key"])
      await assert.rejects(
        t.fetch("https://api.sarvam.ai/text-to-speech", {
          method: "POST",
          headers: { [h]: "x" },
          body: "{}",
        }),
        (e: Error) => e.name === "SarvamAuthGuardError",
        h,
      );
    assert.equal(guard.blocked.length, before, "refused before any network attempt");
  });

  test("only https://api.sarvam.ai and wss://api.sarvam.ai are reachable through the live transport", async () => {
    const t = liveTransport({ mode: "proxy-injected" });
    await assert.rejects(
      t.fetch("https://evil.example/text-to-speech"),
      /only calls https:\/\/api\.sarvam\.ai/,
    );
    await assert.rejects(
      t.fetch("http://api.sarvam.ai/text-to-speech"),
      /only calls https:\/\/api\.sarvam\.ai/,
    );
    assert.throws(() => t.openSocket("ws://api.sarvam.ai/speech-to-text/ws", {}), /wss/);
    assert.throws(
      () => t.openSocket("wss://evil.example/speech-to-text/ws", {}),
      /api\.sarvam\.ai/,
    );
    assert.throws(
      () => t.openSocket("wss://api.sarvam.ai/speech-to-text/ws", { "api-subscription-key": "x" }),
      /proxy-injected/,
    );
  });

  test("api-key mode: the key must be sent exactly once, with no other credential header", async () => {
    const t = liveTransport({ mode: "api-key", apiKey: "sk_live_canary_2" });
    await assert.rejects(
      t.fetch("https://api.sarvam.ai/speech-to-text", { method: "POST", body: "x" }),
      /must be sent exactly once/,
    );
    await assert.rejects(
      t.fetch("https://api.sarvam.ai/speech-to-text", {
        method: "POST",
        headers: { "api-subscription-key": "sk_live_canary_2", authorization: "Bearer x" },
        body: "x",
      }),
      /must not be sent alongside/,
    );
    // A correct request passes the guard and is then stopped by the kill switch: offline.
    await assert.rejects(
      t.fetch("https://api.sarvam.ai/speech-to-text", {
        method: "POST",
        headers: { "api-subscription-key": "sk_live_canary_2" },
        body: "x",
      }),
      NetworkDisabledError,
    );
  });
});

/* ------------------------------------------------------------------ secrets */

describe("secrets never reach logs, results or reports", () => {
  test("a key echoed back in error bodies is redacted everywhere; the fake records header names only", async () => {
    const KEY = "sk_live_canary_3f9Q";
    const fake = new FakeSarvam({
      faults: [
        fault(
          () => true,
          { status: 400, body: { error: { code: "bad", message: `bad key ${KEY} rejected` } } },
          2,
        ),
      ],
    });
    const logs: string[] = [];
    const redact = redactor([KEY]);
    const l = ledger();
    const out = await runPlan(
      pick(TTS_EN, TTS_HI),
      opts(fake, l, {
        headers: { "api-subscription-key": KEY },
        redact,
        log: (x) => logs.push(redact(x)),
      }),
    );
    const results = buildResults(2, out, l, { mode: "test" });
    const everything = [
      JSON.stringify(results),
      markdownReport(results),
      logs.join("\n"),
      JSON.stringify(fake.calls),
    ].join("\n");
    assert.ok(!everything.includes(KEY), "the key never appears");
    assert.match(JSON.stringify(results), /\[REDACTED\]/);
    assert.deepEqual(fake.calls[0]!.headerNames, ["api-subscription-key", "content-type"]);
  });

  test("results never contain request headers", async () => {
    const fake = new FakeSarvam();
    const l = ledger();
    const out = await runPlan(
      pick(TTS_EN, STT_EN),
      opts(fake, l, { headers: { "api-subscription-key": "sk_live_canary_4" } }),
    );
    const json = JSON.stringify(buildResults(2, out, l, { mode: "test" }));
    assert.ok(!/api-subscription-key|sk_live_canary_4|authorization/i.test(json));
  });
});

/* ------------------------------------------------------------------ preflight hardening */

describe("preflight hardening (2026-11-03)", () => {
  test("the live transport never follows redirects (redirect: 'error') and only takes URLs", async () => {
    const seen: Array<RequestInit | undefined> = [];
    guard.restore();
    const real = globalThis.fetch;
    // A recording stub stands in for the network; nothing is sent anywhere.
    globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
      seen.push(init);
      return new Response("{}");
    }) as typeof fetch;
    try {
      const t = liveTransport({ mode: "proxy-injected" });
      await t.fetch("https://api.sarvam.ai/text-to-speech", { method: "POST", body: "{}" });
      await t.fetch("https://api.sarvam.ai/text-to-speech", {
        method: "POST",
        body: "{}",
        redirect: "follow",
      });
      assert.deepEqual(
        seen.map((i) => i?.redirect),
        ["error", "error"],
        "a caller cannot re-enable redirects",
      );
      await assert.rejects(
        t.fetch(new Request("https://api.sarvam.ai/text-to-speech")),
        /URLs, not Request objects/,
      );
    } finally {
      globalThis.fetch = real;
      guard = disableNetwork();
    }
  });

  test("Node rejects a 3xx under redirect: 'error' (loopback server; nothing leaves the machine)", async () => {
    guard.restore();
    guard = disableNetwork({ allowLoopback: true });
    const srv = http.createServer((_q, r) => {
      r.writeHead(307, { location: "https://elsewhere.invalid/x" });
      r.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const { port } = srv.address() as net.AddressInfo;
      await assert.rejects(
        fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "x", redirect: "error" }),
      );
      assert.ok(
        !guard.blocked.some((b) => b.target === "elsewhere.invalid"),
        "the redirect target was never contacted",
      );
    } finally {
      srv.close();
      guard.restore();
      guard = disableNetwork();
    }
  });

  test("credential-shaped tokens are scrubbed from error text, even keys this process never held", () => {
    for (const leak of [
      "invalid api-subscription-key sk_notarealkey000",
      "key=Zq9x8W7v6U5t4S3r2Q1p0Onmlk",
      "token: a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6",
      "Bearer eyJhbGciOiJIUzI1NiJ9.payload",
    ])
      assert.ok(
        !/[A-Za-z0-9]{12,}/.test(scrubTokens(leak).replace("api-subscription-key", "")),
        leak,
      );
    for (const keep of [
      "HTTP 422: speaker not valid for bulbul:v3",
      "मेरा नंबर 1234567890 है",
      "నా నంబర్ 12345 67890",
      "rate_limit_exceeded_error",
    ])
      assert.equal(scrubTokens(keep), keep);
  });

  test("the plan hash binds the harness code: a different code digest gives a different hash", () => {
    const plan = buildPlan();
    const limits = defaultLimits(40, plan);
    const digest = harnessDigest();
    assert.match(digest, /^[0-9a-f]{16}$/);
    assert.equal(harnessDigest(), digest, "stable for unchanged code");
    assert.notEqual(
      planHash(plan, P, limits, { authMode: "proxy-injected", code: digest }),
      planHash(plan, P, limits, { authMode: "proxy-injected", code: "0".repeat(16) }),
    );
  });
});
