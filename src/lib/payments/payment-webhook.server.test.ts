import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { processRazorpayPaymentWebhook, PaymentWebhookError } from "./payment-webhook.server.ts";

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
    return {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return this;
      },
      maybeSingle: () => Promise.resolve(next(table, "select.maybeSingle", filters)),
    };
  }
  const client = {
    from(table: string) {
      return {
        select: () => selectChain(table),
        insert(payload: unknown) {
          // Lazy: consumes exactly one script entry, on whichever path the
          // caller actually uses (direct await, or .select().single()) —
          // never both, so a chained .select() doesn't double-consume.
          return {
            then(resolve: (v: unknown) => void) {
              resolve(next(table, "insert", payload));
            },
            select: () => ({
              single: () => Promise.resolve(next(table, "insert.select.single", payload)),
            }),
          };
        },
        update(payload: unknown) {
          const filters: Record<string, unknown> = {};
          const notFilters: Record<string, unknown> = {};
          const chain = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return chain;
            },
            neq(col: string, val: unknown) {
              notFilters[col] = val;
              return chain;
            },
            in(col: string, val: unknown) {
              filters[col] = val;
              return chain;
            },
            select: () => ({
              maybeSingle: () =>
                Promise.resolve(
                  next(table, "update.select.maybeSingle", payload, filters, notFilters),
                ),
            }),
            then(resolve: (v: unknown) => void) {
              resolve(next(table, "update", payload, filters));
            },
          };
          return chain;
        },
      };
    },
  };
  return { client: client as never, calls };
}

function razorpayLinkPaidPayload(input: {
  paymentLinkId: string;
  status: string;
  amountPaid: number;
  currency: string;
  paymentId?: string;
}): string {
  return JSON.stringify({
    event: "payment_link.paid",
    payload: {
      payment_link: {
        entity: {
          id: input.paymentLinkId,
          status: input.status,
          amount_paid: input.amountPaid,
          currency: input.currency,
        },
      },
      payment: input.paymentId ? { entity: { id: input.paymentId } } : undefined,
    },
  });
}

/** A failed payment ATTEMPT against a still-open payment link — a `payment.failed` event, distinct from the payment_link entity's own status. */
function razorpayPaymentFailedPayload(input: { paymentLinkId: string }): string {
  return JSON.stringify({
    event: "payment.failed",
    payload: {
      payment: {
        entity: { id: "pay_failed_1", status: "failed", payment_link_id: input.paymentLinkId },
      },
    },
  });
}

const BASE_PAYMENT_REQUEST = {
  id: "pr-1",
  organization_id: "org-1",
  business_id: "biz-1",
  booking_id: "booking-1",
  razorpay_connection_id: "conn-1",
  provider: "razorpay",
  provider_order_id: null,
  provider_payment_link_id: "plink_abc",
  provider_payment_id: null,
  amount_minor_units: 50000,
  currency: "INR",
  status: "PENDING",
  payment_link_url: "https://rzp.io/i/abc",
  idempotency_key: "booking-1",
  metadata: {},
  last_error: null,
  captured_at: null,
  expires_at: null,
  created_at: "2026-09-25T10:00:00.000Z",
  updated_at: "2026-09-25T10:00:00.000Z",
};

describe("processRazorpayPaymentWebhook — idempotency", () => {
  test("a duplicate event_id short-circuits without touching payment_requests at all", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: { code: "23505" } } },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      {
        rawBody: razorpayLinkPaidPayload({
          paymentLinkId: "plink_abc",
          status: "paid",
          amountPaid: 50000,
          currency: "INR",
        }),
        eventId: "evt-1",
      },
      {},
    );
    assert.equal(result.outcome, "duplicate");
    assert.equal(calls.length, 1);
  });
});

describe("processRazorpayPaymentWebhook — tenant resolution never trusts the payload", () => {
  test("an unmatched payment link id (no payment_requests row we ourselves created) is reported as no_matching_request, not a crash or a fabricated success", async () => {
    const { client } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
      { table: "payment_requests", op: "select.maybeSingle", result: { data: null, error: null } },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      {
        rawBody: razorpayLinkPaidPayload({
          paymentLinkId: "plink_unknown",
          status: "paid",
          amountPaid: 50000,
          currency: "INR",
        }),
        eventId: "evt-2",
      },
      {},
    );
    assert.equal(result.outcome, "no_matching_request");
  });
});

