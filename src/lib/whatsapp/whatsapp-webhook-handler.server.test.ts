import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleWhatsAppWebhookPost } from "./whatsapp-webhook-handler.server.ts";
import { signVobizWebhookBody } from "./vobiz-webhook.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

/**
 * Runtime tests of the webhook POST handler with real Request objects, the
 * real signature check and inbound processing, against the in-memory
 * database. The deliveries are Vobiz-shaped fixtures (MOCKED provider).
 */

const SECRET = "whsec-handler-test";

function delivery(eventId: string, messageId: string, text = "Hello") {
  return JSON.stringify({
    event_id: eventId,
    event_type: "message.inbound",
    account_id: "MA_TEST",
    occurred_at: "2026-10-27T10:00:00Z",
    payload: {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: "PN_A" },
      contacts: [{ profile: { name: "Asha" }, wa_id: "919800000001" }],
      messages: [
        {
          id: messageId,
          from: "919800000001",
          type: "text",
          timestamp: "1793095200",
          text: { body: text },
        },
      ],
    },
  });
}

function request(body: string, signature: string | null) {
  return new Request("https://app.clickai.in/api/public/webhooks/whatsapp", {
    method: "POST",
    headers: signature ? { "x-webhook-signature": signature } : {},
    body,
  });
}

function harness(options: Parameters<typeof createFakeDb>[1] = {}) {
  const db = createFakeDb(
    {
      whatsapp_connections: [
        { id: "conn-a", organization_id: "org-a", phone_number_id: "PN_A", status: "connected" },
      ],
    },
    options,
  );
  const replies: string[][] = [];
  const deps = {
    getSupabaseAdmin: async () => db.client,
    secret: SECRET,
    replyInBackground: (_db: unknown, ids: string[]) => void replies.push(ids),
  };
  return { db, replies, deps };
}

describe("authentication", () => {
  test("an unsigned, wrongly signed or Meta-style signed delivery is 401 and nothing is stored", async () => {
    const body = delivery("e1", "wamid.1");
    for (const sig of [
      null,
      signVobizWebhookBody(body, "wrong"),
      `sha256=${signVobizWebhookBody(body, SECRET)}`,
    ]) {
      const { db, deps, replies } = harness();
      const res = await handleWhatsAppWebhookPost(request(body, sig), deps);
      assert.equal(res.status, 401);
      assert.equal(db.log.length, 0, "the database is never touched");
      assert.equal(replies.length, 0);
    }
  });

  test("without a configured secret every delivery is refused", async () => {
    const body = delivery("e1", "wamid.1");
    const { deps } = harness();
    const res = await handleWhatsAppWebhookPost(request(body, signVobizWebhookBody(body, "")), {
      ...deps,
      secret: null,
    });
    assert.equal(res.status, 401);
  });
});

describe("processing", () => {
  test("a valid delivery is stored and handed to the AI exactly once; a redelivery is a duplicate", async () => {
    const { db, deps, replies } = harness();
    const body = delivery("evt-1", "wamid.1");
    const first = await handleWhatsAppWebhookPost(
      request(body, signVobizWebhookBody(body, SECRET)),
      deps,
    );
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { outcome: "processed" });
    const again = await handleWhatsAppWebhookPost(
      request(body, signVobizWebhookBody(body, SECRET)),
      deps,
    );
    assert.deepEqual(await again.json(), { outcome: "duplicate" });
    assert.equal(db.rows("whatsapp_messages").length, 1);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.length, 1);
  });

  test("concurrent deliveries of the same message store it once and reply once", async () => {
    const { db, deps, replies } = harness();
    const a = delivery("evt-a", "wamid.same");
    const b = delivery("evt-b", "wamid.same");
    await Promise.all([
      handleWhatsAppWebhookPost(request(a, signVobizWebhookBody(a, SECRET)), deps),
      handleWhatsAppWebhookPost(request(b, signVobizWebhookBody(b, SECRET)), deps),
    ]);
    assert.equal(db.rows("whatsapp_messages").length, 1);
    assert.equal(replies.flat().length, 1);
  });

  test("a storage failure answers 500 (so Vobiz retries), releases the claim, and logs no payload", async () => {
    let fail = true;
    const { db, deps } = harness({
      failWhen: (table, op) =>
        fail && table === "whatsapp_messages" && op === "insert"
          ? { code: "08006", message: "connection failure" }
          : null,
    });
    const body = delivery("evt-x", "wamid.x", "my secret appointment details");
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(JSON.stringify(args));
    try {
      const res = await handleWhatsAppWebhookPost(
        request(body, signVobizWebhookBody(body, SECRET)),
        deps,
      );
      assert.equal(res.status, 500);
    } finally {
      console.error = original;
    }
    assert.equal(db.rows("webhook_events").length, 0, "claim released for the retry");
    assert.ok(logged.every((l) => !l.includes("secret appointment")));
    fail = false;
    const retry = await handleWhatsAppWebhookPost(
      request(body, signVobizWebhookBody(body, SECRET)),
      deps,
    );
    assert.deepEqual(await retry.json(), { outcome: "processed" });
  });

  test("a delivery for an unknown number is acknowledged and stores nothing", async () => {
    const { db, deps, replies } = harness();
    const body = delivery("evt-u", "wamid.u").replace('"PN_A"', '"PN_UNKNOWN"');
    const res = await handleWhatsAppWebhookPost(
      request(body, signVobizWebhookBody(body, SECRET)),
      deps,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { outcome: "ignored" });
    assert.equal(db.rows("whatsapp_messages").length, 0);
    assert.equal(replies.length, 0);
  });
});
