import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  WEBHOOK_MAX_ATTEMPTS,
  processVobizWhatsAppWebhook,
  replayDueVobizWebhookEvents,
} from "./whatsapp-inbound.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

/**
 * Inbound processing of Vobiz deliveries: the envelope (event_id,
 * event_type, payload) wraps the WhatsApp Cloud API change value. The
 * signature check itself is in vobiz-webhook.server.test.ts and the route.
 */

const ORG_A = "org-a";
const ORG_B = "org-b";

function seed() {
  return {
    whatsapp_connections: [
      { id: "conn-a", organization_id: ORG_A, phone_number_id: "PN_A", status: "connected" },
      { id: "conn-b", organization_id: ORG_B, phone_number_id: "PN_B", status: "connected" },
      { id: "conn-old", organization_id: ORG_B, phone_number_id: "PN_OLD", status: "disconnected" },
    ],
  };
}

function textMessage(id: string, body: string, timestamp = "1735000000", from = "919876543210") {
  return { id, from, type: "text", timestamp, text: { body } };
}

let eventSeq = 0;
/** A Vobiz delivery for one Cloud API change value; a fixed eventId models a redelivery. */
function webhook(phoneNumberId: string, value: Record<string, unknown>, eventId?: string) {
  return JSON.stringify({
    event_id: eventId ?? `evt-${++eventSeq}`,
    event_type: "statuses" in value ? "message.status" : "message.inbound",
    account_id: "MA_TEST",
    occurred_at: "2026-10-27T10:00:00Z",
    payload: {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: phoneNumberId },
      ...value,
    },
  });
}

const run = (client: never, rawBody: string) => processVobizWhatsAppWebhook(client, { rawBody });

