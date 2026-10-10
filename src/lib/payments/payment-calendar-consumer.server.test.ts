import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { handlePaymentCapturedForCalendar } from "./payment-calendar-consumer.server.ts";
import { encryptCredential } from "../google-calendar/google-calendar-crypto.server.ts";
import type { PaymentDomainEventRow } from "./payment-events.server.ts";

const CRYPTO_KEY = "GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY";
const CONFIG_VARS = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REDIRECT_URI",
] as const;
const originalValues: Record<string, string | undefined> = {};

beforeEach(() => {
  originalValues[CRYPTO_KEY] = process.env[CRYPTO_KEY];
  process.env[CRYPTO_KEY] = randomBytes(32).toString("base64");
  for (const key of CONFIG_VARS) {
    originalValues[key] = process.env[key];
    process.env[key] = `test-${key.toLowerCase()}`;
  }
});

afterEach(() => {
  for (const key of [CRYPTO_KEY, ...CONFIG_VARS]) {
    if (originalValues[key] === undefined) delete process.env[key];
    else process.env[key] = originalValues[key];
  }
});

function makeFakeSupabase(script: { table: string; op: string; result: unknown }[]) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  let i = 0;
  function next(table: string, op: string, ...args: unknown[]) {
    calls.push({ table, op, args });
    const entry = script[i];
    i++;
    if (!entry) throw new Error(`test bug: no scripted response for call ${i} (${table}.${op})`);
    return entry.result;
  }
  // The real supabase-js query builder is chainable AND itself awaitable
  // at any point (every step returns a thenable) — e.g. a confirm UPDATE
  // in this codebase is always written as
  // `.update(payload).eq("id", x).eq("status", y).select("id")` and then
  // destructured directly with `await`, with no further method call.
  // This fake mirrors that: `.eq()` accumulates conditions and returns
  // the same chain, `.select()` is a no-op marker (kept for realism, the
  // fake doesn't project columns), and `then()` is what actually resolves
  // the scripted response, so `await` works no matter where it's called.
  function makeUpdateChain(table: string, payload: unknown, eqs: Record<string, unknown>[]) {
    const chain = {
      eq(col: string, val: unknown) {
        return makeUpdateChain(table, payload, [...eqs, { [col]: val }]);
      },
      select(..._cols: unknown[]) {
        return makeUpdateChain(table, payload, eqs);
      },
      then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        return Promise.resolve(next(table, "update", payload, ...eqs)).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return chain;
  }
  const client = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(next(table, "select.maybeSingle")),
        update(payload: unknown) {
          return makeUpdateChain(table, payload, []);
        },
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}

