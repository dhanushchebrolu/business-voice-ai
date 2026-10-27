import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request_payment } from "./payment-tools.server.ts";
import { processRazorpayPaymentWebhook } from "./payment-webhook.server.ts";
import { handlePaymentEventForWhatsApp } from "./payment-whatsapp-consumer.server.ts";
import { encryptCredential as encryptRazorpayCredential } from "../razorpay/razorpay-crypto.server.ts";
import { createFakeDb } from "../whatsapp/whatsapp-test-db.ts";

/**
 * The revenue path end to end, on the in-memory database with fake
 * Razorpay and Meta APIs: a voice booking held for payment → request_payment
 * creates the Razorpay Payment Link and sends it on WhatsApp → only a
 * verified webhook marks it paid → the customer gets one confirmation, no
 * matter how many times Razorpay delivers.
 */

const ENV_KEYS = [
  "RAZORPAY_CREDENTIAL_ENCRYPTION_KEY",
  "RAZORPAY_CLIENT_ID",
  "RAZORPAY_CLIENT_SECRET",
  "RAZORPAY_REDIRECT_URI",
  "RAZORPAY_OAUTH_AUTHORIZE_URL",
  "RAZORPAY_OAUTH_TOKEN_URL",
  "RAZORPAY_OAUTH_SCOPE",
  "VOBIZ_AUTH_ID",
  "VOBIZ_AUTH_TOKEN",
  "WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME",
  "WHATSAPP_TEMPLATE_PAYMENT_CONFIRMATION_NAME",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["RAZORPAY_CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
  for (const k of ENV_KEYS.slice(1, 7)) process.env[k] = `test-${k.toLowerCase()}`;
  process.env["VOBIZ_AUTH_ID"] = "MA_TEST";
  process.env["VOBIZ_AUTH_TOKEN"] = "vobiz-test-token";
  process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_v1";
  process.env["WHATSAPP_TEMPLATE_PAYMENT_CONFIRMATION_NAME"] = "payment_ok_v1";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function world(over: { notificationsEnabled?: boolean } = {}) {
  const db = createFakeDb({
    businesses: [{ id: "biz-1", organization_id: "org-1", name: "Smile Dental", country: "IN" }],
    agent_configs: [
      {
        id: "agent-1",
        organization_id: "org-1",
        business_id: "biz-1",
        capabilities: { booking_payment_required: true, payment_request: true },
      },
    ],
    bookings: [
      {
        id: "booking-1",
        organization_id: "org-1",
        business_id: "biz-1",
        status: "PENDING_PAYMENT",
        source: "voice",
        customer_name: "Priya",
        customer_phone: "+919876543210",
        start_at: "2026-10-25T05:00:00.000Z",
        timezone: "Asia/Kolkata",
      },
    ],
    razorpay_connections: [
      {
        id: "rzp-conn-1",
        organization_id: "org-1",
        business_id: "biz-1",
        connection_status: "CONNECTED",
        razorpay_account_id: "acc_123",
        encrypted_credentials: encryptRazorpayCredential(
          JSON.stringify({ accessToken: "cached-access", refreshToken: "stored-refresh" }),
        ),
        token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
    whatsapp_connections: [
      {
        id: "wa-conn-1",
        organization_id: "org-1",
        business_id: "biz-1",
        phone_number_id: "PN_1",
        status: "connected",
        provider: "vobiz",
        vobiz_channel_id: "ch-wa-token",
        notifications_enabled: over.notificationsEnabled ?? true,
        transactional_consent_basis:
          "Callers agree to WhatsApp payment links and updates on the call.",
      },
    ],
    // Synced from Meta; the WHATSAPP_TEMPLATE_* variables select these, the registry proves approval.
    whatsapp_templates: ["payment_link_v1", "payment_ok_v1"].map((name) => ({
      organization_id: "org-1",
      whatsapp_connection_id: "wa-conn-1",
      name,
      language: "en_US",
      category: "UTILITY",
      status: "APPROVED",
      body_param_count: 1,
    })),
  });
  const razorpayCalls: string[] = [];
  const whatsapp: {
    template: { name: string; components: { parameters: { text: string }[] }[] };
  }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.includes("api.vobiz.ai")) {
      whatsapp.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          id: `vmsg.${whatsapp.length}`,
          status: "pending",
          meta_message_id: `wamid.${whatsapp.length}`,
        }),
        {
          status: 200,
        },
      );
    }
    razorpayCalls.push(`${init.method} ${url}`);
    return new Response(
      JSON.stringify({ id: "plink_abc", short_url: "https://rzp.io/i/abc", status: "created" }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { db, fetchImpl, razorpayCalls, whatsapp };
}

const paidEvent = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: "payment_link.paid",
    payload: {
      payment_link: {
        entity: {
          id: "plink_abc",
          status: "paid",
          amount_paid: 50000,
          currency: "INR",
          ...overrides,
        },
      },
      payment: { entity: { id: "pay_1", status: "captured", amount: 50000, currency: "INR" } },
    },
  });

