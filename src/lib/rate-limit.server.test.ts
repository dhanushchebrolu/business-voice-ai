import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter, type RateLimitStore } from "./rate-limit.server.ts";

/** Deterministic in-memory store — no live Postgres needed to test the limiter logic. */
class FakeStore implements RateLimitStore {
  counts = new Map<string, number>();
  failNext = false;

  async increment(key: string, windowStart: number): Promise<number> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated store failure");
    }
    const bucketKey = `${key}:${windowStart}`;
    const next = (this.counts.get(bucketKey) ?? 0) + 1;
    this.counts.set(bucketKey, next);
    return next;
  }
}

test("allows requests under the limit", async () => {
  const store = new FakeStore();
  const checkRateLimit = createRateLimiter(store, 3, 60);

  for (let i = 0; i < 3; i++) {
    const decision = await checkRateLimit("client-a");
    assert.equal(decision.allowed, true, `request ${i + 1} should be allowed`);
    assert.equal(decision.retryAfterSeconds, 0);
  }
});

test("denies requests once the limit is exceeded and reports a retry delay", async () => {
  const store = new FakeStore();
  const checkRateLimit = createRateLimiter(store, 2, 60);

  assert.equal((await checkRateLimit("client-b")).allowed, true);
  assert.equal((await checkRateLimit("client-b")).allowed, true);
  const third = await checkRateLimit("client-b");
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterSeconds, 60);
});

test("tracks separate client identities independently", async () => {
  const store = new FakeStore();
  const checkRateLimit = createRateLimiter(store, 1, 60);

  const clientA1 = await checkRateLimit("client-A");
  const clientA2 = await checkRateLimit("client-A");
  const clientB1 = await checkRateLimit("client-B");

  assert.equal(clientA1.allowed, true, "client A's first request is allowed");
  assert.equal(clientA2.allowed, false, "client A's second request exceeds its own limit");
  assert.equal(clientB1.allowed, true, "client B is a distinct identity with its own budget");
});

test("fails closed if the underlying store errors, rather than silently allowing unlimited requests", async () => {
  const store = new FakeStore();
  store.failNext = true;
  const checkRateLimit = createRateLimiter(store, 100, 60);

  const decision = await checkRateLimit("client-c");
  assert.equal(decision.allowed, false);
  assert.ok(decision.retryAfterSeconds > 0);
});
