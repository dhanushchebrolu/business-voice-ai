import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  verifyWebhookHandshake,
  verifyWhatsAppWebhookSignature,
  processInboundWhatsAppWebhook,
} from "./whatsapp-inbound.server.ts";
import { signMetaWebhookBody } from "../meta/meta-webhook-signature.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("verifyWebhookHandshake", () => {
  test("returns the challenge when mode is subscribe and the token matches", () => {
    process.env["WHATSAPP_WEBHOOK_VERIFY_TOKEN"] = "secret-token";
    try {
      const result = verifyWebhookHandshake({
        mode: "subscribe",
        verifyToken: "secret-token",
        challenge: "12345",
      });
      assert.equal(result, "12345");
    } finally {
      resetEnv();
    }
  });

  test("returns null when the token does not match", () => {
    process.env["WHATSAPP_WEBHOOK_VERIFY_TOKEN"] = "secret-token";
    try {
      const result = verifyWebhookHandshake({
        mode: "subscribe",
        verifyToken: "wrong-token",
        challenge: "12345",
      });
      assert.equal(result, null);
    } finally {
      resetEnv();
    }
  });

  test("returns null when mode is not subscribe", () => {
    process.env["WHATSAPP_WEBHOOK_VERIFY_TOKEN"] = "secret-token";
    try {
      const result = verifyWebhookHandshake({
        mode: "unsubscribe",
        verifyToken: "secret-token",
        challenge: "12345",
      });
      assert.equal(result, null);
    } finally {
      resetEnv();
    }
  });

  test("returns null when the env var is not configured, never accidentally matching an empty token", () => {
    delete process.env["WHATSAPP_WEBHOOK_VERIFY_TOKEN"];
    const result = verifyWebhookHandshake({
      mode: "subscribe",
      verifyToken: "",
      challenge: "12345",
    });
    assert.equal(result, null);
  });
});

describe("verifyWhatsAppWebhookSignature", () => {
  test("verifies against META_APP_SECRET and fails closed without it", () => {
    const body = '{"entry":[]}';
    process.env["META_APP_SECRET"] = "app-secret";
    try {
      assert.equal(
        verifyWhatsAppWebhookSignature(body, signMetaWebhookBody(body, "app-secret")),
        true,
      );
      assert.equal(verifyWhatsAppWebhookSignature(body, signMetaWebhookBody(body, "nope")), false);
      assert.equal(verifyWhatsAppWebhookSignature(body, null), false);
    } finally {
      resetEnv();
    }
    delete process.env["META_APP_SECRET"];
    assert.equal(verifyWhatsAppWebhookSignature(body, signMetaWebhookBody(body, "")), false);
    resetEnv();
  });
});

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

function webhook(phoneNumberId: string, value: Record<string, unknown>) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          { field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, ...value } },
        ],
      },
    ],
  });
}

let eventSeq = 0;
const run = (client: never, rawBody: string) =>
  processInboundWhatsAppWebhook(client, { rawBody, eventId: `evt-${++eventSeq}` });

describe("processInboundWhatsAppWebhook — inbound messages", () => {
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
    const body = webhook("PN_A", { messages: [textMessage("wamid.1", "Hello")] });
    await processInboundWhatsAppWebhook(db.client, { rawBody: body, eventId: "same" });
    const again = await processInboundWhatsAppWebhook(db.client, {
      rawBody: body,
      eventId: "same",
    });
    assert.deepEqual(again, { outcome: "duplicate", newInboundTextMessageIds: [] });
    assert.equal(db.rows("whatsapp_messages").length, 1);
  });

  test("the same message in a different payload (Meta batches differently on retry) is stored once and not re-reported", async () => {
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

  test("the tenant comes only from phone_number_id: an unknown or disconnected number stores nothing", async () => {
    const db = createFakeDb(seed());
    for (const pn of ["unknown-id", "PN_OLD"]) {
      const result = await run(
        db.client,
        webhook(pn, {
          messages: [textMessage(`wamid.${pn}`, "hi")],
          statuses: [{ id: "w1", status: "sent" }],
        }),
      );
      assert.equal(result.outcome, "ignored");
    }
    assert.equal(db.rows("whatsapp_messages").length, 0);
    assert.equal(db.rows("whatsapp_conversations").length, 0);
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

  test("partial failure: the claim is released and the error propagates so Meta's retry is processed", async () => {
    let failMessages = true;
    const db = createFakeDb(seed(), {
      failWhen: (table, op) =>
        failMessages && table === "whatsapp_messages" && op === "insert"
          ? { code: "08006", message: "connection failure" }
          : null,
    });
    const body = webhook("PN_A", { messages: [textMessage("wamid.1", "Hello")] });
    await assert.rejects(
      processInboundWhatsAppWebhook(db.client, { rawBody: body, eventId: "e1" }),
    );
    assert.equal(db.rows("webhook_events").length, 0, "claim released");
    failMessages = false;
    const retry = await processInboundWhatsAppWebhook(db.client, { rawBody: body, eventId: "e1" });
    assert.equal(retry.outcome, "processed");
    assert.equal(retry.newInboundTextMessageIds.length, 1);
    assert.ok(db.rows("webhook_events")[0]!["processed_at"]);
  });
});

describe("processInboundWhatsAppWebhook — delivery statuses", () => {
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
