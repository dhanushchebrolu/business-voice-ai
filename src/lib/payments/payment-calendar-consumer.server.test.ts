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
  const client = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(next(table, "select.maybeSingle")),
        update(payload: unknown) {
          return {
            eq: (col: string, val: unknown) =>
              Promise.resolve(next(table, "update", payload, { [col]: val })),
          };
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
      { table: "bookings", op: "update", result: { error: null } },
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
      { table: "bookings", op: "update", result: { error: null } },
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
});