describe("processRazorpayPaymentWebhook — amount/currency cross-check", () => {
  test("a captured event whose amount does not match the stored payment_request is rejected, never captured", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: { data: BASE_PAYMENT_REQUEST, error: null },
      },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      {
        rawBody: razorpayLinkPaidPayload({
          paymentLinkId: "plink_abc",
          status: "paid",
          amountPaid: 1,
          currency: "INR",
        }),
        eventId: "evt-3",
      },
      {},
    );
    assert.equal(result.outcome, "amount_mismatch");
    const captureAttempt = calls.find((c) => c.table === "payment_requests" && c.op === "update");
    assert.equal(
      captureAttempt,
      undefined,
      "must never write a CAPTURED update for a mismatched amount",
    );
  });

  test("a captured event whose currency does not match is rejected, never captured", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: { data: BASE_PAYMENT_REQUEST, error: null },
      },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      {
        rawBody: razorpayLinkPaidPayload({
          paymentLinkId: "plink_abc",
          status: "paid",
          amountPaid: 50000,
          currency: "USD",
        }),
        eventId: "evt-4",
      },
      {},
    );
    assert.equal(result.outcome, "currency_mismatch");
    const captureAttempt = calls.find((c) => c.table === "payment_requests" && c.op === "update");
    assert.equal(captureAttempt, undefined);
  });
});

describe("processRazorpayPaymentWebhook — capture happy path", () => {
  test("captures the payment and confirms the booking when it is still PENDING_PAYMENT", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: { data: BASE_PAYMENT_REQUEST, error: null },
      },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
      {
        table: "payment_requests",
        op: "update.select.maybeSingle",
        result: { data: { id: "pr-1" }, error: null },
      },
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: { data: { id: "booking-1", status: "PENDING_PAYMENT" }, error: null },
      },
      {
        table: "payment_domain_events",
        op: "insert.select.single",
        result: {
          data: {
            id: "event-1",
            event_type: "PAYMENT_CAPTURED",
            organization_id: "org-1",
            business_id: "biz-1",
            payment_request_id: "pr-1",
            booking_id: "booking-1",
            payload: {},
          },
          error: null,
        },
      },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      {
        rawBody: razorpayLinkPaidPayload({
          paymentLinkId: "plink_abc",
          status: "paid",
          amountPaid: 50000,
          currency: "INR",
          paymentId: "pay_xyz",
        }),
        eventId: "evt-5",
      },
      {},
    );
    assert.equal(result.outcome, "captured");
    assert.equal(result.domainEvent?.event_type, "PAYMENT_CAPTURED");
    const captureUpdate = calls.find(
      (c) => c.table === "payment_requests" && c.op === "update.select.maybeSingle",
    );
    const payload = captureUpdate!.args[0] as Record<string, unknown>;
    assert.equal(payload["status"], "CAPTURED");
    assert.equal(payload["provider_payment_id"], "pay_xyz");
  });

  test("emits PAYMENT_CAPTURED_AFTER_EXPIRY (not PAYMENT_CAPTURED) when the booking is no longer PENDING_PAYMENT — a late capture never silently confirms an expired/cancelled booking", async () => {
    const { client } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: { data: BASE_PAYMENT_REQUEST, error: null },
      },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
      {
        table: "payment_requests",
        op: "update.select.maybeSingle",
        result: { data: { id: "pr-1" }, error: null },
      },
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: { data: { id: "booking-1", status: "PAYMENT_EXPIRED" }, error: null },
      },
      {
        table: "payment_domain_events",
        op: "insert.select.single",
        result: {
          data: {
            id: "event-1",
            event_type: "PAYMENT_CAPTURED_AFTER_EXPIRY",
            organization_id: "org-1",
            business_id: "biz-1",
            payment_request_id: "pr-1",
            booking_id: "booking-1",
            payload: {},
          },
          error: null,
        },
      },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      {
        rawBody: razorpayLinkPaidPayload({
          paymentLinkId: "plink_abc",
          status: "paid",
          amountPaid: 50000,
          currency: "INR",
        }),
        eventId: "evt-6",
      },
      {},
    );
    assert.equal(result.outcome, "captured");
    assert.equal(result.domainEvent?.event_type, "PAYMENT_CAPTURED_AFTER_EXPIRY");
  });
});

