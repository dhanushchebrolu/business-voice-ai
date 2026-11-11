import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PermanentJobError, type EnqueueInput, type Job, type QueueStore } from "./queue.server.ts";
import { runDueJobs } from "./runner.server.ts";
import { periodicJobs, runScheduledTick } from "./scheduler.server.ts";
import { buildJobHandlers } from "./handlers.server.ts";

/** In-memory queue with the SQL functions' semantics (idempotency, fencing, dead-letter). */
class FakeStore implements QueueStore {
  jobs = new Map<string, Job & { done?: string }>();
  failures: { id: string; retryable: boolean }[] = [];
  completeReturns = true;
  private seq = 0;
  async enqueue(input: EnqueueInput) {
    for (const j of this.jobs.values())
      if (j.idempotency_key === input.idempotencyKey) return { id: j.id, created: false };
    const id = `job-${++this.seq}`;
    this.jobs.set(id, {
      id,
      kind: input.kind,
      payload: (input.payload ?? {}) as never,
      idempotency_key: input.idempotencyKey,
      organization_id: input.organizationId ?? null,
      status: "queued",
      attempts: 0,
      max_attempts: input.maxAttempts ?? 5,
    } as unknown as Job);
    return { id, created: true };
  }
  async claim(worker: string, limit: number) {
    const due = [...this.jobs.values()].filter((j) => j.status === "queued").slice(0, limit);
    for (const j of due)
      Object.assign(j, { status: "running", locked_by: worker, attempts: j.attempts + 1 });
    return due.map((j) => ({ ...j }));
  }
  async complete(id: string, worker: string) {
    const j = this.jobs.get(id)!;
    if (!this.completeReturns || j.locked_by !== worker) return false;
    j.status = "succeeded";
    return true;
  }
  async fail(id: string, worker: string, _error: string, retryable: boolean) {
    const j = this.jobs.get(id)!;
    this.failures.push({ id, retryable });
    if (j.locked_by !== worker) return "not_owner";
    j.status = retryable && j.attempts < j.max_attempts ? "parked" : "dead"; // parked: not re-claimed in this run
    return j.status === "dead" ? "dead" : "queued";
  }
}

describe("runDueJobs", () => {
  test("completes, retries, dead-letters permanent errors and unknown kinds", async () => {
    const store = new FakeStore();
    await store.enqueue({ kind: "ok", idempotencyKey: "a" });
    await store.enqueue({ kind: "flaky", idempotencyKey: "b" });
    await store.enqueue({ kind: "bad", idempotencyKey: "c" });
    await store.enqueue({ kind: "nobody.handles.this", idempotencyKey: "d" });
    const summary = await runDueJobs(store, {
      worker: "w1",
      budgetMs: 5_000,
      handlers: {
        ok: async () => ({ fine: true }),
        flaky: async () => {
          throw new Error("temporary");
        },
        bad: async () => {
          throw new PermanentJobError("invalid payload");
        },
      },
    });
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.retried, 1);
    assert.equal(summary.dead, 2);
    assert.deepEqual(
      store.failures.map((f) => f.retryable),
      [true, false, false],
    );
  });

  test("a job that outlives its timeout fails and is retried, not left running", async () => {
    const store = new FakeStore();
    await store.enqueue({ kind: "slow", idempotencyKey: "s" });
    const summary = await runDueJobs(store, {
      worker: "w1",
      budgetMs: 5_000,
      jobTimeoutMs: 20,
      handlers: { slow: () => new Promise((r) => setTimeout(r, 500)) },
    });
    assert.equal(summary.retried, 1);
    assert.equal(store.jobs.get("job-1")!.status, "parked");
  });

  test("a lost lease is reported, never counted as success", async () => {
    const store = new FakeStore();
    store.completeReturns = false;
    await store.enqueue({ kind: "ok", idempotencyKey: "x" });
    const summary = await runDueJobs(store, {
      worker: "w1",
      budgetMs: 5_000,
      handlers: { ok: async () => {} },
    });
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.lostLease, 1);
  });

  test("stops claiming once the time budget is spent", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 30; i++) await store.enqueue({ kind: "ok", idempotencyKey: `k${i}` });
    let t = 0;
    const summary = await runDueJobs(store, {
      worker: "w1",
      budgetMs: 100,
      batchSize: 10,
      now: () => (t += 60),
      handlers: { ok: async () => {} },
    });
    assert.equal(summary.claimed, 10);
  });
});

