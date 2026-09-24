import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createPaymentRequestForBooking,
  PaymentRequestError,
} from "./payment-request-service.server.ts";
import { encryptCredential } from "../razorpay/razorpay-crypto.server.ts";

const CRYPTO_KEY = "RAZORPAY_CREDENTIAL_ENCRYPTION_KEY";
const CONFIG_VARS = [
  "RAZORPAY_CLIENT_ID",
  "RAZORPAY_CLIENT_SECRET",
  "RAZORPAY_REDIRECT_URI",
  "RAZORPAY_OAUTH_AUTHORIZE_URL",
  "RAZORPAY_OAUTH_TOKEN_URL",
  "RAZORPAY_OAUTH_SCOPE",
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

function makeValidCredentialsRow() {
  return {
    id: "conn-1",
    connection_status: "CONNECTED",
    encrypted_credentials: encryptCredential(
      JSON.stringify({ accessToken: "cached-access", refreshToken: "stored-refresh" }),
    ),
    token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

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
  function selectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      in(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      maybeSingle: () => Promise.resolve(next(table, "select.maybeSingle", filters)),
    };
    return chain;
  }
  const client = {
    from(table: string) {
      return {
        select: () => selectChain(table),
        insert: (payload: unknown) => ({
          select: () => ({
            single: () => Promise.resolve(next(table, "insert.select.single", payload)),
          }),
        }),
      };
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

const BOOKING_ROW = {
  id: "booking-1",
  organization_id: "org-1",
  business_id: "biz-1",
  status: "PENDING_PAYMENT",
  customer_name: "Priya Sharma",
  customer_phone: "+919876543210",
  start_at: "2026-10-01T10:00:00.000Z",
};

describe("createPaymentRequestForBooking", () => {
  test("creates a payment link and inserts a PENDING payment_requests row", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "bookings", op: "select.maybeSingle", result: { data: BOOKING_ROW, error: null } },
      { table: "payment_requests", op: "select.maybeSingle", result: { data: null, error: null } },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", connection_status: "CONNECTED" }, error: null },
      },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: makeValidCredentialsRow(), error: null },
      },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { razorpay_account_id: "acc_123" }, error: null },
      },
      {
        table: "payment_requests",
        op: "insert.select.single",
        result: {
          data: {
            id: "pr-1",
            booking_id: "booking-1",
            status: "PENDING",
            amount_minor_units: 50000,
            currency: "INR",
            payment_link_url: "https://rzp.io/i/abc",
          },
          error: null,
        },
      },
    ]);
    const fetchImpl = fakeFetchSequence([
      {
        status: 200,
        body: { id: "plink_abc", short_url: "https://rzp.io/i/abc", status: "created" },
      },
    ]);

    const result = await createPaymentRequestForBooking(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      bookingId: "booking-1",
      amountMinorUnits: 50000,
      fetchImpl,
    });

    assert.equal(result.id, "pr-1");
    assert.equal(result.status, "PENDING");
    assert.equal(result.paymentLinkUrl, "https://rzp.io/i/abc");
    const insertCall = calls.find((c) => c.op === "insert.select.single");
    assert.ok(insertCall);
    const insertedPayload = insertCall!.args[0] as Record<string, unknown>;
    assert.equal(insertedPayload["status"], "PENDING");
    assert.notEqual(insertedPayload["status"], "CAPTURED");
  });

  test("idempotent: an existing active payment_requests row for the booking is returned, provider is never called", async () => {
    const { client } = makeFakeSupabase([
      { table: "bookings", op: "select.maybeSingle", result: { data: BOOKING_ROW, error: null } },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "pr-existing",
            booking_id: "booking-1",
            status: "PENDING",
            amount_minor_units: 50000,
            currency: "INR",
            payment_link_url: "https://rzp.io/i/existing",
          },
          error: null,
        },
      },
    ]);
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      throw new Error("must not be called");
    }) as unknown as typeof fetch;

    const result = await createPaymentRequestForBooking(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      bookingId: "booking-1",
      amountMinorUnits: 50000,
      fetchImpl,
    });

    assert.equal(result.id, "pr-existing");
    assert.equal(fetchCalled, false, "no provider call for an already-active payment request");
  });

  test("rejects a booking that does not belong to the caller's organization/business", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: { data: { ...BOOKING_ROW, organization_id: "org-OTHER" }, error: null },
      },
    ]);
    await assert.rejects(
      () =>
        createPaymentRequestForBooking(client, {
          organizationId: "org-1",
          businessId: "biz-1",
          bookingId: "booking-1",
          amountMinorUnits: 50000,
        }),
      (err: unknown) => {
        assert.ok(err instanceof PaymentRequestError);
        assert.equal(err.code, "BOOKING_NOT_FOUND");
        return true;
      },
    );
  });

  test("rejects a booking that is not currently PENDING_PAYMENT", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: { data: { ...BOOKING_ROW, status: "CONFIRMED" }, error: null },
      },
    ]);
    await assert.rejects(
      () =>
        createPaymentRequestForBooking(client, {
          organizationId: "org-1",
          businessId: "biz-1",
          bookingId: "booking-1",
          amountMinorUnits: 50000,
        }),
      (err: unknown) => {
        assert.ok(err instanceof PaymentRequestError);
        assert.equal(err.code, "INVALID_BOOKING_STATE");
        return true;
      },
    );
  });

  test("rejects when the business has no connected Razorpay merchant account", async () => {
    const { client } = makeFakeSupabase([
      { table: "bookings", op: "select.maybeSingle", result: { data: BOOKING_ROW, error: null } },
      { table: "payment_requests", op: "select.maybeSingle", result: { data: null, error: null } },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: null, error: null },
      },
    ]);
    await assert.rejects(
      () =>
        createPaymentRequestForBooking(client, {
          organizationId: "org-1",
          businessId: "biz-1",
          bookingId: "booking-1",
          amountMinorUnits: 50000,
        }),
      (err: unknown) => {
        assert.ok(err instanceof PaymentRequestError);
        assert.equal(err.code, "MERCHANT_NOT_CONNECTED");
        return true;
      },
    );
  });

  test("a concurrent-insert race (23505) returns the winner's row instead of throwing a duplicate", async () => {
    const { client } = makeFakeSupabase([
      { table: "bookings", op: "select.maybeSingle", result: { data: BOOKING_ROW, error: null } },
      { table: "payment_requests", op: "select.maybeSingle", result: { data: null, error: null } },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", connection_status: "CONNECTED" }, error: null },
      },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: makeValidCredentialsRow(), error: null },
      },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { razorpay_account_id: "acc_123" }, error: null },
      },
      {
        table: "payment_requests",
        op: "insert.select.single",
        result: { data: null, error: { code: "23505", message: "duplicate" } },
      },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "pr-race-winner",
            booking_id: "booking-1",
            status: "PENDING",
            amount_minor_units: 50000,
            currency: "INR",
            payment_link_url: "https://rzp.io/i/winner",
          },
          error: null,
        },
      },
    ]);
    const fetchImpl = fakeFetchSequence([
      {
        status: 200,
        body: { id: "plink_abc", short_url: "https://rzp.io/i/abc", status: "created" },
      },
    ]);

    const result = await createPaymentRequestForBooking(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      bookingId: "booking-1",
      amountMinorUnits: 50000,
      fetchImpl,
    });
    assert.equal(result.id, "pr-race-winner");
  });
});
