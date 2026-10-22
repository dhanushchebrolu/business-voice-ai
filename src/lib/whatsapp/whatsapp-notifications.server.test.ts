import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  processDueNotifications,
  enqueueDueReminders,
  bookingNotificationText,
  MAX_ATTEMPTS,
  STALE_AFTER_MS,
} from "./whatsapp-notifications.server.ts";
import { sendWhatsAppPaymentMessage } from "./whatsapp-payments.server.ts";
import { encryptCredential } from "./whatsapp-token-crypto.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

/**
 * The notification outbox worker, against the in-memory database (rows as
 * the 20261020090000 triggers would enqueue them) and a fake Meta.
 */

const ENV = {
  META_APP_ID: "test-app",
  META_APP_SECRET: "test-secret",
  META_WHATSAPP_CONFIG_ID: "test-config",
  META_GRAPH_API_VERSION: "v23.0",
};
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [...Object.keys(ENV), "WHATSAPP_CREDENTIAL_ENCRYPTION_KEY"])
    saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  process.env["WHATSAPP_CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const NOW = new Date("2026-10-20T06:00:00.000Z");
const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function fakeMeta(statuses: (number | "timeout")[] = [200]) {
  const sent: Record<string, unknown>[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const status = statuses[Math.min(i++, statuses.length - 1)]!;
    if (status === "timeout") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    sent.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify(status === 200 ? { messages: [{ id: `wamid.N${sent.length}` }] } : {}),
      { status },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const TEMPLATES: Record<string, unknown>[] = (
  ["booking_confirmed", "booking_rescheduled", "booking_cancelled", "booking_reminder"] as const
).map((purpose) => ({
  organization_id: "org-a",
  whatsapp_connection_id: "conn-a",
  name: `${purpose}_v1`,
  language: "en",
  category: "UTILITY",
  status: "APPROVED",
  purpose,
  body_param_count: 3,
}));
// Payment templates as synced from Meta (one body parameter each). The
// WHATSAPP_TEMPLATE_PAYMENT_*_NAME variables used below only select them.
TEMPLATES.push(
  ...(
    [
      ["payment_link_v1", "payment_link"],
      ["payment_ok_v1", "payment_confirmation"],
    ] as const
  ).map(([name]) => ({
    organization_id: "org-a",
    whatsapp_connection_id: "conn-a",
    name,
    language: "en_US",
    category: "UTILITY",
    status: "APPROVED",
    purpose: null,
    body_param_count: 1,
  })),
);

function seed(over: { notificationsEnabled?: boolean; booking?: Record<string, unknown> } = {}) {
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
        notifications_enabled: over.notificationsEnabled ?? true,
        transactional_consent_basis: "Customers agree to WhatsApp updates when they book.",
        access_token_ciphertext: encryptCredential("token-a"),
      },
    ],
    whatsapp_templates: TEMPLATES,
    bookings: [
      {
        id: "bk-1",
        organization_id: "org-a",
        business_id: "biz-a",
        status: "CONFIRMED",
        source: "voice",
        start_at: inHours(30),
        end_at: inHours(30.5),
        timezone: "Asia/Kolkata",
        customer_name: "Asha Rao",
        customer_phone: "+919876543210",
        created_at: ago(5),
        ...over.booking,
      },
    ],
  };
}

function notification(kind: string, over: Record<string, unknown> = {}) {
  return {
    id: `n-${kind}`,
    organization_id: "org-a",
    business_id: "biz-a",
    booking_id: "bk-1",
    kind,
    dedupe_key: `${kind}:bk-1`,
    payload: { start_at: inHours(30) },
    created_at: ago(1),
    next_attempt_at: ago(1),
    ...over,
  };
}

const run = (db: ReturnType<typeof createFakeDb>, meta = fakeMeta(), now = NOW) =>
  processDueNotifications(db.client, {
    fetchImpl: meta.fetchImpl,
    sleep: async () => {},
    now: () => now,
  });