describe("processVobizWhatsAppWebhook — inbound messages", () => {
  test("stores a new inbound text under the connection's own organization and reports it for an AI reply", async () => {
    const db = createFakeDb(seed());
    const result = await run(
      db.client,
      webhook("PN_A", {
        contacts: [{ profile: { name: "Asha" }, wa_id: "919876543210" }],
        messages: [textMessage("wamid.1", "Hi, is my slot confirmed?")],
      }),
    );
    assert.equal(result.outcome, "processed");
    const [msg] = db.rows("whatsapp_messages");
    assert.equal(msg!["organization_id"], ORG_A);
    assert.equal(msg!["whatsapp_connection_id"], "conn-a");
    assert.equal(msg!["direction"], "inbound");
    assert.equal(msg!["status"], "received");
    assert.deepEqual(result.newInboundTextMessageIds, [msg!["id"]]);
    const [conv] = db.rows("whatsapp_conversations");
    assert.equal(conv!["organization_id"], ORG_A);
    assert.equal(conv!["customer_display_name"], "Asha");
    assert.equal(conv!["last_inbound_at"], new Date(1735000000 * 1000).toISOString());
    assert.equal(conv!["last_message_preview"], "Hi, is my slot confirmed?");
    assert.ok(db.log.every((c) => c.table !== "payment_requests" && c.table !== "bookings"));
  });

  test("an exact redelivery is a duplicate: nothing stored twice, nothing reported for a reply", async () => {
    const db = createFakeDb(seed());
    const body = webhook("PN_A", { messages: [textMessage("wamid.1", "Hello")] }, "same");
    await run(db.client, body);
    const again = await run(db.client, body);
    assert.deepEqual(again, {
      outcome: "duplicate",
      newInboundTextMessageIds: [],
      eventType: "message.inbound",
    });
    assert.equal(db.rows("whatsapp_messages").length, 1);
  });

  test("the same message in a different event (a retried or re-batched delivery) is stored once and not re-reported", async () => {
    const db = createFakeDb(seed());
    const first = await run(
      db.client,
      webhook("PN_A", { messages: [textMessage("wamid.1", "Hello")] }),
    );
    const second = await run(
      db.client,
      webhook("PN_A", {
        messages: [textMessage("wamid.1", "Hello"), textMessage("wamid.2", "Also…", "1735000100")],
      }),
    );
    assert.equal(first.newInboundTextMessageIds.length, 1);
    assert.equal(second.newInboundTextMessageIds.length, 1, "only wamid.2 is new");
    assert.equal(db.rows("whatsapp_messages").length, 2);
  });

  test("non-text messages are stored but never reported for an AI reply", async () => {
    const db = createFakeDb(seed());
    const result = await run(
      db.client,
      webhook("PN_A", {
        messages: [
          { id: "wamid.img", from: "91999", type: "image", timestamp: "1735000000" },
          { id: "wamid.x", from: "91999", type: "sticker", timestamp: "1735000000" },
        ],
      }),
    );
    assert.deepEqual(result.newInboundTextMessageIds, []);
    assert.deepEqual(
      db
        .rows("whatsapp_messages")
        .map((m) => m["message_type"])
        .sort(),
      ["image", "unsupported"],
    );
  });

  test("a late, out-of-order message never moves the 24-hour window start backwards", async () => {
    const db = createFakeDb(seed());
    await run(
      db.client,
      webhook("PN_A", { messages: [textMessage("wamid.new", "newer", "1735000500")] }),
    );
    await run(
      db.client,
      webhook("PN_A", { messages: [textMessage("wamid.old", "older", "1735000000")] }),
    );
    const [conv] = db.rows("whatsapp_conversations");
    assert.equal(conv!["last_inbound_at"], new Date(1735000500 * 1000).toISOString());
    assert.equal(conv!["last_message_preview"], "newer");
  });

  test("the tenant comes only from phone_number_id: an unknown or disconnected number stores nothing (the event is kept for a retry)", async () => {
    const db = createFakeDb(seed());
    const original = console.warn;
    console.warn = () => {};
    try {
      for (const pn of ["unknown-id", "PN_OLD"]) {
        const result = await run(
          db.client,
          webhook(pn, {
            messages: [textMessage(`wamid.${pn}`, "hi")],
            statuses: [{ id: "w1", status: "sent" }],
          }),
        );
        assert.equal(result.outcome, "deferred");
      }
    } finally {
      console.warn = original;
    }
    assert.equal(db.rows("whatsapp_messages").length, 0);
    assert.equal(db.rows("whatsapp_conversations").length, 0);
    for (const e of db.rows("webhook_events")) {
      assert.equal(e["processed_at"], null, "never marked processed");
      assert.equal(e["error"], "no_live_connection");
      assert.ok(e["next_attempt_at"], "a retry is scheduled");
    }
  });

  test("malformed payloads are ignored without throwing", async () => {
    const db = createFakeDb(seed());
    for (const raw of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ entry: "x" }),
      JSON.stringify({ entry: [{ changes: [null, { value: 3 }, { value: { metadata: {} } }] }] }),
      webhook("PN_A", { messages: [{ type: "text", text: { body: "no id or sender" } }] }),
      webhook("PN_A", { statuses: [{ status: "delivered" }, { id: "w", status: "bogus" }] }),
    ]) {
      const result = await run(db.client, raw);
      assert.notEqual(result.outcome, "duplicate");
      assert.deepEqual(result.newInboundTextMessageIds, []);
    }
    assert.equal(db.rows("whatsapp_messages").length, 0);
  });

  test("partial failure: the event stays due and the error propagates so Vobiz's retry is processed", async () => {
    let failMessages = true;
    const db = createFakeDb(seed(), {
      failWhen: (table, op) =>
        failMessages && table === "whatsapp_messages" && op === "insert"
          ? { code: "08006", message: "connection failure" }
          : null,
    });
    const body = webhook("PN_A", { messages: [textMessage("wamid.1", "Hello")] }, "e1");
    await assert.rejects(run(db.client, body));
    const [kept] = db.rows("webhook_events");
    assert.equal(kept!["processed_at"], null);
    assert.equal(kept!["error"], "retryable:08006");
    assert.ok(new Date(String(kept!["next_attempt_at"])).getTime() <= Date.now(), "due again now");
    failMessages = false;
    const retry = await run(db.client, body);
    assert.equal(retry.outcome, "processed");
    assert.equal(retry.newInboundTextMessageIds.length, 1);
    assert.ok(db.rows("webhook_events")[0]!["processed_at"]);
  });
});

