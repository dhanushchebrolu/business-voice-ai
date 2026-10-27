import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  sendBusinessWhatsAppMessage,
  purposeScopeProblem,
  requiresNotificationSettings,
  type BusinessMessageInput,
} from "./whatsapp-business-message.server.ts";
import { createFakeDb, type FakeDbOptions } from "./whatsapp-test-db.ts";

/**
 * The shared business-initiated sender's safeguards, against the in-memory
 * database and a fake Meta (no real messages are sent).
 */

const ENV_KEYS = [
  "VOBIZ_AUTH_ID",
  "VOBIZ_AUTH_TOKEN",
  "WHATSAPP_TEMPLATE_BOOKING_CONFIRMED_NAME",
  "WHATSAPP_TEMPLATE_BOOKING_CONFIRMED_LANGUAGE",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env["VOBIZ_AUTH_ID"] = "MA_TEST";
  process.env["VOBIZ_AUTH_TOKEN"] = "vobiz-test-token";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const NOW = new Date("2026-10-20T06:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const WA = "919876543210";
const BASIS = "Customers agree to WhatsApp updates when they book.";

type Row = Record<string, unknown>;
type ConsentFixture = { scope: string; action: string; minutesAgo: number }[];

function template(name: string, over: Row = {}): Row {
  return {
    id: `tpl-${name}`,
    organization_id: "org-a",
    whatsapp_connection_id: "conn-a",
    name,
    language: "en",
    category: "UTILITY",
    status: "APPROVED",
    body_text: "Hi {{1}} at {{2}} on {{3}}",
    body_param_count: 3,
    purpose: null,
    ...over,
  };
}

function seed(
  over: {
    notificationsEnabled?: boolean;
    basis?: string | null;
    inboundMinutesAgo?: number;
    templates?: Row[];
    consent?: ConsentFixture;
    suppressed?: boolean;
  } = {},
): Record<string, Row[]> {
  return {
    businesses: [
      { id: "biz-a", organization_id: "org-a", name: "Smile Dental", country: "IN" },
      { id: "biz-b", organization_id: "org-b", name: "Other Clinic", country: "IN" },
    ],
    whatsapp_connections: [
      {
        id: "conn-a",
        organization_id: "org-a",
        business_id: "biz-a",
        phone_number_id: "PN_A",
        status: "connected",
        provider: "vobiz",
        vobiz_channel_id: "ch-token-a",
        notifications_enabled: over.notificationsEnabled ?? true,
        transactional_consent_basis: over.basis === undefined ? BASIS : over.basis,
      },
      {
        id: "conn-b",
        organization_id: "org-b",
        business_id: "biz-b",
        phone_number_id: "PN_B",
        status: "connected",
        provider: "vobiz",
        vobiz_channel_id: "ch-token-b",
        notifications_enabled: true,
        transactional_consent_basis: BASIS,
      },
    ],
    whatsapp_conversations:
      over.inboundMinutesAgo === undefined
        ? []
        : [
            {
              id: "conv-a",
              organization_id: "org-a",
              whatsapp_connection_id: "conn-a",
              wa_id: WA,
              last_inbound_at: ago(over.inboundMinutesAgo),
            },
          ],
    whatsapp_templates: over.templates ?? [
      template("booking_ok", { purpose: "booking_confirmed" }),
      template("pay_ok", { purpose: "payment_link", body_text: "{{1}}", body_param_count: 1 }),
      template("promo", { category: "MARKETING", body_text: "Hi {{1}}", body_param_count: 1 }),
      template("their_promo", {
        organization_id: "org-b",
        whatsapp_connection_id: "conn-b",
        category: "MARKETING",
        body_text: "Hi {{1}}",
        body_param_count: 1,
      }),
    ],
    whatsapp_consent_events: (over.consent ?? []).map((c, i) => ({
      id: `ce-${i}`,
      organization_id: "org-a",
      business_id: "biz-a",
      wa_id: WA,
      scope: c.scope,
      action: c.action,
      source: "customer_form",
      created_at: ago(c.minutesAgo),
    })),
    whatsapp_suppressions: over.suppressed
      ? [{ organization_id: "org-a", business_id: "biz-a", wa_id: WA, reason: "blocked_by_user" }]
      : [],
  };
}

function fakeMeta(responses: (number | "timeout" | "no-id")[] = [200]) {
  const sent: Record<string, unknown>[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const r = responses[Math.min(i++, responses.length - 1)]!;
    sent.push(JSON.parse(String(init.body)));
    if (r === "timeout") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    if (r === "no-id") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    return new Response(
      JSON.stringify(
        r === 200
          ? {
              id: `vmsg.${sent.length}`,
              status: "pending",
              meta_message_id: `wamid.${sent.length}`,
            }
          : {},
      ),
      { status: r },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const BOOKING: BusinessMessageInput = {
  organizationId: "org-a",
  businessId: "biz-a",
  customerPhone: `+${WA}`,
  purpose: "booking_confirmed",
  scope: "transactional",
  idempotencyKey: "booking_confirmed:bk-1",
  bodyText: "Hi Asha, your appointment at Smile Dental is confirmed for Tue, 21 Oct, 10:00 am.",
  templateBodyParams: ["Asha", "Smile Dental", "Tue, 21 Oct, 10:00 am"],
};
const PAYMENT: BusinessMessageInput = {
  organizationId: "org-a",
  businessId: "biz-a",
  customerPhone: `+${WA}`,
  purpose: "payment_link",
  scope: "transactional",
  idempotencyKey: "payment_link:pr-1",
  bodyText: "Please complete your payment here: https://rzp.io/i/x",
};
const MARKETING: BusinessMessageInput = {
  organizationId: "org-a",
  businessId: "biz-a",
  customerPhone: `+${WA}`,
  purpose: "marketing",
  scope: "marketing",
  idempotencyKey: "campaign:c1:" + WA,
  bodyText: "[promo] Asha",
  templateBodyParams: ["Asha"],
  templateId: "tpl-promo",
  connectionId: "conn-a",
  forceTemplate: true,
};
const OPTED_IN_MARKETING = [{ scope: "marketing", action: "opt_in", minutesAgo: 60 }];

function world(over: Parameters<typeof seed>[0] = {}, options: FakeDbOptions = {}) {
  return createFakeDb(seed(over), { now: () => NOW, ...options });
}
const send = (
  db: ReturnType<typeof createFakeDb>,
  input: BusinessMessageInput,
  meta = fakeMeta(),
) =>
  sendBusinessWhatsAppMessage(db.client, input, {
    fetchImpl: meta.fetchImpl,
    sleep: async () => {},
    now: () => NOW,
  });
const outbound = (db: ReturnType<typeof createFakeDb>) =>
  db.rows("whatsapp_messages").filter((m) => m["direction"] === "outbound");

describe("purpose and consent scope", () => {
  test("marketing through the transactional scope is rejected before anything is read or sent", async () => {
    const db = world({ consent: OPTED_IN_MARKETING });
    const meta = fakeMeta();
    const result = await send(db, { ...MARKETING, scope: "transactional" }, meta);
    assert.equal(result.outcome, "failed");
    assert.equal(result.outcome === "failed" && result.code, "invalid_purpose_scope");
    assert.equal(result.outcome === "failed" && result.retryable, false);
    assert.equal(meta.sent.length, 0);
    assert.equal(db.log.length, 0, "no database access at all");
  });

  test("booking and payment purposes through the marketing scope are rejected", async () => {
    for (const input of [BOOKING, PAYMENT]) {
      const db = world({ consent: OPTED_IN_MARKETING });
      const meta = fakeMeta();
      const result = await send(db, { ...input, scope: "marketing" }, meta);
      assert.equal(
        result.outcome === "failed" && result.code,
        "invalid_purpose_scope",
        input.purpose,
      );
      assert.equal(meta.sent.length, 0);
    }
  });

  test("the rules themselves", () => {
    assert.equal(purposeScopeProblem("marketing", "marketing"), null);
    assert.equal(purposeScopeProblem("booking_reminder", "transactional"), null);
    assert.match(
      String(purposeScopeProblem("marketing", "transactional")),
      /marketing consent scope/,
    );
    assert.match(
      String(purposeScopeProblem("payment_failed", "marketing")),
      /transactional consent scope/,
    );
    assert.match(String(purposeScopeProblem("newsletter", "marketing")), /Unknown message purpose/);
    assert.equal(requiresNotificationSettings("booking_confirmed", true), true);
    assert.equal(requiresNotificationSettings("payment_link", false), true);
    assert.equal(requiresNotificationSettings("payment_link", true), false);
    assert.equal(requiresNotificationSettings("marketing", false), false);
  });
});

describe("business notification settings (re-read at send time)", () => {
  test("notifications off: booking notifications and business-initiated payment messages are not sent", async () => {
    for (const input of [BOOKING, PAYMENT]) {
      const db = world({ notificationsEnabled: false });
      const meta = fakeMeta();
      assert.deepEqual(await send(db, input, meta), {
        outcome: "skipped",
        reason: "notifications_disabled",
      });
      assert.equal(meta.sent.length, 0);
      assert.equal(db.rows("whatsapp_conversations").length, 0, "nothing written");
    }
  });

  test("no recorded consent basis (missing, blank or too short): not sent", async () => {
    for (const basis of [null, "", "   ", "yes they agreed"]) {
      const db = world({ basis });
      const meta = fakeMeta();
      assert.deepEqual(await send(db, BOOKING, meta), {
        outcome: "skipped",
        reason: "no_consent_basis",
      });
      assert.equal(meta.sent.length, 0);
    }
  });

  test("a booking notification needs the settings even inside the 24-hour window", async () => {
    const db = world({ notificationsEnabled: false, inboundMinutesAgo: 5 });
    assert.deepEqual(await send(db, BOOKING), {
      outcome: "skipped",
      reason: "notifications_disabled",
    });
  });

  test("a payment message inside a conversation the customer started is still allowed (a reply, not a notification)", async () => {
    const db = world({ notificationsEnabled: false, basis: null, inboundMinutesAgo: 5 });
    const meta = fakeMeta();
    const result = await send(db, PAYMENT, meta);
    assert.equal(result.outcome, "sent");
    assert.equal((meta.sent[0] as { type: string }).type, "text");
  });

  test("the business declaration never replaces the recipient's own opt-out or a suppression", async () => {
    for (const over of [
      { consent: [{ scope: "transactional", action: "opt_out", minutesAgo: 5 }] },
      { suppressed: true },
    ]) {
      for (const input of [BOOKING, PAYMENT]) {
        const db = world(over);
        const meta = fakeMeta();
        const result = await send(db, input, meta);
        assert.equal(result.outcome, "skipped", JSON.stringify(over));
        assert.equal(meta.sent.length, 0);
      }
    }
  });
});

describe("fail closed on database errors", () => {
  for (const table of [
    "whatsapp_connections",
    "businesses",
    "whatsapp_messages",
    "whatsapp_suppressions",
    "whatsapp_consent_events",
    "whatsapp_conversations",
    "whatsapp_templates",
  ]) {
    test(`a failing read of ${table} throws — nothing is sent or queued`, async () => {
      const db = world(
        { consent: OPTED_IN_MARKETING },
        {
          failWhen: (t, op) =>
            t === table && op === "select"
              ? { code: "08006", message: "connection failure" }
              : null,
        },
      );
      for (const input of [BOOKING, MARKETING]) {
        const meta = fakeMeta();
        await assert.rejects(send(db, input, meta));
        assert.equal(meta.sent.length, 0, `${table} / ${input.purpose}`);
      }
      assert.equal(outbound(db).length, 0);
    });
  }
});

describe("recipient consent", () => {
  test("marketing needs an explicit, current marketing opt-in", async () => {
    const cases: [ConsentFixture, string][] = [
      [[], "no_consent"],
      [[{ scope: "transactional", action: "opt_in", minutesAgo: 5 }], "no_consent"],
      [
        [
          { scope: "marketing", action: "opt_in", minutesAgo: 60 },
          { scope: "marketing", action: "opt_out", minutesAgo: 30 },
        ],
        "opted_out",
      ],
      [
        [
          { scope: "marketing", action: "opt_out", minutesAgo: 60 },
          { scope: "marketing", action: "opt_in", minutesAgo: 30 },
        ],
        "sent",
      ],
    ];
    for (const [consent, expected] of cases) {
      const db = world({ consent });
      const meta = fakeMeta();
      const result = await send(db, MARKETING, meta);
      assert.equal(
        result.outcome === "skipped" ? result.reason : result.outcome,
        expected,
        JSON.stringify(consent),
      );
      assert.equal(meta.sent.length, expected === "sent" ? 1 : 0);
    }
  });

  test("an opt-out and an opt-in at the same instant: the opt-out wins, whatever the row order", async () => {
    for (const order of [
      ["opt_in", "opt_out"],
      ["opt_out", "opt_in"],
    ]) {
      const db = world({
        consent: order.map((action) => ({ scope: "marketing", action, minutesAgo: 10 })),
      });
      const meta = fakeMeta();
      assert.deepEqual(await send(db, MARKETING, meta), {
        outcome: "skipped",
        reason: "opted_out",
      });
      assert.equal(meta.sent.length, 0);
    }
  });

  test("suppressed numbers get nothing business-initiated, opt-in or not", async () => {
    const db = world({ consent: OPTED_IN_MARKETING, suppressed: true });
    for (const input of [MARKETING, BOOKING, PAYMENT]) {
      assert.deepEqual(await send(db, input), { outcome: "skipped", reason: "suppressed" });
    }
  });
});

describe("a customer's STOP outranks staff opt-ins on every business-initiated path", () => {
  test("booking and payment notifications and campaign messages are skipped, on every retry", async () => {
    const db = world({ inboundMinutesAgo: 5 });
    db.rows("whatsapp_consent_events").push(
      ...["transactional", "marketing"].flatMap((scope, i) => [
        {
          id: `stop-${i}`,
          organization_id: "org-a",
          business_id: "biz-a",
          wa_id: WA,
          scope,
          action: "opt_out",
          source: "customer_keyword",
          created_at: ago(30),
        },
        {
          id: `staff-${i}`,
          organization_id: "org-a",
          business_id: "biz-a",
          wa_id: WA,
          scope,
          action: "opt_in",
          source: "staff_attested",
          evidence: "Customer said yes on the phone",
          created_at: ago(10),
        },
      ]),
    );
    const meta = fakeMeta();
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const input of [BOOKING, PAYMENT, MARKETING]) {
        assert.deepEqual(
          await send(db, input, meta),
          { outcome: "skipped", reason: "opted_out" },
          `${input.purpose} attempt ${attempt}`,
        );
      }
    }
    assert.equal(meta.sent.length, 0);
  });
});

describe("templates must be verifiably approved for this number and purpose", () => {
  const cases: [string, Parameters<typeof seed>[0], BusinessMessageInput, string][] = [
    [
      "mapped but PAUSED (no silent fallback)",
      { templates: [template("booking_ok", { purpose: "booking_confirmed", status: "PAUSED" })] },
      BOOKING,
      "template_not_approved",
    ],
    [
      "mapped but still PENDING",
      { templates: [template("booking_ok", { purpose: "booking_confirmed", status: "PENDING" })] },
      BOOKING,
      "template_not_approved",
    ],
    [
      "booking notification with a MARKETING template",
      {
        templates: [
          template("booking_ok", { purpose: "booking_confirmed", category: "MARKETING" }),
        ],
      },
      BOOKING,
      "template_wrong_category",
    ],
    [
      "campaign with a UTILITY template",
      {
        consent: OPTED_IN_MARKETING,
        templates: [template("promo", { body_text: "Hi {{1}}", body_param_count: 1 })],
      },
      MARKETING,
      "template_wrong_category",
    ],
    [
      "campaign naming another tenant's template",
      { consent: OPTED_IN_MARKETING },
      { ...MARKETING, templateId: "tpl-their_promo" },
      "template_not_found_for_number",
    ],
    [
      "campaign without a chosen template",
      { consent: OPTED_IN_MARKETING },
      { ...MARKETING, templateId: undefined },
      "template_missing",
    ],
    ["nothing mapped, no variable", { templates: [] }, BOOKING, "template_missing"],
    [
      "named parameters",
      {
        templates: [
          template("booking_ok", {
            purpose: "booking_confirmed",
            body_text: "Hi {{name}} {{2}} {{3}}",
          }),
        ],
      },
      BOOKING,
      "template_named_params",
    ],
    [
      "parameter count mismatch",
      {
        templates: [template("booking_ok", { purpose: "booking_confirmed", body_param_count: 2 })],
      },
      BOOKING,
      "template_param_mismatch",
    ],
  ];
  for (const [name, over, input, code] of cases) {
    test(`${name} → ${code}, nothing sent`, async () => {
      const db = world(over);
      const meta = fakeMeta();
      const result = await send(db, input, meta);
      assert.equal(result.outcome, "failed");
      assert.equal(result.outcome === "failed" && result.code, code);
      assert.equal(result.outcome === "failed" && result.retryable, false);
      assert.equal(meta.sent.length, 0);
      assert.deepEqual(
        outbound(db).map((m) => m["status"]),
        ["failed"],
        "recorded as failed with the reason, for staff",
      );
    });
  }

  test("an environment variable only selects a template; a name the registry doesn't have is never sent", async () => {
    process.env["WHATSAPP_TEMPLATE_BOOKING_CONFIRMED_NAME"] = "made_up_name";
    process.env["WHATSAPP_TEMPLATE_BOOKING_CONFIRMED_LANGUAGE"] = "en";
    const db = world({ templates: [] });
    const meta = fakeMeta();
    const result = await send(db, BOOKING, meta);
    assert.equal(result.outcome === "failed" && result.code, "template_not_found_for_number");
    assert.equal(meta.sent.length, 0);
  });

  test("…and a name the registry has as APPROVED UTILITY is used", async () => {
    process.env["WHATSAPP_TEMPLATE_BOOKING_CONFIRMED_NAME"] = "booking_ok";
    process.env["WHATSAPP_TEMPLATE_BOOKING_CONFIRMED_LANGUAGE"] = "en";
    const db = world({ templates: [template("booking_ok")] });
    const meta = fakeMeta();
    assert.equal((await send(db, BOOKING, meta)).outcome, "sent");
    assert.equal((meta.sent[0] as { template: { name: string } }).template.name, "booking_ok");
  });

  test("a registry row on another tenant's number is never used for this one, even by name", async () => {
    process.env["WHATSAPP_TEMPLATE_BOOKING_CONFIRMED_NAME"] = "booking_ok";
    process.env["WHATSAPP_TEMPLATE_BOOKING_CONFIRMED_LANGUAGE"] = "en";
    const db = world({
      templates: [
        template("booking_ok", { organization_id: "org-b", whatsapp_connection_id: "conn-b" }),
      ],
    });
    const meta = fakeMeta();
    assert.equal((await send(db, BOOKING, meta)).outcome, "failed");
    assert.equal(meta.sent.length, 0);
  });
});

describe("idempotency and delivery", () => {
  test("the same key is sent once — sequentially and concurrently", async () => {
    const db = world();
    const meta = fakeMeta();
    const results = await Promise.all([send(db, BOOKING, meta), send(db, BOOKING, meta)]);
    await send(db, BOOKING, meta);
    assert.equal(meta.sent.length, 1);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ["sent", "skipped_duplicate"]);
  });

  test("an unknown outcome (timeout, or 200 without a message id) stays live: a later attempt never sends it again", async () => {
    for (const first of ["timeout", "no-id"] as const) {
      const db = world();
      const meta = fakeMeta([first, 200]);
      const r1 = await send(db, BOOKING, meta);
      assert.equal(r1.outcome === "failed" && r1.retryable, false, first);
      const [row] = outbound(db);
      assert.equal(row!["status"], "queued", "still counts as live for its key");
      assert.match(String(row!["error_message"]), /outcome unknown/);
      const r2 = await send(db, BOOKING, meta);
      assert.deepEqual(r2, { outcome: "skipped_duplicate", existingStatus: "queued" });
      assert.equal(meta.sent.length, 1, "Meta was called exactly once");
    }
  });

  test("a definite rejection frees the key: a corrected retry can send", async () => {
    const db = world();
    const meta = fakeMeta([400, 200]);
    assert.equal((await send(db, BOOKING, meta)).outcome, "failed");
    assert.equal(outbound(db)[0]!["status"], "failed");
    assert.equal((await send(db, BOOKING, meta)).outcome, "sent");
  });
});

describe("a business with more than one connected number", () => {
  /** A second number for biz-a, connected later, with its own synced templates. */
  function twoNumbers(
    over: Parameters<typeof seed>[0] = {},
    second: Row = {},
    conversations: Row[] = [],
  ) {
    const s = seed(over);
    s["whatsapp_connections"]![0]!["created_at"] = ago(10_000);
    s["whatsapp_connections"]!.push({
      id: "conn-a2",
      organization_id: "org-a",
      business_id: "biz-a",
      phone_number_id: "PN_A2",
      status: "connected",
      provider: "vobiz",
      vobiz_channel_id: "ch-token-a2",
      notifications_enabled: true,
      transactional_consent_basis: BASIS,
      created_at: ago(100),
      ...second,
    });
    s["whatsapp_templates"]!.push(
      template("booking_ok_2", {
        id: "tpl-booking_ok_2",
        whatsapp_connection_id: "conn-a2",
        purpose: "booking_confirmed",
      }),
    );
    s["whatsapp_conversations"]!.push(...conversations);
    return createFakeDb(s, { now: () => NOW });
  }
  const sentFrom = (db: ReturnType<typeof createFakeDb>) =>
    outbound(db).map((m) => m["whatsapp_connection_id"]);

  test("notifications still go out, from one deterministic number (the earliest connected)", async () => {
    for (let i = 0; i < 2; i++) {
      const db = twoNumbers();
      const meta = fakeMeta();
      const r = await send(db, BOOKING, meta);
      assert.equal(r.outcome, "sent");
      assert.deepEqual(sentFrom(db), ["conn-a"]);
      assert.equal(meta.sent.length, 1);
    }
  });

  test("the number the customer is already talking to is used", async () => {
    const db = twoNumbers({}, {}, [
      {
        id: "conv-a2",
        organization_id: "org-a",
        whatsapp_connection_id: "conn-a2",
        wa_id: WA,
        last_inbound_at: ago(30),
      },
    ]);
    assert.equal((await send(db, BOOKING)).outcome, "sent");
    assert.deepEqual(sentFrom(db), ["conn-a2"]);
  });

  test("booking and payment notifications only go from a number with notifications turned on", async () => {
    const db = twoNumbers({ notificationsEnabled: false });
    assert.equal((await send(db, BOOKING)).outcome, "sent");
    assert.deepEqual(sentFrom(db), ["conn-a2"]);
  });

  test("the idempotency key covers every number: a retry after the customer messages the other number sends nothing more", async () => {
    const db = twoNumbers();
    const meta = fakeMeta();
    assert.equal((await send(db, BOOKING, meta)).outcome, "sent");
    db.rows("whatsapp_conversations").push({
      id: "conv-a2",
      organization_id: "org-a",
      whatsapp_connection_id: "conn-a2",
      wa_id: WA,
      last_inbound_at: ago(5),
    });
    const again = await send(db, BOOKING, meta);
    assert.equal(again.outcome, "skipped_duplicate");
    assert.equal(meta.sent.length, 1);
  });
});

describe("tenant isolation", () => {
  test("a business that isn't the organization's has no number to send from", async () => {
    const db = world();
    const meta = fakeMeta();
    assert.deepEqual(await send(db, { ...BOOKING, businessId: "biz-b" }, meta), {
      outcome: "skipped",
      reason: "no_connection",
    });
    assert.equal(meta.sent.length, 0);
  });

  test("pinning another business's connection doesn't borrow it", async () => {
    const db = world({ consent: OPTED_IN_MARKETING });
    const meta = fakeMeta();
    assert.deepEqual(await send(db, { ...MARKETING, connectionId: "conn-b" }, meta), {
      outcome: "skipped",
      reason: "no_connection",
    });
    assert.equal(meta.sent.length, 0);
  });
});

describe("valid flows still work", () => {
  test("booking notification outside the window: the mapped approved UTILITY template", async () => {
    const db = world();
    const meta = fakeMeta();
    assert.equal((await send(db, BOOKING, meta)).outcome, "sent");
    const body = meta.sent[0] as {
      to: string;
      template: { name: string; components: { parameters: { text: string }[] }[] };
    };
    assert.equal(body.to, `+${WA}`);
    assert.equal(body.template.name, "booking_ok");
    assert.deepEqual(
      body.template.components[0]!.parameters.map((p) => p.text),
      BOOKING.templateBodyParams,
    );
  });

  test("payment link outside the window: its 1-parameter template", async () => {
    const db = world();
    const meta = fakeMeta();
    assert.equal((await send(db, PAYMENT, meta)).outcome, "sent");
    assert.equal((meta.sent[0] as { template: { name: string } }).template.name, "pay_ok");
  });

  test("campaign message to an opted-in number: the chosen MARKETING template, even inside the window", async () => {
    const db = world({ consent: OPTED_IN_MARKETING, inboundMinutesAgo: 5 });
    const meta = fakeMeta();
    assert.equal((await send(db, MARKETING, meta)).outcome, "sent");
    assert.equal(
      (meta.sent[0] as { type: string; template: { name: string } }).template.name,
      "promo",
    );
  });
});