const row = (db: ReturnType<typeof createFakeDb>, id: string) =>
  db.rows("whatsapp_notifications").find((n) => n["id"] === id)!;

describe("booking notifications", () => {
  test("voice booking → WhatsApp confirmation through the approved template, with name/business/time parameters", async () => {
    const db = createFakeDb(
      { ...seed(), whatsapp_notifications: [notification("booking_confirmed")] },
      { now: () => NOW },
    );
    const meta = fakeMeta();
    const counts = await run(db, meta);
    assert.equal(counts.sent, 1);
    assert.equal(meta.sent.length, 1);
    const body = meta.sent[0] as {
      to: string;
      type: string;
      template: { name: string; components: { parameters: { text: string }[] }[] };
    };
    assert.equal(body.to, "919876543210");
    assert.equal(body.type, "template");
    assert.equal(body.template.name, "booking_confirmed_v1");
    const params = body.template.components[0]!.parameters.map((p) => p.text);
    assert.equal(params[0], "Asha");
    assert.equal(params[1], "Smile Dental");
    assert.match(params[2]!, /21 Oct/);
    const n = row(db, "n-booking_confirmed");
    assert.equal(n["status"], "sent");
    assert.ok(n["whatsapp_message_id"]);
    assert.equal(n["attempts"], 1);
  });

  test("each notification is sent at most once: a second run, and two concurrent workers, send nothing more", async () => {
    const db = createFakeDb(
      { ...seed(), whatsapp_notifications: [notification("booking_confirmed")] },
      { now: () => NOW },
    );
    const meta = fakeMeta();
    await Promise.all([run(db, meta), run(db, meta)]);
    await run(db, meta);
    assert.equal(meta.sent.length, 1);
  });

  test("state is re-read before sending: a cancelled booking gets no confirmation; a moved booking gets no stale reschedule or reminder", async () => {
    const cases: [Record<string, unknown>, ReturnType<typeof notification>][] = [
      [{ status: "CANCELLED" }, notification("booking_confirmed")],
      [{ start_at: inHours(40) }, notification("booking_rescheduled")],
      [{ start_at: inHours(40) }, notification("booking_reminder")],
      [{ status: "CONFIRMED" }, notification("booking_cancelled")],
      [{ start_at: ago(60), end_at: ago(30) }, notification("booking_confirmed")],
    ];
    for (const [booking, n] of cases) {
      const db = createFakeDb(
        { ...seed({ booking }), whatsapp_notifications: [n] },
        { now: () => NOW },
      );
      const meta = fakeMeta();
      await run(db, meta);
      assert.equal(meta.sent.length, 0, JSON.stringify(booking));
      assert.equal(row(db, n.id)["status"], "skipped");
      assert.equal(row(db, n.id)["skip_reason"], "superseded");
    }
  });

  test("cancellation and reschedule messages are sent for the current state", async () => {
    for (const [kind, booking] of [
      ["booking_cancelled", { status: "CANCELLED" }],
      ["booking_rescheduled", { status: "RESCHEDULED" }],
    ] as const) {
      const db = createFakeDb(
        { ...seed({ booking }), whatsapp_notifications: [notification(kind)] },
        { now: () => NOW },
      );
      const meta = fakeMeta();
      await run(db, meta);
      assert.equal(meta.sent.length, 1, kind);
      assert.equal((meta.sent[0] as { template: { name: string } }).template.name, `${kind}_v1`);
    }
  });

  test("notifications turned off, a stale row, an opted-out or suppressed customer: skipped, never sent", async () => {
    const scenarios: [
      Parameters<typeof seed>[0],
      Record<string, unknown>,
      Record<string, unknown[]>,
      string,
    ][] = [
      [{ notificationsEnabled: false }, {}, {}, "notifications_disabled"],
      [
        {},
        { created_at: new Date(NOW.getTime() - STALE_AFTER_MS - 60_000).toISOString() },
        {},
        "stale",
      ],
      [
        {},
        {},
        {
          whatsapp_consent_events: [
            {
              organization_id: "org-a",
              business_id: "biz-a",
              wa_id: "919876543210",
              scope: "transactional",
              action: "opt_out",
              source: "customer_keyword",
              created_at: ago(10),
            },
          ],
        },
        "opted_out",
      ],
      [
        {},
        {},
        {
          whatsapp_suppressions: [
            {
              organization_id: "org-a",
              business_id: "biz-a",
              wa_id: "919876543210",
              reason: "staff",
            },
          ],
        },
        "suppressed",
      ],
    ];
    for (const [seedOver, rowOver, extra, reason] of scenarios) {
      const db = createFakeDb(
        {
          ...seed(seedOver),
          ...extra,
          whatsapp_notifications: [notification("booking_confirmed", rowOver)],
        },
        { now: () => NOW },
      );
      const meta = fakeMeta();
      await run(db, meta);
      assert.equal(meta.sent.length, 0, reason);
      assert.equal(row(db, "n-booking_confirmed")["skip_reason"], reason);
    }
  });

  test("a row naming another tenant's booking is not sent (all reads are scoped by the row's organization and business)", async () => {
    const db = createFakeDb(
      {
        ...seed(),
        whatsapp_notifications: [
          notification("booking_confirmed", { organization_id: "org-b", business_id: "biz-b" }),
        ],
      },
      { now: () => NOW },
    );
    const meta = fakeMeta();
    await run(db, meta);
    assert.equal(meta.sent.length, 0);
    assert.equal(row(db, "n-booking_confirmed")["status"], "skipped");
  });

  test("Meta 5xx: retried later with backoff, then sent once", async () => {
    const db = createFakeDb(
      { ...seed(), whatsapp_notifications: [notification("booking_confirmed")] },
      { now: () => NOW },
    );
    const failing = fakeMeta([503]);
    const first = await run(db, failing);
    assert.equal(first.retry, 1);
    const n = row(db, "n-booking_confirmed");
    assert.equal(n["status"], "pending");
    assert.ok(new Date(String(n["next_attempt_at"])).getTime() > NOW.getTime());
    assert.equal((await run(db, fakeMeta())).sent, 0, "not due yet");
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const meta = fakeMeta();
    assert.equal((await run(db, meta, later)).sent, 1);
    assert.equal(meta.sent.length, 1);
  });

  test("retries are bounded: after MAX_ATTEMPTS the row is failed", async () => {
    const db = createFakeDb(
      {
        ...seed(),
        whatsapp_notifications: [notification("booking_confirmed", { attempts: MAX_ATTEMPTS - 1 })],
      },
      { now: () => NOW },
    );
    await run(db, fakeMeta([503]));
    assert.equal(row(db, "n-booking_confirmed")["status"], "failed");
  });

  test("an unknown outcome (timeout) or a rejection is never retried — Meta may already have delivered it", async () => {
    for (const status of ["timeout", 400] as const) {
      const db = createFakeDb(
        { ...seed(), whatsapp_notifications: [notification("booking_confirmed")] },
        { now: () => NOW },
      );
      await run(db, fakeMeta([status]));
      assert.equal(row(db, "n-booking_confirmed")["status"], "failed", String(status));
    }
  });

  test("no approved template mapped: failed with the reason, nothing sent", async () => {
    const s = seed();
    s.whatsapp_templates = [];
    const db = createFakeDb(
      { ...s, whatsapp_notifications: [notification("booking_confirmed")] },
      { now: () => NOW },
    );
    const meta = fakeMeta();
    await run(db, meta);
    assert.equal(meta.sent.length, 0);
    assert.equal(row(db, "n-booking_confirmed")["status"], "failed");
    assert.match(String(row(db, "n-booking_confirmed")["last_error"]), /template/i);
  });

  test("an abandoned 'sending' claim is picked up again; a fresh one is left alone", async () => {
    const db = createFakeDb(
      {
        ...seed(),
        whatsapp_notifications: [
          notification("booking_confirmed", { status: "sending", locked_at: ago(10), attempts: 1 }),
          notification("booking_cancelled", {
            id: "n-fresh",
            dedupe_key: "x",
            status: "sending",
            locked_at: ago(1),
            attempts: 1,
          }),
        ],
      },
      { now: () => NOW },
    );
    const counts = await run(db);
    assert.equal(counts.sent, 1);
    assert.equal(counts.busy, 1);
  });
});

