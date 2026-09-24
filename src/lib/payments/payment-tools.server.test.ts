import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  create_payment_required_booking,
  request_payment,
  check_payment_status,
} from "./payment-tools.server.ts";
import { encryptCredential } from "../razorpay/razorpay-crypto.server.ts";

/**
 * Mirrors calendar-tools.server.test.ts's own scope: these tests target
 * the default-deny permission gating and tenant-ownership checks every
 * tool must apply before touching anything — not a re-exercise of
 * booking-service.server.test.ts / payment-request-service.server.test.ts /
 * whatsapp-payments.server.test.ts's own already-covered internals.
 */

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

const AGENT_ROW_DENIED = { organization_id: "org-1", capabilities: {} };
const AGENT_ROW_PERMITTED = {
  organization_id: "org-1",
  capabilities: { booking_payment_required: true, payment_request: true },
};

describe("create_payment_required_booking — default-deny permission gate", () => {
  test("denies when booking_payment_required is not granted, never reaches the calendar/booking layer", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: { data: AGENT_ROW_DENIED, error: null },
      },
    ]);
    const result = await create_payment_required_booking(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      startIso: "2026-10-01T10:00:00.000Z",
      endIso: "2026-10-01T10:30:00.000Z",
      source: "voice",
      idempotencyKey: "k1",
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "TOOL_NOT_PERMITTED");
    assert.equal(
      calls.length,
      1,
      "must stop at the permission check, never look up businesses/connections",
    );
  });

  test("surfaces GOOGLE_AUTH_REQUIRED when the business has no connected calendar, after permission passes", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: { data: AGENT_ROW_PERMITTED, error: null },
      },
      {
        table: "businesses",
        op: "select.maybeSingle",
        result: {
          data: { id: "biz-1", organization_id: "org-1", name: "Acme", timezone: "Asia/Kolkata" },
          error: null,
        },
      },
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: { data: null, error: null },
      },
    ]);
    const result = await create_payment_required_booking(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      startIso: "2026-10-01T10:00:00.000Z",
      endIso: "2026-10-01T10:30:00.000Z",
      source: "voice",
      idempotencyKey: "k1",
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "GOOGLE_AUTH_REQUIRED");
  });
});

describe("request_payment — default-deny permission gate", () => {
  test("denies when payment_request is not granted, never creates a payment request", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: { data: AGENT_ROW_DENIED, error: null },
      },
    ]);
    const result = await request_payment(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      bookingId: "booking-1",
      amountMinorUnits: 50000,
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "TOOL_NOT_PERMITTED");
    assert.equal(calls.length, 1);
  });

  test("happy path: creates the payment request and sends the WhatsApp link; a missing WhatsApp connection degrades to whatsappSent:false without failing the tool", async () => {
    process.env["RAZORPAY_CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
    for (const key of [
      "RAZORPAY_CLIENT_ID",
      "RAZORPAY_CLIENT_SECRET",
      "RAZORPAY_REDIRECT_URI",
      "RAZORPAY_OAUTH_AUTHORIZE_URL",
      "RAZORPAY_OAUTH_TOKEN_URL",
      "RAZORPAY_OAUTH_SCOPE",
    ]) {
      process.env[key] = `test-${key.toLowerCase()}`;
    }
    const validCredentialsRow = {
      id: "conn-1",
      connection_status: "CONNECTED",
      encrypted_credentials: encryptCredential(
        JSON.stringify({ accessToken: "cached-access", refreshToken: "stored-refresh" }),
      ),
      token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const { client } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: { data: AGENT_ROW_PERMITTED, error: null },
      },
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "booking-1",
            organization_id: "org-1",
            business_id: "biz-1",
            status: "PENDING_PAYMENT",
            customer_name: "Priya",
            customer_phone: "+919876543210",
            start_at: "2026-10-01T10:00:00.000Z",
          },
          error: null,
        },
      },
      { table: "payment_requests", op: "select.maybeSingle", result: { data: null, error: null } },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", connection_status: "CONNECTED" }, error: null },
      },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: validCredentialsRow, error: null },
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
      // request_payment tool's own re-read of the booking for its phone number:
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: { data: { customer_phone: "+919876543210" }, error: null },
      },
      // sendWhatsAppPaymentMessage's own connection lookup — no connected number:
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: { data: null, error: null },
      },
    ]);
    const fetchImpl = fakeFetchSequence([
      {
        status: 200,
        body: { id: "plink_abc", short_url: "https://rzp.io/i/abc", status: "created" },
      },
    ]);

    const result = await request_payment(
      client,
      {
        organizationId: "org-1",
        businessId: "biz-1",
        bookingId: "booking-1",
        amountMinorUnits: 50000,
      },
      fetchImpl,
    );
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.paymentRequestId, "pr-1");
      assert.equal(result.data.status, "PENDING");
      assert.equal(
        result.data.whatsappSent,
        false,
        "no WhatsApp connection configured — degrades, does not fail",
      );
    }
  });
});

describe("check_payment_status", () => {
  test("denies when payment_request is not granted", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: { data: AGENT_ROW_DENIED, error: null },
      },
    ]);
    const result = await check_payment_status(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      paymentRequestId: "pr-1",
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "TOOL_NOT_PERMITTED");
  });

  test("rejects a payment request belonging to a different organization — never leaks cross-tenant status", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: { data: AGENT_ROW_PERMITTED, error: null },
      },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "pr-1",
            organization_id: "org-OTHER",
            business_id: "biz-1",
            status: "PENDING",
            amount_minor_units: 50000,
            currency: "INR",
            payment_link_url: null,
            provider_payment_link_id: null,
            razorpay_connection_id: "conn-1",
          },
          error: null,
        },
      },
    ]);
    const result = await check_payment_status(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      paymentRequestId: "pr-1",
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "PAYMENT_REQUEST_NOT_FOUND");
  });

  test("never attempts a live provider read when the stored status is already CAPTURED — that value is already the server-verified truth", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: { data: AGENT_ROW_PERMITTED, error: null },
      },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "pr-1",
            organization_id: "org-1",
            business_id: "biz-1",
            status: "CAPTURED",
            amount_minor_units: 50000,
            currency: "INR",
            payment_link_url: "https://rzp.io/i/abc",
            provider_payment_link_id: "plink_abc",
            razorpay_connection_id: "conn-1",
          },
          error: null,
        },
      },
    ]);
    const result = await check_payment_status(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      paymentRequestId: "pr-1",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.status, "CAPTURED");
      assert.equal(result.data.providerStatus, "CAPTURED");
    }
    assert.equal(
      calls.length,
      2,
      "only the permission check + the row read — no provider network call",
    );
  });
});