describe("processRazorpayPaymentWebhook — concurrent-capture race (two webhook deliveries, one underlying transaction)", () => {
  test("a second, concurrently-processed webhook delivery for the same capture (different event_id, e.g. payment_link.paid vs payment.captured) never double-dispatches — loses the DB race and reports already_captured", async () => {
    // Both deliveries read the row as still PENDING (neither has committed
    // yet) — this is exactly the scenario the outer payment_webhook_events
    // (provider, event_id) dedupe does NOT catch, since Razorpay assigns a
    // distinct event_id to each event type even when they describe the
    // same payment. The conditional `.neq("status", "CAPTURED")` update is
    // what actually closes this race: the fake client's scripted response
    // for this call simulates the "lost the race" outcome directly
    // (maybeSingle() returns null), exactly as the real conditional UPDATE
    // would when a concurrent writer already flipped the row first.
    const { client, calls } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: { data: BASE_PAYMENT_REQUEST, error: null }, // still PENDING as read by this delivery
      },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
      {
        table: "payment_requests",
        op: "update.select.maybeSingle",
        result: { data: null, error: null }, // lost the race: 0 rows matched .neq("status","CAPTURED")
      },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      {
        rawBody: razorpayLinkPaidPayload({
          paymentLinkId: "plink_abc",
          status: "paid",
          amountPaid: 50000,
          currency: "INR",
          paymentId: "pay_xyz",
        }),
        eventId: "evt-race-2",
      },
      {},
    );
    assert.equal(result.outcome, "already_captured");
    // No domain event insert must ever be attempted for the losing side of
    // the race — a second PaymentCaptured event would double-dispatch to
    // the calendar/WhatsApp/voice consumers (a second Google Calendar
    // event, a duplicate confirmation message, etc.).
    assert.ok(!calls.some((c) => c.table === "payment_domain_events"));
    assert.ok(!calls.some((c) => c.table === "bookings"));
  });
});

describe("processRazorpayPaymentWebhook — never regresses an already-captured payment", () => {
  test("a second webhook event for an already-CAPTURED payment request is a safe no-op (duplicate payment guard)", async () => {
    const alreadyCaptured = { ...BASE_PAYMENT_REQUEST, status: "CAPTURED" };
    const { client, calls } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: { data: alreadyCaptured, error: null },
      },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      {
        rawBody: razorpayLinkPaidPayload({
          paymentLinkId: "plink_abc",
          status: "paid",
          amountPaid: 50000,
          currency: "INR",
        }),
        eventId: "evt-7",
      },
      {},
    );
    assert.equal(result.outcome, "already_captured");
    const captureAttempt = calls.find((c) => c.table === "payment_requests" && c.op === "update");
    assert.equal(captureAttempt, undefined);
  });
});

describe("processRazorpayPaymentWebhook — failed attempt against a still-open link", () => {
  test("a failed payment ATTEMPT emits PAYMENT_FAILED but leaves payment_requests.status untouched — the link is still payable", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: { data: BASE_PAYMENT_REQUEST, error: null },
      },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
      {
        table: "payment_domain_events",
        op: "insert.select.single",
        result: {
          data: {
            id: "event-1",
            event_type: "PAYMENT_FAILED",
            organization_id: "org-1",
            business_id: "biz-1",
            payment_request_id: "pr-1",
            booking_id: "booking-1",
            payload: {},
          },
          error: null,
        },
      },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      { rawBody: razorpayPaymentFailedPayload({ paymentLinkId: "plink_abc" }), eventId: "evt-8" },
      {},
    );
    assert.equal(result.outcome, "failed");
    assert.equal(result.domainEvent?.event_type, "PAYMENT_FAILED");
    const paymentRequestUpdate = calls.find(
      (c) => c.table === "payment_requests" && c.op === "update",
    );
    assert.equal(
      paymentRequestUpdate,
      undefined,
      "a failed attempt must never change payment_requests.status",
    );
  });
});