describe("reminders", () => {
  test("enqueued once for active bookings starting in ~24h with notifications on, then sent", async () => {
    const s = seed({
      booking: { start_at: inHours(23.5), end_at: inHours(24), created_at: ago(600) },
    });
    (s.bookings as Record<string, unknown>[]).push(
      { ...s.bookings[0], id: "bk-new", created_at: ago(10) }, // just booked: confirmation suffices
      { ...s.bookings[0], id: "bk-far", start_at: inHours(48), created_at: ago(600) },
      { ...s.bookings[0], id: "bk-cancelled", status: "CANCELLED", created_at: ago(600) },
      {
        ...s.bookings[0],
        id: "bk-other",
        organization_id: "org-b",
        business_id: "biz-b",
        created_at: ago(600),
      },
    );
    const db = createFakeDb(s, { now: () => NOW });
    assert.equal(await enqueueDueReminders(db.client, NOW), 2, "bk-1 and bk-other are in range");
    await enqueueDueReminders(db.client, NOW);
    const queued = db.rows("whatsapp_notifications");
    assert.deepEqual(
      queued.map((n) => n["booking_id"]),
      ["bk-1"],
      "biz-b has notifications off; no duplicates",
    );
    const meta = fakeMeta();
    await run(db, meta);
    assert.equal(
      (meta.sent[0] as { template: { name: string } }).template.name,
      "booking_reminder_v1",
    );
  });
});