describe("processVobizWhatsAppWebhook — envelope", () => {
  test("call.* and unknown events are acknowledged and ignored, never stored", async () => {
    const db = createFakeDb(seed());
    for (const eventType of ["call.connect", "contact.updated"]) {
      const raw = JSON.stringify({
        event_id: `x-${eventType}`,
        event_type: eventType,
        payload: { metadata: { phone_number_id: "PN_A" }, messages: [textMessage("wamid.c", "x")] },
      });
      const result = await run(db.client, raw);
      assert.equal(result.outcome, "ignored");
      assert.equal(result.eventType, eventType);
    }
    assert.equal(db.rows("whatsapp_messages").length, 0);
    assert.equal(db.rows("webhook_events").length, 0);
  });

  test("a body that isn't a Vobiz envelope is kept as unrecognized, never applied or guessed at", async () => {
    const db = createFakeDb(seed());
    const original = console.error;
    console.error = () => {};
    try {
      for (const raw of [
        "not json",
        JSON.stringify({ entry: [] }),
        JSON.stringify({ event_id: "e" }),
      ]) {
        assert.equal((await run(db.client, raw)).outcome, "unrecognized");
      }
    } finally {
      console.error = original;
    }
    assert.equal(db.rows("whatsapp_messages").length, 0);
    const kept = db.rows("webhook_events");
    assert.equal(kept.length, 3);
    for (const e of kept) {
      assert.equal(e["provider"], "vobiz_whatsapp_unrecognized");
      assert.match(String(e["event_id"]), /^sha256:[0-9a-f]{64}$/);
      assert.equal(e["error"], "unrecognized_envelope");
      assert.equal(e["processed_at"], null);
      assert.equal(e["next_attempt_at"], null, "never replayed automatically");
    }
  });

  test("the event is claimed under Vobiz's event_id with its event_type", async () => {
    const db = createFakeDb(seed());
    await run(
      db.client,
      webhook("PN_A", { messages: [textMessage("wamid.9", "Hi")] }, "evt-claim"),
    );
    const [claim] = db.rows("webhook_events");
    assert.equal(claim!["provider"], "vobiz_whatsapp");
    assert.equal(claim!["event_id"], "evt-claim");
    assert.equal(claim!["event_type"], "message.inbound");
  });
});

describe("processVobizWhatsAppWebhook — delivery statuses", () => {
  function withOutbound(status: string, connection = "conn-a", org = ORG_A) {
    const s = seed() as Record<string, Record<string, unknown>[]>;
    s["whatsapp_messages"] = [
      {
        id: "out-1",
        organization_id: org,
        whatsapp_connection_id: connection,
        conversation_id: "c",
        direction: "outbound",
        message_type: "text",
        wa_message_id: "wamid.OUT",
        status,
      },
    ];
    return createFakeDb(s);
  }

  test("moves a sent message forward through delivered and read", async () => {
    const db = withOutbound("sent");
    await run(db.client, webhook("PN_A", { statuses: [{ id: "wamid.OUT", status: "delivered" }] }));
    assert.equal(db.rows("whatsapp_messages")[0]!["status"], "delivered");
    await run(db.client, webhook("PN_A", { statuses: [{ id: "wamid.OUT", status: "read" }] }));
    assert.equal(db.rows("whatsapp_messages")[0]!["status"], "read");
  });

  test("never moves backwards: a late 'delivered' or 'sent' can't undo 'read', and 'failed' can't undo 'delivered'", async () => {
    const db = withOutbound("read");
    await run(
      db.client,
      webhook("PN_A", {
        statuses: [
          { id: "wamid.OUT", status: "delivered" },
          { id: "wamid.OUT", status: "sent" },
        ],
      }),
    );
    assert.equal(db.rows("whatsapp_messages")[0]!["status"], "read");
    const db2 = withOutbound("delivered");
    await run(db2.client, webhook("PN_A", { statuses: [{ id: "wamid.OUT", status: "failed" }] }));
    assert.equal(db2.rows("whatsapp_messages")[0]!["status"], "delivered");
  });

  test("a 'failed' status records Meta's short reason, never the raw payload", async () => {
    const db = withOutbound("sent");
    await run(
      db.client,
      webhook("PN_A", {
        statuses: [
          {
            id: "wamid.OUT",
            status: "failed",
            errors: [
              {
                code: 131047,
                title: "Re-engagement message",
                error_data: { details: "secret-ish" },
              },
            ],
          },
        ],
      }),
    );
    const row = db.rows("whatsapp_messages")[0]!;
    assert.equal(row["status"], "failed");
    assert.equal(row["error_message"], "Re-engagement message (131047)");
  });

  test("a status is applied only within the connection the payload names (no cross-tenant update by message id)", async () => {
    const db = withOutbound("sent", "conn-b", ORG_B);
    await run(db.client, webhook("PN_A", { statuses: [{ id: "wamid.OUT", status: "read" }] }));
    assert.equal(db.rows("whatsapp_messages")[0]!["status"], "sent");
  });

  test("unknown status values are skipped, never written", async () => {
    const db = withOutbound("sent");
    await run(db.client, webhook("PN_A", { statuses: [{ id: "wamid.OUT", status: "deleted" }] }));
    assert.equal(db.rows("whatsapp_messages")[0]!["status"], "sent");
  });
});