describe("voice booking → payment link on WhatsApp → verified payment → one confirmation", () => {
  test("the full path, with duplicate and parallel webhook deliveries", async () => {
    const { db, fetchImpl, razorpayCalls, whatsapp } = world();

    // 1. The voice agent requests payment for its PENDING_PAYMENT hold.
    const requested = await request_payment(
      db.client,
      {
        organizationId: "org-1",
        businessId: "biz-1",
        bookingId: "booking-1",
        amountMinorUnits: 50000,
      },
      fetchImpl,
    );
    assert.equal(requested.success, true);
    if (!requested.success) return;
    assert.equal(requested.data.whatsappSent, true);
    assert.equal(razorpayCalls.length, 1);
    assert.match(razorpayCalls[0]!, /^POST .*\/v1\/payment_links$/);
    assert.equal(whatsapp.length, 1);
    assert.equal(whatsapp[0]!.template.name, "payment_link_v1");
    assert.match(
      whatsapp[0]!.template.components[0]!.parameters[0]!.text,
      /https:\/\/rzp\.io\/i\/abc/,
    );

    // Sending the link never marks anything paid.
    const [pr] = db.rows("payment_requests");
    assert.notEqual(pr!["status"], "CAPTURED");
    assert.equal(db.rows("bookings")[0]!["status"], "PENDING_PAYMENT");

    // Asking again doesn't create a second link or a second message.
    await request_payment(
      db.client,
      {
        organizationId: "org-1",
        businessId: "biz-1",
        bookingId: "booking-1",
        amountMinorUnits: 50000,
      },
      fetchImpl,
    );
    assert.equal(razorpayCalls.length, 1);
    assert.equal(whatsapp.length, 1);

    // 2. A verified Razorpay webhook (signature checked by the route) captures it.
    const consumers = { whatsapp: handlePaymentEventForWhatsApp };
    const result = await processRazorpayPaymentWebhook(
      db.client,
      { rawBody: paidEvent(), eventId: "evt_1" },
      consumers,
      fetchImpl,
    );
    assert.equal(result.outcome, "captured");
    assert.equal(db.rows("payment_requests")[0]!["status"], "CAPTURED");
    assert.equal(whatsapp.length, 2);
    assert.equal(whatsapp[1]!.template.name, "payment_ok_v1");
    assert.match(
      whatsapp[1]!.template.components[0]!.parameters[0]!.text,
      /^Payment received!.*INR 500\.00/,
    );
    assert.equal(db.rows("payment_domain_events")[0]!["whatsapp_dispatched_at"] !== null, true);

    // 3. Razorpay redelivers the same event, then sends a second event for the same capture.
    assert.equal(
      (
        await processRazorpayPaymentWebhook(
          db.client,
          { rawBody: paidEvent(), eventId: "evt_1" },
          consumers,
          fetchImpl,
        )
      ).outcome,
      "duplicate",
    );
    assert.equal(
      (
        await processRazorpayPaymentWebhook(
          db.client,
          { rawBody: paidEvent(), eventId: "evt_2" },
          consumers,
          fetchImpl,
        )
      ).outcome,
      "already_captured",
    );
    assert.equal(whatsapp.length, 2, "still exactly one confirmation");
    assert.equal(db.rows("payment_domain_events").length, 1);
  });

  test("an amount mismatch is never captured and nobody is told it's paid", async () => {
    const { db, fetchImpl, whatsapp } = world();
    await request_payment(
      db.client,
      {
        organizationId: "org-1",
        businessId: "biz-1",
        bookingId: "booking-1",
        amountMinorUnits: 50000,
      },
      fetchImpl,
    );
    const result = await processRazorpayPaymentWebhook(
      db.client,
      { rawBody: paidEvent({ amount_paid: 100 }), eventId: "evt_x" },
      { whatsapp: handlePaymentEventForWhatsApp },
      fetchImpl,
    );
    assert.equal(result.outcome, "amount_mismatch");
    assert.notEqual(db.rows("payment_requests")[0]!["status"], "CAPTURED");
    assert.equal(whatsapp.length, 1, "only the payment link");
  });

  test("a WhatsApp failure on the confirmation never undoes the capture, and is recorded for the outbox to retry", async () => {
    const { db, fetchImpl } = world();
    await request_payment(
      db.client,
      {
        organizationId: "org-1",
        businessId: "biz-1",
        bookingId: "booking-1",
        amountMinorUnits: 50000,
      },
      fetchImpl,
    );
    const metaDown = (async (url: string, init: RequestInit) =>
      url.includes("api.vobiz.ai")
        ? new Response("{}", { status: 503 })
        : fetchImpl(url, init)) as unknown as typeof fetch;
    const result = await processRazorpayPaymentWebhook(
      db.client,
      { rawBody: paidEvent(), eventId: "evt_1" },
      { whatsapp: handlePaymentEventForWhatsApp },
      metaDown,
    );
    assert.equal(result.outcome, "captured");
    assert.equal(db.rows("payment_requests")[0]!["status"], "CAPTURED");
    const event = db.rows("payment_domain_events")[0]!;
    assert.equal(event["whatsapp_dispatched_at"] ?? null, null);
    assert.match(String(event["whatsapp_error"]), /not delivered/);
  });
});

describe("notifications switched off for the business", () => {
  test("the link is still created and payment is still captured, but nothing is sent on WhatsApp", async () => {
    const { db, fetchImpl, razorpayCalls, whatsapp } = world({ notificationsEnabled: false });
    const requested = await request_payment(
      db.client,
      {
        organizationId: "org-1",
        businessId: "biz-1",
        bookingId: "booking-1",
        amountMinorUnits: 50000,
      },
      fetchImpl,
    );
    assert.equal(requested.success, true);
    assert.equal(requested.success && requested.data.whatsappSent, false);
    assert.equal(
      razorpayCalls.length,
      1,
      "the Razorpay link exists (the voice agent can read it out)",
    );
    const result = await processRazorpayPaymentWebhook(
      db.client,
      { rawBody: paidEvent(), eventId: "evt_off" },
      { whatsapp: handlePaymentEventForWhatsApp },
      fetchImpl,
    );
    assert.equal(result.outcome, "captured");
    assert.equal(db.rows("payment_requests")[0]!["status"], "CAPTURED");
    assert.equal(whatsapp.length, 0);
    assert.equal(db.rows("whatsapp_messages").length, 0, "no message rows either");
  });
});