describe("processRazorpayPaymentWebhook — link closed (expired/cancelled)", () => {
  test("a cancelled payment link transitions payment_requests to CANCELLED and still emits PAYMENT_EXPIRED (attempt is over)", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: { data: BASE_PAYMENT_REQUEST, error: null },
      },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
      {
        table: "payment_requests",
        op: "update.select.maybeSingle",
        result: { data: { id: "pr-1" }, error: null },
      },
      {
        table: "payment_domain_events",
        op: "insert.select.single",
        result: {
          data: {
            id: "event-1",
            event_type: "PAYMENT_EXPIRED",
            organization_id: "org-1",
            business_id: "biz-1",
            payment_request_id: "pr-1",
            booking_id: "booking-1",
            payload: {},
          },
          error: null,
        },
      },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      {
        rawBody: razorpayLinkPaidPayload({
          paymentLinkId: "plink_abc",
          status: "cancelled",
          amountPaid: 0,
          currency: "INR",
        }),
        eventId: "evt-8b",
      },
      {},
    );
    assert.equal(result.outcome, "expired");
    const updateCall = calls.find(
      (c) => c.table === "payment_requests" && c.op === "update.select.maybeSingle",
    );
    const payload = updateCall!.args[0] as Record<string, unknown>;
    assert.equal(payload["status"], "CANCELLED");
  });

  test("an expired payment link transitions payment_requests to EXPIRED and emits PAYMENT_EXPIRED", async () => {
    const { client } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: { data: BASE_PAYMENT_REQUEST, error: null },
      },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
      {
        table: "payment_requests",
        op: "update.select.maybeSingle",
        result: { data: { id: "pr-1" }, error: null },
      },
      {
        table: "payment_domain_events",
        op: "insert.select.single",
        result: {
          data: {
            id: "event-1",
            event_type: "PAYMENT_EXPIRED",
            organization_id: "org-1",
            business_id: "biz-1",
            payment_request_id: "pr-1",
            booking_id: "booking-1",
            payload: {},
          },
          error: null,
        },
      },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      {
        rawBody: razorpayLinkPaidPayload({
          paymentLinkId: "plink_abc",
          status: "expired",
          amountPaid: 0,
          currency: "INR",
        }),
        eventId: "evt-9",
      },
      {},
    );
    assert.equal(result.outcome, "expired");
    assert.equal(result.domainEvent?.event_type, "PAYMENT_EXPIRED");
  });

  test("a second, concurrently-processed webhook delivery for the same closure never double-dispatches PAYMENT_EXPIRED — loses the DB race and is ignored", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: { data: BASE_PAYMENT_REQUEST, error: null }, // still PENDING as read by this delivery
      },
      { table: "payment_webhook_events", op: "update", result: { error: null } },
      {
        table: "payment_requests",
        op: "update.select.maybeSingle",
        result: { data: null, error: null }, // lost the race: 0 rows matched .in("status",["CREATED","PENDING"])
      },
    ]);
    const result = await processRazorpayPaymentWebhook(
      client,
      {
        rawBody: razorpayLinkPaidPayload({
          paymentLinkId: "plink_abc",
          status: "expired",
          amountPaid: 0,
          currency: "INR",
        }),
        eventId: "evt-race-expire-2",
      },
      {},
    );
    assert.equal(result.outcome, "ignored");
    assert.ok(!calls.some((c) => c.table === "payment_domain_events"));
  });
});

describe("processRazorpayPaymentWebhook — malformed input", () => {
  test("throws a PaymentWebhookError (never a raw parse crash) on invalid JSON", async () => {
    const { client } = makeFakeSupabase([
      { table: "payment_webhook_events", op: "insert", result: { error: null } },
    ]);
    await assert.rejects(
      () => processRazorpayPaymentWebhook(client, { rawBody: "not json", eventId: "evt-10" }, {}),
      PaymentWebhookError,
    );
  });
});
