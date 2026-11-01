import assert from "node:assert/strict";
import { describe, test } from "node:test";
// klyro's own verifier (the Worker side), to prove the two sides agree byte for byte.
import { verifySignedRequest } from "../../../src/lib/voice-agent/internal-auth.ts";
import { KlyroBookingBackend } from "../src/backend/klyro-backend.ts";
import { KlyroClient, KlyroError, signKlyroRequest } from "../src/backend/klyro-client.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

function fakeFetch(responses: Array<{ status: number; body?: unknown } | "hang" | "network">) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r === "network") throw new TypeError("fetch failed");
    if (r === "hang") {
      return new Promise((_, reject) =>
        init.signal!.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    }
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("klyro client signing", () => {
  test("klyro's verifier accepts the agent's signature; tampering is rejected", async () => {
    const body = JSON.stringify({ callId: "c", tool: "book_appointment", input: {} });
    const h = await signKlyroRequest({
      secret: SECRET,
      keyId: "current",
      method: "POST",
      path: "/api/internal/voice-agent/tool",
      body,
      nowSeconds: 1_800_000_000,
      nonce: "abcdefabcdefabcdef12",
    });
    const verify = (b: string, path = "/api/internal/voice-agent/tool") =>
      verifySignedRequest({
        secrets: { current: SECRET },
        method: "POST",
        path,
        body: b,
        header: (n) => h[n] ?? null,
        nowSeconds: 1_800_000_010,
        claimNonce: async () => true,
      });
    assert.equal((await verify(body)).ok, true);
    assert.deepEqual(await verify(body.replace("book_appointment", "reschedule_appointment")), {
      ok: false,
      reason: "bad_signature",
    });
    assert.deepEqual(await verify(body, "/api/internal/voice-agent/session"), {
      ok: false,
      reason: "bad_signature",
    });
  });
});

describe("klyro client reliability", () => {
  test("retries 503/429/network with a fresh nonce, then succeeds", async () => {
    const f = fakeFetch([
      { status: 503 },
      "network",
      { status: 429 },
      { status: 200, body: { ok: 1 } },
    ]);
    const c = new KlyroClient({
      baseUrl: "https://k",
      secret: SECRET,
      retries: 3,
      fetchImpl: f.impl,
    });
    assert.deepEqual(await c.post("/p", {}, { idempotent: true }), { ok: 1 });
    assert.equal(f.seen.length, 4);
    assert.equal(
      new Set(f.seen.map((s) => s.headers["x-clickai-nonce"])).size,
      4,
      "every attempt is a new nonce",
    );
  });
  test("4xx is never retried; non-idempotent calls are never retried", async () => {
    const f = fakeFetch([{ status: 403, body: { error: "tool_not_allowed" } }]);
    const c = new KlyroClient({ baseUrl: "https://k", secret: SECRET, fetchImpl: f.impl });
    await assert.rejects(
      c.post("/p", {}, { idempotent: true }),
      (e) => e instanceof KlyroError && e.code === "tool_not_allowed" && !e.retryable,
    );
    assert.equal(f.seen.length, 1);
    const g = fakeFetch([{ status: 503 }, { status: 200 }]);
    const d = new KlyroClient({ baseUrl: "https://k", secret: SECRET, fetchImpl: g.impl });
    await assert.rejects(d.post("/p", {}, { idempotent: false }));
    assert.equal(g.seen.length, 1);
  });
  test("a hanging backend times out (deadline), reported as retryable timeout", async () => {
    const f = fakeFetch(["hang"]);
    const c = new KlyroClient({
      baseUrl: "https://k",
      secret: SECRET,
      timeoutMs: 50,
      retries: 0,
      fetchImpl: f.impl,
    });
    const t0 = Date.now();
    await assert.rejects(
      c.post("/p", {}, { idempotent: true }),
      (e) => e instanceof KlyroError && e.code === "timeout",
    );
    assert.ok(Date.now() - t0 < 1000);
  });
});

describe("KlyroBookingBackend maps klyro's real tool results", () => {
  const backend = (
    responses: Parameters<typeof fakeFetch>[0],
    tools = ["check_calendar_availability", "book_appointment"],
  ) => {
    const f = fakeFetch(responses);
    return {
      b: new KlyroBookingBackend(
        new KlyroClient({ baseUrl: "https://k", secret: SECRET, retries: 0, fetchImpl: f.impl }),
        "call-1",
        "Asia/Kolkata",
        tools,
      ),
      f,
    };
  };
  const tool = (content: unknown) => ({
    status: 200,
    body: { ok: true, content: JSON.stringify(content), isError: false },
  });
  test("availability: slots filtered to 'after 2 PM' in the business time zone", async () => {
    const { b, f } = backend([
      tool({
        success: true,
        data: {
          slots: [
            { start: "2026-11-03T07:30:00Z", end: "2026-11-03T08:00:00Z" },
            { start: "2026-11-03T09:30:00Z", end: "2026-11-03T10:00:00Z" },
          ],
        },
      }),
    ]);
    const r = await b.checkAvailability({
      serviceId: "s",
      date: "2026-11-03",
      durationMinutes: 30,
      notBefore: "14:00",
    });
    assert.deepEqual(r, {
      ok: true,
      slots: [{ startIso: "2026-11-03T09:30:00Z", endIso: "2026-11-03T10:00:00Z" }],
    }); // 15:00 IST kept, 13:00 IST dropped
    assert.deepEqual(JSON.parse(f.seen[0]!.body).input, {
      dateIso: "2026-11-03",
      durationMinutes: 30,
    });
  });
  test("booking outcomes: confirmed, saved_calendar_sync_failed, slot taken, backend down", async () => {
    const slot = { startIso: "2026-11-03T10:30:00Z", endIso: "2026-11-03T11:00:00Z" };
    const req = {
      serviceId: "s",
      serviceName: "Cleaning",
      slot,
      customerName: "Ravi",
      customerPhone: "9876543210",
    };
    assert.deepEqual(
      await backend([
        tool({ success: true, bookingOutcome: "confirmed", data: { id: "b1" } }),
      ]).b.book(req),
      { ok: true, bookingId: "b1", outcome: "confirmed", slot },
    );
    assert.equal(
      (
        (await backend([
          tool({ success: true, bookingOutcome: "saved_calendar_sync_failed", data: { id: "b2" } }),
        ]).b.book(req)) as { outcome: string }
      ).outcome,
      "saved_calendar_sync_failed",
    );
    assert.equal(
      (
        (await backend([
          tool({ success: false, error: { code: "SLOT_NO_LONGER_AVAILABLE" } }),
        ]).b.book(req)) as { error: string }
      ).error,
      "slot_taken",
    );
    const down = (await backend([{ status: 503 }]).b.book(req)) as {
      error: string;
      retryable: boolean;
    };
    assert.deepEqual([down.error, down.retryable], ["backend_unavailable", true]);
  });
  test("a tool the business has not enabled is not even requested", async () => {
    const { b, f } = backend([], []);
    assert.equal(
      (await b.checkAvailability({ serviceId: null, date: "2026-11-03", durationMinutes: 30 })).ok,
      false,
    );
    assert.equal(f.seen.length, 0);
  });
});