function fakeFetchSequence(responses: { status: number; body: unknown }[]): typeof fetch {
  let i = 0;
  return (async () => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/**
 * A controllable fetchImpl for deterministically reproducing the
 * expiration/cancellation race: call 1 (OAuth token refresh) and call 3+
 * (the DELETE issued by cleanupOrphanedEvent, if any) resolve immediately;
 * call 2 (the createEvent POST) stays pending on `gate` until the test
 * explicitly calls `releaseCreateEvent()` — simulating "calendar event
 * creation is paused mid-flight" for exactly as long as the test needs to
 * let a concurrent expiration/cancellation land first.
 */
function fakeFetchForRace(opts: { deleteStatus?: number; deleteBody?: unknown } = {}) {
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  const callCount = { value: 0 };
  const fetchImpl = (async () => {
    callCount.value++;
    const call = callCount.value;
    if (call === 1) {
      return new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (call === 2) {
      await gate;
      return new Response(JSON.stringify({ id: "google-event-99", status: "confirmed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const status = opts.deleteStatus ?? 204;
    // A 204 is a "null body status" per the Fetch spec — the Response
    // constructor throws a TypeError if given a non-null body (even an
    // empty string) for one, so this must pass `null`, not "".
    return new Response(status === 204 ? null : JSON.stringify(opts.deleteBody ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, releaseCreateEvent: () => resolveGate(), callCount };
}

/** Polls (via microtask/macrotask ticks, no real delay) until `predicate()` is true, or fails the test if it never becomes true within a bounded number of ticks — used to deterministically know "the createEvent call has been issued and is now paused" without any real timer. */
async function waitUntil(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("test bug: waitUntil exceeded maxTicks without predicate becoming true");
}

/** Builds the fixed 4-step read sequence (booking, business, connection calendar_id, connection access-token row) + the token-refresh persistence write every successful getCalendarProviderForConnection() call makes, so each race test only has to add its own final `bookings update` + (optionally) delete-related entries. */
function raceSetupScript(encrypted: string, bookingStatus = "PENDING_PAYMENT") {
  return [
    {
      table: "bookings",
      op: "select.maybeSingle",
      result: {
        data: {
          id: "booking-1",
          status: bookingStatus,
          calendar_connection_id: "conn-1",
          start_at: "2026-09-25T10:30:00.000Z",
          end_at: "2026-09-25T11:00:00.000Z",
          timezone: "Asia/Kolkata",
          customer_name: "Priya",
          customer_phone: "+919876543210",
          business_id: "biz-1",
        },
        error: null,
      },
    },
    {
      table: "businesses",
      op: "select.maybeSingle",
      result: { data: { name: "ABC Clinic" }, error: null },
    },
    {
      table: "google_calendar_connections",
      op: "select.maybeSingle",
      result: { data: { calendar_id: "clinic-cal" }, error: null },
    },
    {
      table: "google_calendar_connections",
      op: "select.maybeSingle",
      result: {
        data: {
          id: "conn-1",
          status: "CONNECTED",
          calendar_id: "clinic-cal",
          encrypted_credentials: encrypted,
        },
        error: null,
      },
    },
    { table: "google_calendar_connections", op: "update", result: { error: null } },
  ];
}

const CAPTURED_EVENT: PaymentDomainEventRow = {
  id: "event-1",
  event_type: "PAYMENT_CAPTURED",
  organization_id: "org-1",
  business_id: "biz-1",
  payment_request_id: "pr-1",
  booking_id: "booking-1",
  payload: {},
};

describe("handlePaymentCapturedForCalendar", () => {
  test("creates the calendar event and confirms the booking when PENDING_PAYMENT", async () => {
    const encrypted = encryptCredential(JSON.stringify({ refreshToken: "stored-refresh" }));
    const { client, calls } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "booking-1",
            status: "PENDING_PAYMENT",
            calendar_connection_id: "conn-1",
            start_at: "2026-09-25T10:30:00.000Z",
            end_at: "2026-09-25T11:00:00.000Z",
            timezone: "Asia/Kolkata",
            customer_name: "Priya",
            customer_phone: "+919876543210",
            business_id: "biz-1",
          },
          error: null,
        },
      },
      {
        table: "businesses",
        op: "select.maybeSingle",
        result: { data: { name: "ABC Clinic" }, error: null },
      },
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: { data: { calendar_id: "clinic-cal" }, error: null },
      },
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            status: "CONNECTED",
            calendar_id: "clinic-cal",
            encrypted_credentials: encrypted,
          },
          error: null,
        },
      },
      { table: "google_calendar_connections", op: "update", result: { error: null } },
      { table: "bookings", op: "update", result: { data: [{ id: "booking-1" }], error: null } },
    ]);
    const fetchImpl = fakeFetchSequence([
      { status: 200, body: { access_token: "fresh-access", expires_in: 3600 } },
      { status: 200, body: { id: "google-event-99", status: "confirmed" } },
    ]);

    await handlePaymentCapturedForCalendar(client, CAPTURED_EVENT, fetchImpl);

    const bookingUpdateCall = calls.find((c) => c.table === "bookings" && c.op === "update");
    assert.ok(bookingUpdateCall);
    const payload = bookingUpdateCall!.args[0] as Record<string, unknown>;
    assert.equal(payload["status"], "CONFIRMED");
    assert.equal(payload["google_event_id"], "google-event-99");
    // The regression this task closes: the confirm UPDATE must itself be
    // conditional on the booking still being PENDING_PAYMENT, not just
    // `.eq("id", ...)`. Asserting on the real .eq() conditions the
    // implementation actually sent (not a scripted response) is what
    // would catch someone removing that clause — the fake harness replays
    // a fixed response regardless of the update's WHERE clause, so only
    // inspecting the call's own recorded arguments proves the guard is
    // really there.
    const eqConditions = bookingUpdateCall!.args.slice(1) as Record<string, unknown>[];
    assert.ok(
      eqConditions.some((c) => c["status"] === "PENDING_PAYMENT"),
      `expected the confirm UPDATE to include .eq("status", "PENDING_PAYMENT"), got conditions: ${JSON.stringify(eqConditions)}`,
    );
  });

  test("does nothing for PAYMENT_CAPTURED_AFTER_EXPIRY — never confirms an expired/cancelled booking", async () => {
    const { client, calls } = makeFakeSupabase([]);
    await handlePaymentCapturedForCalendar(client, {
      ...CAPTURED_EVENT,
      event_type: "PAYMENT_CAPTURED_AFTER_EXPIRY",
    });
    assert.equal(calls.length, 0);
  });

  test("is a no-op (never creates a second event) when the booking already moved past PENDING_PAYMENT — duplicate webhook guard", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "booking-1",
            status: "CONFIRMED",
            calendar_connection_id: "conn-1",
            start_at: "s",
            end_at: "e",
            timezone: "Asia/Kolkata",
            customer_name: "Priya",
            customer_phone: null,
            business_id: "biz-1",
          },
          error: null,
        },
      },
    ]);
    await handlePaymentCapturedForCalendar(client, CAPTURED_EVENT);
    assert.equal(calls.length, 1, "only the booking read should happen, no event creation");
  });

  test("marks CALENDAR_SYNC_FAILED (never silently loses the booking) when event creation fails", async () => {
    const encrypted = encryptCredential(JSON.stringify({ refreshToken: "stored-refresh" }));
    const { client, calls } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "booking-1",
            status: "PENDING_PAYMENT",
            calendar_connection_id: "conn-1",
            start_at: "2026-09-25T10:30:00.000Z",
            end_at: "2026-09-25T11:00:00.000Z",
            timezone: "Asia/Kolkata",
            customer_name: "Priya",
            customer_phone: null,
            business_id: "biz-1",
          },
          error: null,
        },
      },
      {
        table: "businesses",
        op: "select.maybeSingle",
        result: { data: { name: "ABC Clinic" }, error: null },
      },
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: { data: { calendar_id: "clinic-cal" }, error: null },
      },
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            status: "CONNECTED",
            calendar_id: "clinic-cal",
            encrypted_credentials: encrypted,
          },
          error: null,
        },
      },
      { table: "google_calendar_connections", op: "update", result: { error: null } },
      { table: "bookings", op: "update", result: { data: [{ id: "booking-1" }], error: null } },
    ]);
    const fetchImpl = fakeFetchSequence([
      { status: 200, body: { access_token: "fresh-access", expires_in: 3600 } },
      { status: 500, body: {} },
    ]);

    await assert.rejects(() => handlePaymentCapturedForCalendar(client, CAPTURED_EVENT, fetchImpl));

    const bookingUpdateCall = calls.find((c) => c.table === "bookings" && c.op === "update");
    assert.ok(bookingUpdateCall);
    const payload = bookingUpdateCall!.args[0] as Record<string, unknown>;
    assert.equal(payload["status"], "CALENDAR_SYNC_FAILED");
  });

  describe("the expiration/cancellation race (regression)", () => {
    test(
      "a concurrent expiration/cancellation that lands while the Google Calendar event is still being created: " +
        "the booking is never revived to CONFIRMED and the now-orphaned event is deleted, with no error",
      async () => {
        const encrypted = encryptCredential(JSON.stringify({ refreshToken: "stored-refresh" }));
        const { client, calls } = makeFakeSupabase([
          ...raceSetupScript(encrypted),
          // The confirm UPDATE's own `.eq("status", "PENDING_PAYMENT")`
          // guard matches zero rows — standing in for
          // expirePendingPayments() (or a concurrent cancel_booking_atomic
          // call) having already moved this exact booking off
          // PENDING_PAYMENT while the paused Google Calendar call below was
          // still in flight.
          { table: "bookings", op: "update", result: { data: [], error: null } },
        ]);
        const { fetchImpl, releaseCreateEvent, callCount } = fakeFetchForRace({
          deleteStatus: 204,
        });

        const resultPromise = handlePaymentCapturedForCalendar(client, CAPTURED_EVENT, fetchImpl);

        // Wait until createEvent's own POST request has actually been
        // issued (call 2) and is now paused on the gate — i.e. calendar
        // event creation is genuinely in flight — before "allowing" the
        // concurrent expiration/cancellation (already baked into the
        // scripted zero-row response above) to have taken effect.
        await waitUntil(() => callCount.value >= 2);
        releaseCreateEvent();

        await resultPromise; // must resolve cleanly — losing the race and cleaning up is success, not a thrown error

        const bookingUpdateCalls = calls.filter((c) => c.table === "bookings" && c.op === "update");
        assert.equal(
          bookingUpdateCalls.length,
          1,
          "exactly one bookings UPDATE must have been attempted (the guarded confirm), and it must have been rejected by its own status guard — never a second write reviving the booking",
        );
        const eqConditions = bookingUpdateCalls[0]!.args.slice(1) as Record<string, unknown>[];
        assert.ok(
          eqConditions.some((c) => c["status"] === "PENDING_PAYMENT"),
          `expected the confirm UPDATE to include .eq("status", "PENDING_PAYMENT") even on the losing attempt, got: ${JSON.stringify(eqConditions)}`,
        );
        // The only call beyond the token refresh + createEvent POST is the
        // cleanup DELETE — proving the now-orphaned event was removed, not
        // left dangling on the calendar.
        assert.equal(
          callCount.value,
          3,
          "expected exactly 3 fetch calls: OAuth refresh, createEvent POST, and the cleanup DELETE",
        );
      },
    );

    test(
      "a concurrent race combined with a cleanup failure: the error is surfaced for reconciliation, " +
        "never leaks provider secrets, and never revives the booking",
      async () => {
        const encrypted = encryptCredential(JSON.stringify({ refreshToken: "stored-refresh" }));
        const { client, calls } = makeFakeSupabase([
          ...raceSetupScript(encrypted),
          { table: "bookings", op: "update", result: { data: [], error: null } },
        ]);
        // 403 (CALENDAR_ACCESS_DENIED) is explicitly non-retryable, so the
        // cleanup DELETE fails on its first and only attempt — a real,
        // permanent orphan this time, not a transient blip.
        const { fetchImpl, releaseCreateEvent, callCount } = fakeFetchForRace({
          deleteStatus: 403,
          deleteBody: { error: { message: "The caller does not have permission" } },
        });

        const resultPromise = handlePaymentCapturedForCalendar(client, CAPTURED_EVENT, fetchImpl);
        await waitUntil(() => callCount.value >= 2);
        releaseCreateEvent();

        await assert.rejects(resultPromise, (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /lost the confirmation race/i);
          assert.match(err.message, /manual.*reconciliation/i);
          // No secret/credential material anywhere in the surfaced message —
          // only CalendarProviderError's own safe, provider-agnostic text
          // (never a raw Google error body/headers) ever reaches here.
          assert.doesNotMatch(err.message, /access[_-]?token/i);
          assert.doesNotMatch(err.message, /bearer/i);
          assert.doesNotMatch(err.message, /fresh-access/);
          assert.doesNotMatch(err.message, /refresh[_-]?token/i);
          assert.doesNotMatch(err.message, /stored-refresh/);
          return true;
        });

        const bookingUpdateCalls = calls.filter((c) => c.table === "bookings" && c.op === "update");
        assert.equal(
          bookingUpdateCalls.length,
          1,
          "the failed cleanup must never fall back to writing anything else onto the booking row",
        );
      },
    );

    test(
      "duplicate webhook delivery for a booking the race already moved to a terminal state " +
        "(PAYMENT_EXPIRED or CANCELLED) is a safe no-op — never re-attempts confirmation or event creation",
      async () => {
        for (const terminalStatus of ["PAYMENT_EXPIRED", "CANCELLED"]) {
          const { client, calls } = makeFakeSupabase([
            {
              table: "bookings",
              op: "select.maybeSingle",
              result: {
                data: {
                  id: "booking-1",
                  status: terminalStatus,
                  calendar_connection_id: "conn-1",
                  start_at: "2026-09-25T10:30:00.000Z",
                  end_at: "2026-09-25T11:00:00.000Z",
                  timezone: "Asia/Kolkata",
                  customer_name: "Priya",
                  customer_phone: null,
                  business_id: "biz-1",
                },
                error: null,
              },
            },
          ]);
          await handlePaymentCapturedForCalendar(client, CAPTURED_EVENT);
          assert.equal(
            calls.length,
            1,
            `only the booking read should happen for a redelivered event against an already-${terminalStatus} booking — no event creation, no further writes`,
          );
        }
      },
    );
  });
});
