import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sendWhatsAppPaymentMessage, paymentLinkMessageText } from "./whatsapp-payments.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

/**
 * sendWhatsAppPaymentMessage now delegates to the shared business-message
 * path (whatsapp-business-message.server.ts); these keep the payment
 * module's original guarantees, run against the in-memory database.
 */

const ENV_KEYS = [
  "VOBIZ_AUTH_ID",
  "VOBIZ_AUTH_TOKEN",
  "WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME",
  "WHATSAPP_TEMPLATE_PAYMENT_LINK_LANGUAGE",
  "WHATSAPP_TEMPLATE_PAYMENT_CONFIRMATION_NAME",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env["VOBIZ_AUTH_ID"] = "MA_TEST";
  process.env["VOBIZ_AUTH_TOKEN"] = "vobiz-test-token";
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const BASE_INPUT = {
  organizationId: "org-1",
  businessId: "biz-1",
  bookingId: "booking-1",
  paymentRequestId: "pr-1",
  customerPhone: "+919876543210",
  purpose: "payment_link" as const,
  bodyText: "Your payment link: https://rzp.io/i/abc",
};

function seed(over: { inboundMinutesAgo?: number; connectionBusiness?: string } = {}) {
  const s: Record<string, Record<string, unknown>[]> = {
    businesses: [{ id: "biz-1", organization_id: "org-1", country: "IN" }],
    whatsapp_connections: [
      {
        id: "conn-1",
        organization_id: "org-1",
        business_id: over.connectionBusiness ?? "biz-1",
        phone_number_id: "pnid-1",
        status: "connected",
        waba_id: "waba-1",
        provider: "vobiz",
        vobiz_channel_id: "ch-test-access-token",
        notifications_enabled: true,
        transactional_consent_basis: "Customers agree to WhatsApp updates when they book.",
      },
    ],
    // Synced from Meta. The WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME variable only
    // selects it; this registry row is what proves it is approved.
    whatsapp_templates: [
      {
        id: "tpl-env",
        organization_id: "org-1",
        whatsapp_connection_id: "conn-1",
        name: "payment_link_notify",
        language: "en_US",
        category: "UTILITY",
        status: "APPROVED",
        body_text: "{{1}}",
        body_param_count: 1,
      },
    ],
  };
  if (over.inboundMinutesAgo !== undefined) {
    s["whatsapp_conversations"] = [
      {
        id: "conv-1",
        organization_id: "org-1",
        whatsapp_connection_id: "conn-1",
        wa_id: "919876543210",
        last_inbound_at: new Date(Date.now() - over.inboundMinutesAgo * 60_000).toISOString(),
      },
    ];
  }
  return s;
}

function fakeMeta(status = 200) {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify(
        status === 200
          ? {
              id: `vmsg.T${sent.length}`,
              status: "pending",
              meta_message_id: `wamid.T${sent.length}`,
            }
          : {},
      ),
      { status },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const outbound = (db: ReturnType<typeof createFakeDb>) =>
  db.rows("whatsapp_messages").filter((m) => m["direction"] === "outbound");

describe("sendWhatsAppPaymentMessage — connection scoping", () => {
  test("skips (never throws, never fakes success) when no connected WhatsApp number exists for this business", async () => {
    const db = createFakeDb({ businesses: seed()["businesses"]! });
    const result = await sendWhatsAppPaymentMessage(db.client, BASE_INPUT);
    assert.equal(result.outcome, "skipped_no_connection");
  });

  test("never falls back to another business's connected number", async () => {
    const db = createFakeDb(seed({ connectionBusiness: "biz-other" }));
    const meta = fakeMeta();
    const result = await sendWhatsAppPaymentMessage(db.client, BASE_INPUT, meta.fetchImpl);
    assert.equal(result.outcome, "skipped_no_connection");
    assert.equal(meta.sent.length, 0);
  });
});

describe("sendWhatsAppPaymentMessage — at most once per purpose + payment request", () => {
  test("a second send for the same purpose + payment_request_id is skipped", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_notify";
    const db = createFakeDb(seed());
    const meta = fakeMeta();
    assert.equal(
      (await sendWhatsAppPaymentMessage(db.client, BASE_INPUT, meta.fetchImpl)).outcome,
      "sent",
    );
    assert.equal(
      (await sendWhatsAppPaymentMessage(db.client, BASE_INPUT, meta.fetchImpl)).outcome,
      "skipped_duplicate",
    );
    assert.equal(meta.sent.length, 1);
  });

  test("concurrent senders (inline + recovery worker) produce one message", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_notify";
    const db = createFakeDb(seed());
    const meta = fakeMeta();
    const results = await Promise.all([
      sendWhatsAppPaymentMessage(db.client, BASE_INPUT, meta.fetchImpl),
      sendWhatsAppPaymentMessage(db.client, BASE_INPUT, meta.fetchImpl),
    ]);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ["sent", "skipped_duplicate"]);
    assert.equal(meta.sent.length, 1);
  });

  test("a failed attempt doesn't block a later retry", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_notify";
    const db = createFakeDb(seed());
    assert.equal(
      (await sendWhatsAppPaymentMessage(db.client, BASE_INPUT, fakeMeta(400).fetchImpl)).outcome,
      "failed",
    );
    assert.equal(
      (await sendWhatsAppPaymentMessage(db.client, BASE_INPUT, fakeMeta().fetchImpl)).outcome,
      "sent",
    );
  });
});

