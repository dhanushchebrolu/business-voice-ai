import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { fetchWithTiming } from "./supabase-fetch-timing.ts";

/**
 * Whole-app loading/performance audit, observability requirement: every
 * Supabase fetch (client.ts, client.server.ts, auth-middleware.ts) now goes
 * through this one function. Real unit tests against a stubbed global
 * `fetch` — the actual logic (what gets logged, when, and that the query
 * string is never exposed) is plain and worth executing for real rather
 * than source-scanning.
 */

let originalFetch: typeof fetch;
let originalConsoleError: typeof console.error;
let originalConsoleWarn: typeof console.warn;
let errorCalls: unknown[][];
let warnCalls: unknown[][];

beforeEach(() => {
  originalFetch = global.fetch;
  originalConsoleError = console.error;
  originalConsoleWarn = console.warn;
  errorCalls = [];
  warnCalls = [];
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
});

afterEach(() => {
  global.fetch = originalFetch;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  mock.restoreAll();
});

describe("fetchWithTiming", () => {
  test("a successful, fast response logs nothing — no noisy per-request logging", async () => {
    global.fetch = mock.fn(async () => new Response("ok", { status: 200 }));
    const res = await fetchWithTiming("test_label", "https://x.supabase.co/rest/v1/bookings", {});
    assert.equal(res.status, 200);
    assert.equal(errorCalls.length, 0);
    assert.equal(warnCalls.length, 0);
  });

  test("a non-ok response logs an error with the path, status, and duration — never the query string", async () => {
    global.fetch = mock.fn(async () => new Response("denied", { status: 403 }));
    await fetchWithTiming(
      "test_label",
      "https://x.supabase.co/rest/v1/contacts?phone=eq.%2B911234567890",
      {},
    );
    assert.equal(errorCalls.length, 1);
    const [label, payload] = errorCalls[0] as [string, Record<string, unknown>];
    assert.equal(label, "test_label:error");
    assert.equal(payload["operation"], "/rest/v1/contacts");
    assert.equal(payload["status"], 403);
    assert.ok(typeof payload["durationMs"] === "number");
    assert.ok(typeof payload["correlationId"] === "string");
    // The phone number in the query string must never reach a log line.
    assert.doesNotMatch(JSON.stringify(errorCalls), /911234567890/);
  });

  test("a rejected fetch (network error) logs network_error and rethrows", async () => {
    global.fetch = mock.fn(async () => {
      throw new Error("fetch failed");
    });
    await assert.rejects(
      () => fetchWithTiming("test_label", "https://x.supabase.co/rest/v1/bookings", {}),
      /fetch failed/,
    );
    assert.equal(errorCalls.length, 1);
    assert.equal((errorCalls[0] as [string])[0], "test_label:network_error");
  });

  test("an AbortError (the shared request timeout firing) logs timeout, not network_error", async () => {
    global.fetch = mock.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    await assert.rejects(() =>
      fetchWithTiming("test_label", "https://x.supabase.co/rest/v1/bookings", {}),
    );
    assert.equal(errorCalls.length, 1);
    assert.equal((errorCalls[0] as [string])[0], "test_label:timeout");
  });

  test("an unparseable input URL never throws — falls back to a safe 'unknown' operation label", async () => {
    global.fetch = mock.fn(async () => new Response("denied", { status: 500 }));
    await fetchWithTiming("test_label", "not a url", {});
    const [, payload] = errorCalls[0] as [string, Record<string, unknown>];
    assert.equal(payload["operation"], "unknown");
  });
});