describe("Meta's 'user stopped marketing messages' signal", () => {
  test("a failed status with error 131050 records a marketing opt-out for that number and business", async () => {
    const s = seed() as Record<string, Record<string, unknown>[]>;
    s["whatsapp_connections"]![0]!["business_id"] = "biz-a";
    s["whatsapp_messages"] = [
      {
        id: "out-1",
        organization_id: ORG_A,
        whatsapp_connection_id: "conn-a",
        conversation_id: "c",
        direction: "outbound",
        message_type: "template",
        wa_message_id: "wamid.MKT",
        status: "sent",
      },
    ];
    const db = createFakeDb(s);
    await run(
      db.client,
      webhook("PN_A", {
        statuses: [
          {
            id: "wamid.MKT",
            status: "failed",
            recipient_id: "919876543210",
            timestamp: "1792656000",
            errors: [{ code: 131050, title: "User has stopped marketing messages" }],
          },
        ],
      }),
    );
    assert.deepEqual(
      db
        .rows("whatsapp_consent_events")
        .map((e) => [e["business_id"], e["wa_id"], e["scope"], e["action"], e["source"]]),
      [["biz-a", "919876543210", "marketing", "opt_out", "meta_signal"]],
    );
    // Ordered by when Meta reported it, not when the webhook was processed.
    assert.equal(db.rows("whatsapp_consent_events")[0]!["created_at"], "2026-10-22T08:00:00.000Z");
  });

  test("other failures record nothing", async () => {
    const s = seed() as Record<string, Record<string, unknown>[]>;
    s["whatsapp_connections"]![0]!["business_id"] = "biz-a";
    const db = createFakeDb(s);
    await run(
      db.client,
      webhook("PN_A", {
        statuses: [
          { id: "w", status: "failed", recipient_id: "919876543210", errors: [{ code: 131026 }] },
        ],
      }),
    );
    assert.equal(db.rows("whatsapp_consent_events").length, 0);
  });
});

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const [err, warn] = [console.error, console.warn];
  console.error = (...a: unknown[]) => void logged.push(a);
  console.warn = (...a: unknown[]) => void logged.push(a);
  try {
    return { value: await fn(), logged };
  } finally {
    console.error = err;
    console.warn = warn;
  }
}

