import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { AgentServer, ServerOptions, initializeLogger } from "@livekit/agents";
import {
  activeJobsOf,
  captureAgentServer,
  createShutdownWatchdog,
  installShutdownWatchdog,
  type ShutdownWatchdogOptions,
} from "../src/runtime/shutdown.ts";

initializeLogger({ pretty: false, level: "error" });

type Count = number | null | "throw";
function harness(counts: Count[], o: { idleGraceMs?: number; hardCapMs?: number } = {}) {
  const t = { ms: 0 };
  const exits: number[] = [];
  const log: string[] = [];
  let i = 0;
  const w = createShutdownWatchdog({
    activeJobs: () => {
      const c = counts[Math.min(i++, counts.length - 1)]!;
      if (c === "throw") throw new Error("count unavailable");
      return c;
    },
    exit: (c) => void exits.push(c),
    idleGraceMs: o.idleGraceMs ?? 5_000,
    hardCapMs: o.hardCapMs ?? 930_000,
    now: () => t.ms,
    log: (e, d) =>
      void log.push(`${e}:${String(d["reason"] ?? d["signal"] ?? d["treated_as"] ?? "")}`),
  });
  const poll = async (n: number, stepMs = 1000) => {
    for (let k = 0; k < n; k++) {
      t.ms += stepMs;
      if (await w.tick()) break;
    }
  };
  return { w, t, exits, log, poll };
}

describe("F1: shutdown watchdog never ends active calls early", () => {
  test("does nothing until a signal arrives", async () => {
    const h = harness([0]);
    await h.poll(30);
    assert.deepEqual(h.exits, []);
  });
  test("worker not started yet (no runtime): exits after the grace period", async () => {
    const h = harness([null]);
    h.w.trigger("SIGTERM");
    await h.poll(4);
    assert.deepEqual(h.exits, [], "framework gets its grace period first");
    await h.poll(3);
    assert.deepEqual(h.exits, [143]);
    assert.ok(h.log.includes("shutdown.watchdog_exit:idle"));
  });
  test("active calls: waits; exits only after they end", async () => {
    const h = harness([2, 2, 1, 1, 1, 0, 0]);
    h.w.trigger("SIGTERM");
    await h.poll(5);
    assert.deepEqual(h.exits, []);
    await h.poll(10);
    assert.deepEqual(h.exits, [143]);
  });
  test("count unavailable AFTER it was known (null) is treated as active: no exit until the hard cap", async () => {
    const h = harness([1, null], { hardCapMs: 120_000 });
    h.w.trigger("SIGTERM");
    await h.poll(119);
    assert.deepEqual(h.exits, [], "an unknown count never counts as idle");
    assert.ok(h.log.includes("shutdown.count_unavailable:active"));
    await h.poll(2);
    assert.deepEqual(h.exits, [143]);
    assert.ok(h.log.includes("shutdown.watchdog_exit:hard_cap"));
  });
  test("count reader throwing (with calls active) never counts as idle", async () => {
    const h = harness([1, "throw"], { hardCapMs: 60_000 });
    h.w.trigger("SIGTERM");
    await h.poll(59);
    assert.deepEqual(h.exits, []);
  });
  test("a failure right after an idle reading resets the idle streak", async () => {
    const h = harness([0, "throw", 0, null, 0], { idleGraceMs: 0 });
    h.w.trigger("SIGTERM");
    await h.poll(4);
    assert.deepEqual(h.exits, [], "0, unknown, 0, unknown: never two idle polls in a row");
  });
  test("event-loop stalls (long gaps between polls) with a call active: no exit before the hard cap", async () => {
    const h = harness([1], { hardCapMs: 900_000 });
    h.w.trigger("SIGTERM");
    await h.poll(5, 120_000); // five 2-minute stalls = 10 min
    assert.deepEqual(h.exits, []);
    await h.poll(1, 400_000);
    assert.deepEqual(h.exits, [143], "bounded: the hard cap still applies");
  });
  test("signals are idempotent; exit happens once", async () => {
    const h = harness([0]);
    h.w.trigger("SIGTERM");
    h.w.trigger("SIGINT");
    await h.poll(20);
    assert.deepEqual(h.exits, [143]);
  });
  test("installShutdownWatchdog never overlaps polls when a count read is slow", async () => {
    const proc = new EventEmitter();
    let inFlight = 0;
    let maxInFlight = 0;
    let reads = 0;
    const exits: number[] = [];
    const opts: ShutdownWatchdogOptions = {
      activeJobs: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        reads++;
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return 1;
      },
      exit: (c) => void exits.push(c),
      idleGraceMs: 0,
      hardCapMs: 10_000,
      pollMs: 5,
    };
    installShutdownWatchdog(opts, proc as never);
    proc.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(maxInFlight, 1);
    assert.ok(reads >= 2);
    assert.deepEqual(exits, []);
    // stop the interval: make the next tick exit via the hard cap
    opts.hardCapMs = 0;
    await new Promise((r) => setTimeout(r, 100));
  });
});

describe("F1: in-process active-job count from the real AgentServer", () => {
  test("captureAgentServer: null before run(), the instance from run() onwards; run() itself unchanged", async () => {
    class FakeServer {
      activeJobs: unknown[] = [];
      calls: unknown[][] = [];
      async run(...a: unknown[]) {
        this.calls.push(a);
        return "ran";
      }
    }
    const get = captureAgentServer(FakeServer as never);
    const get2 = captureAgentServer(FakeServer as never); // idempotent: one wrapper
    assert.equal(activeJobsOf(get), null);
    const s = new FakeServer();
    assert.equal(await s.run(1, 2), "ran");
    assert.deepEqual(s.calls, [[1, 2]]);
    assert.equal(get(), s);
    assert.equal(get2(), s);
    s.activeJobs.push({}, {});
    assert.equal(activeJobsOf(get), 2);
  });
  test("contract with the installed @livekit/agents: AgentServer.run exists, activeJobs is a live getter, cli uses the same class", () => {
    assert.equal(typeof AgentServer.prototype.run, "function");
    const desc = Object.getOwnPropertyDescriptor(AgentServer.prototype, "activeJobs");
    assert.equal(typeof desc?.get, "function");
    const real = new AgentServer(
      new ServerOptions({
        agent: "/nonexistent.js",
        wsURL: "ws://127.0.0.1:9",
        apiKey: "k",
        apiSecret: "s",
        port: 0,
      }),
    );
    assert.deepEqual(real.activeJobs, [], "the real getter is synchronous and needs no I/O");
    const dist = dirname(createRequire(import.meta.url).resolve("@livekit/agents"));
    const cli = readFileSync(join(dist, "cli.js"), "utf8");
    const index = readFileSync(join(dist, "index.js"), "utf8");
    assert.match(cli, /import \{ AgentServer, ServerOptions \} from "\.\/worker\.js"/);
    assert.match(cli, /new AgentServer\(serverOptions\)/);
    assert.match(cli, /await server\.run\(\)/);
    assert.match(index, /export \* from "\.\/worker\.js"/);
  });
  test("the worker reads the count in-process (no HTTP self-probe)", () => {
    const src = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    assert.match(src, /captureAgentServer\(AgentServer\)/);
    assert.match(src, /activeJobs: \(\) => activeJobsOf\(server\)/);
    assert.doesNotMatch(src, /activeJobsFromHealthServer|\/worker`/);
  });
});