describe("scheduled tick", () => {
  test("periodic job keys are stable within their bucket, so overlapping ticks enqueue once", () => {
    const a = periodicJobs(new Date("2026-11-11T10:02:05Z"));
    const b = periodicJobs(new Date("2026-11-11T10:04:59Z"));
    const c = periodicJobs(new Date("2026-11-11T10:05:00Z"));
    const key = (jobs: typeof a, kind: string) => jobs.find((j) => j.kind === kind)!.idempotencyKey;
    assert.equal(key(a, "sweep.sarvam_reconcile"), key(b, "sweep.sarvam_reconcile"));
    assert.notEqual(key(b, "sweep.sarvam_reconcile"), key(c, "sweep.sarvam_reconcile"));
    assert.notEqual(key(a, "sweep.call_finalization"), key(b, "sweep.call_finalization"));
    assert.equal(key(a, "jobs.prune"), "jobs.prune:2026-11-11");
    assert.ok(
      !a.some((j) => /campaign|payment/.test(j.kind)),
      "no campaign or payment work is scheduled",
    );
  });

  test("a tick enqueues sweeps once, runs them and raises an alert for dead letters", async () => {
    const store = new FakeStore();
    const statsRows = [{ kind: "x", status: "dead", jobs: 1, oldest_due_seconds: null }];
    const supabaseAdmin = { rpc: async () => ({ data: statsRows, error: null }) } as never;
    const ran: string[] = [];
    const handlers = Object.fromEntries(
      ["sweep.call_finalization", "sweep.sarvam_reconcile", "jobs.prune"].map((k) => [
        k,
        async () => {
          ran.push(k);
        },
      ]),
    );
    const now = new Date("2026-11-11T10:00:30Z");
    const first = await runScheduledTick({ supabaseAdmin, store, handlers, now });
    const second = await runScheduledTick({ supabaseAdmin, store, handlers, now });
    assert.equal(first.enqueued.length, 3);
    assert.equal(second.enqueued.length, 0, "same bucket: nothing new");
    assert.deepEqual(ran.sort(), [
      "jobs.prune",
      "sweep.call_finalization",
      "sweep.sarvam_reconcile",
    ]);
    assert.equal(first.health.alert, true);
  });
});

describe("handlers", () => {
  test("only the expected kinds exist: no campaign dispatch or payment expiry", () => {
    const handlers = buildJobHandlers({ supabaseAdmin: {} as never, store: new FakeStore() });
    assert.deepEqual(Object.keys(handlers).sort(), [
      "call.finalize",
      "jobs.prune",
      "sarvam.reconcile_call",
      "sweep.call_finalization",
      "sweep.sarvam_reconcile",
    ]);
  });

  test("a reconcile or finalize job without a call id is a permanent error", async () => {
    const handlers = buildJobHandlers({ supabaseAdmin: {} as never, store: new FakeStore() });
    for (const kind of ["sarvam.reconcile_call", "call.finalize"])
      await assert.rejects(handlers[kind]!({ payload: {} } as Job), PermanentJobError);
  });

  test("the reconcile sweep enqueues each unresolved call at most once per hour", async () => {
    const store = new FakeStore();
    const rows = [
      { id: "c1", organization_id: "o1" },
      { id: "c2", organization_id: "o2" },
    ];
    const query = {
      select: () => query,
      eq: () => query,
      in: () => query,
      not: () => query,
      lt: () => query,
      gt: () => query,
      order: () => query,
      limit: async () => ({ data: rows, error: null }),
    };
    const handlers = buildJobHandlers({
      supabaseAdmin: { from: () => query } as never,
      store,
      now: () => new Date("2026-11-11T10:20:00Z"),
    });
    const first = await handlers["sweep.sarvam_reconcile"]!({} as Job);
    const again = await handlers["sweep.sarvam_reconcile"]!({} as Job);
    assert.deepEqual(first, { candidates: 2, enqueued: 2 });
    assert.deepEqual(again, { candidates: 2, enqueued: 0 });
    const job = [...store.jobs.values()].find((j) => j.idempotency_key.includes("c1"))!;
    assert.equal(job.idempotency_key, "sarvam.reconcile_call:c1:2026-11-11T10");
    assert.equal(job.organization_id, "o1");
  });
});