describe("Vobiz payload mismatches are kept, never silently dropped or applied", () => {
  test("a signed body that isn't the documented envelope is kept by its hash and logged by key names only", async () => {
    const db = createFakeDb(seed());
    const raw = JSON.stringify({
      id: "x",
      type: "message",
      data: { from: "+919800000001", text: "hi" },
    });
    const { value, logged } = await captureLogs(() => run(db.client, raw));
    assert.equal(value.outcome, "unrecognized");
    assert.deepEqual(logged, [
      ["whatsapp_webhook:envelope_unrecognized", { keys: ["id", "type", "data"] }],
    ]);
    assert.doesNotMatch(JSON.stringify(logged), /919800000001|hi"/);
    // A redelivery of the same bytes is the same row, not a second one.
    await captureLogs(() => run(db.client, raw));
    assert.equal(db.rows("webhook_events").length, 1);
  });

  test("Quick Start's flat shape (top-level channel_id, flat message, no event_id) is not confirmed: kept, not applied", async () => {
    const db = createFakeDb(seed());
    const flat = JSON.stringify({
      type: "message.inbound",
      channel_id: "ch-a",
      message: { from: "919800000001", type: "text", text: { body: "hi" } },
    });
    const { value } = await captureLogs(() => run(db.client, flat));
    assert.equal(value.outcome, "unrecognized");
    assert.equal(db.rows("whatsapp_messages").length, 0);
    assert.equal(db.rows("webhook_events")[0]!["provider"], "vobiz_whatsapp_unrecognized");
  });

  test("an envelope whose payload has no metadata.phone_number_id is retained for an operator, never routed", async () => {
    const db = createFakeDb(seed());
    const body = JSON.stringify({
      event_id: "evt-shape-1",
      event_type: "message.inbound",
      payload: { messages: [{ id: "wamid.1", from: "919800000001" }] },
    });
    const { value, logged } = await captureLogs(() => run(db.client, body));
    assert.equal(value.outcome, "retained");
    assert.deepEqual(logged, [
      [
        "whatsapp_webhook:payload_without_phone_number_id",
        { eventId: "evt-shape-1", keys: ["messages"] },
      ],
    ]);
    const [e] = db.rows("webhook_events");
    assert.equal(e!["error"], "missing_phone_number_id");
    assert.equal(e!["processed_at"], null);
    assert.equal(e!["next_attempt_at"], null, "terminal: not replayed automatically");
    assert.equal(db.rows("whatsapp_messages").length, 0);
  });
});

describe("channel_id is only a cross-check, never the routing key", () => {
  const withChannels = () =>
    createFakeDb({
      whatsapp_connections: [
        {
          id: "conn-a",
          organization_id: ORG_A,
          phone_number_id: "PN_A",
          vobiz_channel_id: "ch-a",
          status: "connected",
        },
        {
          id: "conn-b",
          organization_id: ORG_B,
          phone_number_id: "PN_B",
          vobiz_channel_id: "ch-b",
          status: "connected",
        },
      ],
    });
  const delivery = (
    eventId: string,
    extra: Record<string, unknown>,
    payload: Record<string, unknown> = {},
  ) =>
    JSON.stringify({
      event_id: eventId,
      event_type: "message.inbound",
      ...extra,
      payload: { messages: [textMessage(`wamid.${eventId}`, "hello")], ...payload },
    });

  test("channel_id without phone_number_id routes nowhere (retained)", async () => {
    const db = withChannels();
    const { value } = await captureLogs(() =>
      run(db.client, delivery("evt-ch-only", { channel_id: "ch-a" })),
    );
    assert.equal(value.outcome, "retained");
    assert.equal(db.rows("whatsapp_messages").length, 0);
  });

  test("phone_number_id of one tenant and channel_id of another: retained, never guessed", async () => {
    const db = withChannels();
    const { value, logged } = await captureLogs(() =>
      run(
        db.client,
        delivery("evt-conflict", { channel_id: "ch-b" }, { metadata: { phone_number_id: "PN_A" } }),
      ),
    );
    assert.equal(value.outcome, "retained");
    assert.equal(db.rows("whatsapp_messages").length, 0);
    assert.deepEqual(logged, [
      [
        "whatsapp_webhook:routing_conflict",
        { eventId: "evt-conflict", phoneNumberId: "PN_A", channelId: "ch-b" },
      ],
    ]);
    assert.equal(db.rows("webhook_events")[0]!["error"], "routing_conflict");
  });

  test("an unknown channel_id next to a known phone_number_id is a conflict too", async () => {
    const db = withChannels();
    const { value } = await captureLogs(() =>
      run(
        db.client,
        delivery(
          "evt-unknown-ch",
          { channel_id: "ch-zzz" },
          { metadata: { phone_number_id: "PN_A" } },
        ),
      ),
    );
    assert.equal(value.outcome, "retained");
    assert.equal(db.rows("whatsapp_messages").length, 0);
  });

  test("both identifiers agreeing route normally (envelope or payload placement)", async () => {
    for (const [i, extra, payload] of [
      [1, { channel_id: "ch-b" }, { metadata: { phone_number_id: "PN_B" } }],
      [2, {}, { channel_id: "ch-b", metadata: { phone_number_id: "PN_B" } }],
    ] as const) {
      const db = withChannels();
      const r = await run(db.client, delivery(`evt-agree-${i}`, extra, payload));
      assert.equal(r.outcome, "processed");
      assert.equal(db.rows("whatsapp_messages")[0]!["organization_id"], ORG_B);
    }
  });
});

describe("events that arrive before their connection exists are replayed, boundedly", () => {
  test("deferred until the connection is saved, then the replay stores it once for that organization", async () => {
    const db = createFakeDb({ whatsapp_connections: [] });
    const t0 = new Date("2026-10-28T10:00:00Z");
    const body = webhook(
      "PN_NEW",
      { messages: [textMessage("wamid.early", "first!")] },
      "evt-early",
    );
    const { value } = await captureLogs(() =>
      processVobizWhatsAppWebhook(db.client, { rawBody: body, now: t0 }),
    );
    assert.equal(value.outcome, "deferred");
    // Not due yet: nothing replays.
    const notYet = await replayDueVobizWebhookEvents(db.client, {
      now: new Date(t0.getTime() + 30_000),
    });
    assert.equal(notYet.processed, 0);
    // Onboarding saves the connection.
    db.rows("whatsapp_connections").push({
      id: "conn-new",
      organization_id: ORG_A,
      phone_number_id: "PN_NEW",
      status: "connected",
    });
    const r = await replayDueVobizWebhookEvents(db.client, {
      now: new Date(t0.getTime() + 61_000),
    });
    assert.equal(r.processed, 1);
    assert.equal(r.newInboundTextMessageIds.length, 1);
    const [msg] = db.rows("whatsapp_messages");
    assert.equal(msg!["organization_id"], ORG_A);
    assert.ok(db.rows("webhook_events")[0]!["processed_at"]);
    // Replaying again, or Vobiz redelivering, changes nothing.
    const again = await replayDueVobizWebhookEvents(db.client, {
      now: new Date(t0.getTime() + 3_600_000),
    });
    assert.equal(again.examined, 0);
    assert.equal((await run(db.client, body)).outcome, "duplicate");
    assert.equal(db.rows("whatsapp_messages").length, 1);
  });

  test(`an event that never becomes routable is retried at most ${WEBHOOK_MAX_ATTEMPTS} times, then retained`, async () => {
    const db = createFakeDb({ whatsapp_connections: [] });
    let now = new Date("2026-10-28T10:00:00Z");
    await captureLogs(() =>
      processVobizWhatsAppWebhook(db.client, {
        rawBody: webhook("PN_NEVER", { messages: [textMessage("wamid.n", "x")] }, "evt-never"),
        now,
      }),
    );
    let replays = 0;
    for (let i = 0; i < 50; i++) {
      now = new Date(now.getTime() + 7 * 3_600_000);
      const r = await captureLogs(() => replayDueVobizWebhookEvents(db.client, { now }));
      replays += r.value.examined;
    }
    const [e] = db.rows("webhook_events");
    assert.equal(e!["attempts"], WEBHOOK_MAX_ATTEMPTS);
    assert.equal(replays, WEBHOOK_MAX_ATTEMPTS - 1);
    assert.equal(e!["error"], "gave_up:no_live_connection");
    assert.equal(e!["next_attempt_at"], null);
    assert.equal(e!["processed_at"], null);
  });

  test("a redelivery of a deferred event is another attempt; a redelivery while another worker holds it is a duplicate", async () => {
    const db = createFakeDb({ whatsapp_connections: [] });
    const t0 = new Date("2026-10-28T10:00:00Z");
    const body = webhook("PN_LATE", { messages: [textMessage("wamid.late", "x")] }, "evt-late");
    await captureLogs(() => processVobizWhatsAppWebhook(db.client, { rawBody: body, now: t0 }));
    db.rows("whatsapp_connections").push({
      id: "conn-late",
      organization_id: ORG_B,
      phone_number_id: "PN_LATE",
      status: "connected",
    });
    const r = await processVobizWhatsAppWebhook(db.client, {
      rawBody: body,
      now: new Date(t0.getTime() + 120_000),
    });
    assert.equal(r.outcome, "processed");
    assert.equal(db.rows("whatsapp_messages")[0]!["organization_id"], ORG_B);

    // In-flight: a fresh claim (lease not expired) makes a concurrent redelivery a duplicate.
    const db2 = createFakeDb(seed());
    db2.rows("webhook_events").push({
      id: "row-1",
      provider: "vobiz_whatsapp",
      event_id: "evt-held",
      event_type: "message.inbound",
      payload: JSON.parse(webhook("PN_A", { messages: [textMessage("wamid.h", "x")] }, "evt-held")),
      attempts: 1,
      processed_at: null,
      error: null,
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
      created_at: new Date().toISOString(),
    });
    const held = await run(
      db2.client,
      webhook("PN_A", { messages: [textMessage("wamid.h", "x")] }, "evt-held"),
    );
    assert.equal(held.outcome, "duplicate");
    assert.equal(db2.rows("whatsapp_messages").length, 0);
  });

  test("concurrent deliveries of one event store its message once", async () => {
    const db = createFakeDb(seed());
    const body = webhook("PN_A", { messages: [textMessage("wamid.c", "hi")] }, "evt-concurrent");
    const results = await Promise.all([
      run(db.client, body),
      run(db.client, body),
      run(db.client, body),
    ]);
    assert.equal(results.filter((r) => r.outcome === "processed").length, 1);
    assert.equal(db.rows("whatsapp_messages").length, 1);
    assert.equal(
      results.flatMap((r) => r.newInboundTextMessageIds).length,
      1,
      "one AI reply at most",
    );
  });

  test("a replayed opt-out status records the consent signal once", async () => {
    const db = createFakeDb({
      whatsapp_connections: [
        {
          id: "conn-a",
          organization_id: ORG_A,
          business_id: "biz-a",
          phone_number_id: "PN_A",
          status: "connected",
        },
      ],
      whatsapp_messages: [
        {
          id: "m1",
          whatsapp_connection_id: "conn-a",
          organization_id: ORG_A,
          direction: "outbound",
          status: "sent",
          wa_message_id: "wamid.out",
        },
      ],
    });
    const failed = {
      statuses: [
        {
          id: "wamid.out",
          status: "failed",
          recipient_id: "919800000001",
          timestamp: "1735000100",
          errors: [{ code: 131050, title: "Opted out" }],
        },
        { id: "wamid.notyet", status: "sent" },
      ],
    };
    const t0 = new Date("2026-10-28T10:00:00Z");
    await captureLogs(() =>
      processVobizWhatsAppWebhook(db.client, {
        rawBody: webhook("PN_A", failed, "evt-opt"),
        now: t0,
      }),
    );
    await captureLogs(() =>
      replayDueVobizWebhookEvents(db.client, { now: new Date(t0.getTime() + 61_000) }),
    );
    assert.equal(db.rows("whatsapp_consent_events").length, 1);
  });
});

describe("delivery statuses that match no stored message are kept and retried", () => {
  const statusDelivery = (eventId: string, wamid: string, status: string, pn = "PN_A") =>
    JSON.stringify({
      event_id: eventId,
      event_type: "message.status",
      payload: {
        metadata: { phone_number_id: pn },
        statuses: [{ id: wamid, status, timestamp: "1735000100", recipient_id: "919800000001" }],
      },
    });
  const outbound = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    whatsapp_connection_id: "conn-a",
    organization_id: ORG_A,
    direction: "outbound",
    status: "sent",
    wa_message_id: null,
    ...over,
  });

  test("a status for an unknown wamid is deferred and logged by ids only; nothing changes", async () => {
    const db = createFakeDb({ ...seed(), whatsapp_messages: [outbound()] });
    const { value, logged } = await captureLogs(() =>
      run(db.client, statusDelivery("evt-st-1", "wamid.UNKNOWN", "delivered")),
    );
    assert.equal(value.outcome, "deferred");
    assert.deepEqual(logged, [
      [
        "whatsapp_webhook:status_unmatched",
        { eventId: "evt-st-1", connectionId: "conn-a", unmatched: 1 },
      ],
    ]);
    assert.equal(db.rows("whatsapp_messages")[0]!["status"], "sent");
    assert.doesNotMatch(JSON.stringify(logged), /919800000001/);
  });

  test("a status that arrives before the send was recorded is applied on replay once the wamid is stored", async () => {
    const db = createFakeDb({ ...seed(), whatsapp_messages: [outbound({ status: "queued" })] });
    const t0 = new Date("2026-10-28T10:00:00Z");
    await captureLogs(() =>
      processVobizWhatsAppWebhook(db.client, {
        rawBody: statusDelivery("evt-early-st", "wamid.X", "delivered"),
        now: t0,
      }),
    );
    assert.equal(db.rows("whatsapp_messages")[0]!["status"], "queued");
    // The send's response is recorded.
    Object.assign(db.rows("whatsapp_messages")[0]!, { status: "sent", wa_message_id: "wamid.X" });
    const r = await replayDueVobizWebhookEvents(db.client, {
      now: new Date(t0.getTime() + 61_000),
    });
    assert.equal(r.processed, 1);
    assert.equal(db.rows("whatsapp_messages")[0]!["status"], "delivered");
  });

  test("out of order: a late 'delivered' after 'read' never moves the message back", async () => {
    const db = createFakeDb({
      ...seed(),
      whatsapp_messages: [outbound({ wa_message_id: "wamid.R" })],
    });
    await run(db.client, statusDelivery("evt-r", "wamid.R", "read"));
    const late = await run(db.client, statusDelivery("evt-d", "wamid.R", "delivered"));
    assert.equal(late.outcome, "processed", "stale, not unmatched");
    assert.equal(db.rows("whatsapp_messages")[0]!["status"], "read");
  });

  test("a known message advances; a late, older status is a no-op and not reported as unmatched", async () => {
    const db = createFakeDb({
      ...seed(),
      whatsapp_messages: [outbound({ wa_message_id: "wamid.K" })],
    });
    const { value, logged } = await captureLogs(async () => {
      await run(db.client, statusDelivery("evt-st-2", "wamid.K", "read"));
      return run(db.client, statusDelivery("evt-st-3", "wamid.K", "delivered"));
    });
    assert.equal(value.outcome, "processed");
    assert.equal(db.rows("whatsapp_messages")[0]!["status"], "read");
    assert.equal(logged.length, 0);
  });

  test("a failure status records Meta's reason on the message", async () => {
    const db = createFakeDb({
      ...seed(),
      whatsapp_messages: [outbound({ wa_message_id: "wamid.F" })],
    });
    await run(
      db.client,
      JSON.stringify({
        event_id: "evt-f",
        event_type: "message.status",
        payload: {
          metadata: { phone_number_id: "PN_A" },
          statuses: [
            {
              id: "wamid.F",
              status: "failed",
              errors: [{ code: 131047, title: "Re-engagement message" }],
            },
          ],
        },
      }),
    );
    const [m] = db.rows("whatsapp_messages");
    assert.equal(m!["status"], "failed");
    assert.equal(m!["error_message"], "Re-engagement message (131047)");
  });

  test("a status naming another connection's wamid never updates that organization's message", async () => {
    const db = createFakeDb({
      ...seed(),
      whatsapp_messages: [
        outbound({
          id: "mb",
          whatsapp_connection_id: "conn-b",
          organization_id: ORG_B,
          wa_message_id: "wamid.B",
        }),
      ],
    });
    const { value } = await captureLogs(() =>
      run(db.client, statusDelivery("evt-x", "wamid.B", "read", "PN_A")),
    );
    assert.equal(value.outcome, "deferred");
    assert.equal(db.rows("whatsapp_messages")[0]!["status"], "sent");
  });
});