describe("payment notifications", () => {
  function paymentSeed(prStatus: string, bookingStatus: string) {
    return {
      ...seed({ booking: { status: bookingStatus } }),
      payment_requests: [
        {
          id: "pr-1",
          organization_id: "org-a",
          business_id: "biz-a",
          booking_id: "bk-1",
          status: prStatus,
          amount_minor_units: 50000,
          currency: "INR",
          payment_link_url: "https://rzp.io/i/abc",
        },
      ],
    };
  }
  const prNotification = (kind: string) =>
    notification(kind, { id: `n-${kind}`, payment_request_id: "pr-1", dedupe_key: `${kind}:pr-1` });

  test("payment link: sent for an open request on a held booking; never for a paid or closed one", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_v1";
    try {
      const open = createFakeDb(
        {
          ...paymentSeed("CREATED", "PENDING_PAYMENT"),
          whatsapp_notifications: [prNotification("payment_link")],
        },
        { now: () => NOW },
      );
      const meta = fakeMeta();
      await run(open, meta);
      assert.equal(meta.sent.length, 1);
      const params = (
        meta.sent[0] as { template: { components: { parameters: { text: string }[] }[] } }
      ).template.components[0]!.parameters;
      assert.match(params[0]!.text, /https:\/\/rzp\.io\/i\/abc/);

      for (const [pr, booking] of [
        ["CAPTURED", "CONFIRMED"],
        ["EXPIRED", "PAYMENT_EXPIRED"],
      ]) {
        const db = createFakeDb(
          {
            ...paymentSeed(pr!, booking!),
            whatsapp_notifications: [prNotification("payment_link")],
          },
          { now: () => NOW },
        );
        const m = fakeMeta();
        await run(db, m);
        assert.equal(m.sent.length, 0, pr);
        assert.equal(row(db, "n-payment_link")["skip_reason"], "superseded");
      }
    } finally {
      delete process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"];
    }
  });

  test("recovery after the inline send: the worker finds the message already sent and sends nothing more", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_v1";
    try {
      const db = createFakeDb(
        {
          ...paymentSeed("CREATED", "PENDING_PAYMENT"),
          whatsapp_notifications: [prNotification("payment_link")],
        },
        { now: () => NOW },
      );
      const meta = fakeMeta();
      // request_payment's inline send:
      await sendWhatsAppPaymentMessage(
        db.client,
        {
          organizationId: "org-a",
          businessId: "biz-a",
          bookingId: "bk-1",
          paymentRequestId: "pr-1",
          customerPhone: "+919876543210",
          purpose: "payment_link",
          bodyText: "Please complete your payment here: https://rzp.io/i/abc",
        },
        meta.fetchImpl,
      );
      await run(db, meta);
      assert.equal(meta.sent.length, 1);
      assert.equal(row(db, "n-payment_link")["status"], "sent");
    } finally {
      delete process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"];
    }
  });

  test("payment failed: 'try again' is sent only while the link is still payable — never after the customer has paid", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_FAILED_NAME"] = "payment_ok_v1";
    try {
      const open = createFakeDb(
        {
          ...paymentSeed("PENDING", "PENDING_PAYMENT"),
          whatsapp_notifications: [prNotification("payment_failed")],
        },
        { now: () => NOW },
      );
      const meta = fakeMeta();
      await run(open, meta);
      assert.equal(meta.sent.length, 1);

      // A retried outbox row processed after the customer paid on the same
      // link (or after the request was closed) must not say it failed.
      for (const [pr, booking] of [
        ["CAPTURED", "CONFIRMED"],
        ["CANCELLED", "CANCELLED"],
        ["EXPIRED", "PAYMENT_EXPIRED"],
      ]) {
        const db = createFakeDb(
          {
            ...paymentSeed(pr!, booking!),
            whatsapp_notifications: [prNotification("payment_failed")],
          },
          { now: () => NOW },
        );
        const m = fakeMeta();
        await run(db, m);
        assert.equal(m.sent.length, 0, pr);
        assert.equal(row(db, "n-payment_failed")["status"], "skipped", pr);
      }
    } finally {
      delete process.env["WHATSAPP_TEMPLATE_PAYMENT_FAILED_NAME"];
    }
  });

  test("payment captured on a booking that was cancelled meanwhile: no 'your booking is confirmed'", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_CONFIRMATION_NAME"] = "payment_ok_v1";
    try {
      const db = createFakeDb(
        {
          ...paymentSeed("CAPTURED", "CANCELLED"),
          whatsapp_notifications: [prNotification("payment_captured")],
        },
        { now: () => NOW },
      );
      const meta = fakeMeta();
      await run(db, meta);
      assert.equal(meta.sent.length, 0);
      assert.equal(row(db, "n-payment_captured")["status"], "skipped");
    } finally {
      delete process.env["WHATSAPP_TEMPLATE_PAYMENT_CONFIRMATION_NAME"];
    }
  });

  test("payment captured: the confirmation reads current state and is sent once", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_CONFIRMATION_NAME"] = "payment_ok_v1";
    try {
      const db = createFakeDb(
        {
          ...paymentSeed("CAPTURED", "CONFIRMED"),
          whatsapp_notifications: [prNotification("payment_captured")],
        },
        { now: () => NOW },
      );
      const meta = fakeMeta();
      await run(db, meta);
      await run(db, meta);
      assert.equal(meta.sent.length, 1);
      const text = (
        meta.sent[0] as { template: { components: { parameters: { text: string }[] }[] } }
      ).template.components[0]!.parameters[0]!.text;
      assert.match(
        text,
        /Payment received! Your booking .* is confirmed\. Amount paid: INR 500\.00/,
      );
    } finally {
      delete process.env["WHATSAPP_TEMPLATE_PAYMENT_CONFIRMATION_NAME"];
    }
  });
});

describe("bookingNotificationText", () => {
  test("first name or 'there', business, local time", () => {
    const t = bookingNotificationText("booking_reminder", {
      customerName: null,
      businessName: "Smile Dental",
      startAt: "2026-10-21T04:30:00.000Z",
      timezone: "Asia/Kolkata",
    });
    assert.equal(t.templateBodyParams[0], "there");
    assert.match(
      t.bodyText,
      /^Hi there, this is a reminder of your appointment at Smile Dental on .*10:00/,
    );
  });
});