describe("sendWhatsAppPaymentMessage — 24h window / template requirement", () => {
  test("fails explicitly (never fakes a template) when a template is required but not configured", async () => {
    const db = createFakeDb(seed());
    const meta = fakeMeta();
    const result = await sendWhatsAppPaymentMessage(db.client, BASE_INPUT, meta.fetchImpl);
    assert.equal(result.outcome, "failed");
    assert.equal(result.retryable, false);
    assert.equal(meta.sent.length, 0);
    const [row] = outbound(db);
    assert.equal(row!["status"], "failed");
    assert.match(String(row!["error_message"]), /Message Template is required/);
  });

  test("sends the configured template outside the 24h window, with the message as its body parameter", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_notify";
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_LANGUAGE"] = "en_US";
    const db = createFakeDb(seed());
    const meta = fakeMeta();
    const result = await sendWhatsAppPaymentMessage(db.client, BASE_INPUT, meta.fetchImpl);
    assert.equal(result.outcome, "sent");
    const body = meta.sent[0] as { to: string; type: string; template: Record<string, unknown> };
    assert.equal(body.type, "template");
    assert.equal(body.to, "+919876543210");
    assert.deepEqual(body.template, {
      name: "payment_link_notify",
      language: { code: "en_US" },
      components: [{ type: "body", parameters: [{ type: "text", text: BASE_INPUT.bodyText }] }],
    });
    const [row] = outbound(db);
    assert.equal(row!["status"], "sent");
    assert.equal(row!["wa_message_id"], "wamid.T1");
    assert.deepEqual(row!["metadata"], {
      booking_id: "booking-1",
      payment_request_id: "pr-1",
      purpose: "payment_link",
      idempotency_key: "payment_link:pr-1",
      vobiz_message_id: "vmsg.T1",
    });
  });

  test("an approved template mapped in the registry wins over the environment fallback; an unapproved one is never used", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "env_template";
    for (const [status, expected] of [
      ["APPROVED", "registry_template"],
      ["PAUSED", null],
    ] as const) {
      const s = seed();
      s["whatsapp_templates"] = [
        {
          organization_id: "org-1",
          whatsapp_connection_id: "conn-1",
          name: "registry_template",
          language: "en",
          category: "UTILITY",
          status,
          purpose: "payment_link",
          body_param_count: 1,
        },
      ];
      const db = createFakeDb(s);
      const meta = fakeMeta();
      const result = await sendWhatsAppPaymentMessage(db.client, BASE_INPUT, meta.fetchImpl);
      if (expected) {
        assert.equal(result.outcome, "sent");
        assert.equal((meta.sent[0] as { template: { name: string } }).template.name, expected);
      } else {
        assert.equal(result.outcome, "failed");
        assert.equal(meta.sent.length, 0);
      }
    }
  });

  test("sends free-form text when a recent inbound message opens the 24h window", async () => {
    const db = createFakeDb(seed({ inboundMinutesAgo: 5 }));
    const meta = fakeMeta();
    const result = await sendWhatsAppPaymentMessage(db.client, BASE_INPUT, meta.fetchImpl);
    assert.equal(result.outcome, "sent");
    assert.deepEqual(meta.sent[0], {
      channel_id: "ch-test-access-token",
      waba_id: "waba-1",
      to: "+919876543210",
      type: "text",
      text: { body: BASE_INPUT.bodyText },
    });
    assert.equal(outbound(db)[0]!["message_type"], "text");
  });
});

describe("sendWhatsAppPaymentMessage — consent", () => {
  test("never messages a suppressed or opted-out number", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_notify";
    for (const extra of [
      {
        whatsapp_suppressions: [
          {
            organization_id: "org-1",
            business_id: "biz-1",
            wa_id: "919876543210",
            reason: "blocked_by_user",
          },
        ],
      },
      {
        whatsapp_consent_events: [
          {
            organization_id: "org-1",
            business_id: "biz-1",
            wa_id: "919876543210",
            scope: "transactional",
            action: "opt_out",
            source: "customer_keyword",
          },
        ],
      },
    ]) {
      const db = createFakeDb({ ...seed(), ...extra });
      const meta = fakeMeta();
      const result = await sendWhatsAppPaymentMessage(db.client, BASE_INPUT, meta.fetchImpl);
      assert.equal(result.outcome, "skipped_not_permitted");
      assert.equal(meta.sent.length, 0);
    }
  });

  test("a national-format number is normalized with the business's country; an unusable one is skipped", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_notify";
    const db = createFakeDb(seed());
    const meta = fakeMeta();
    assert.equal(
      (
        await sendWhatsAppPaymentMessage(
          db.client,
          { ...BASE_INPUT, customerPhone: "98765 43210" },
          meta.fetchImpl,
        )
      ).outcome,
      "sent",
    );
    assert.equal((meta.sent[0] as { to: string }).to, "+919876543210");
    const bad = await sendWhatsAppPaymentMessage(
      db.client,
      { ...BASE_INPUT, paymentRequestId: "pr-2", customerPhone: "12345" },
      meta.fetchImpl,
    );
    assert.deepEqual(bad, { outcome: "skipped_not_permitted", reason: "invalid_phone" });
  });
});

describe("sendWhatsAppPaymentMessage — delivery failure never throws", () => {
  test("a Meta send failure is recorded on the message row and returned as a result, not thrown", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_notify";
    const db = createFakeDb(seed());
    const result = await sendWhatsAppPaymentMessage(db.client, BASE_INPUT, fakeMeta(400).fetchImpl);
    assert.equal(result.outcome, "failed");
    assert.equal(result.retryable, false);
    assert.equal(outbound(db)[0]!["status"], "failed");
  });
});

describe("paymentLinkMessageText", () => {
  test("includes the link, or says it's coming", () => {
    assert.equal(
      paymentLinkMessageText("https://rzp.io/i/x"),
      "Please complete your payment here: https://rzp.io/i/x",
    );
    assert.match(paymentLinkMessageText(null), /preparing your payment link/);
  });
});
