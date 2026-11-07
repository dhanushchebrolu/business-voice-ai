import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseVobizWebhookEnvelope,
  signVobizWebhookBody,
  verifyVobizWebhookSignature,
} from "./vobiz-webhook.server.ts";

const SECRET = "whsec-test-secret";
const BODY = JSON.stringify({
  event_id: "evt-1",
  event_type: "message.inbound",
  account_id: "MA_TEST",
  occurred_at: "2026-10-27T10:00:00Z",
  payload: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "919876543210", phone_number_id: "PN_A" },
    contacts: [{ profile: { name: "Asha" }, wa_id: "919800000001" }],
    messages: [
      {
        id: "wamid.IN1",
        from: "919800000001",
        type: "text",
        timestamp: "1793095200",
        text: { body: "Hi" },
      },
    ],
  },
});

describe("X-Webhook-Signature (hex HMAC-SHA256 of the raw body, no prefix)", () => {
  test("accepts Vobiz's exact format, in either hex case", () => {
    const sig = signVobizWebhookBody(BODY, SECRET);
    assert.match(sig, /^[0-9a-f]{64}$/);
    assert.ok(verifyVobizWebhookSignature(BODY, sig, SECRET));
    assert.ok(verifyVobizWebhookSignature(BODY, sig.toUpperCase(), SECRET));
  });

  test("rejects a different secret, a changed body, a sha256= prefix, and malformed headers", () => {
    const sig = signVobizWebhookBody(BODY, SECRET);
    assert.ok(!verifyVobizWebhookSignature(BODY, signVobizWebhookBody(BODY, "other"), SECRET));
    assert.ok(!verifyVobizWebhookSignature(BODY + " ", sig, SECRET));
    assert.ok(!verifyVobizWebhookSignature(BODY, `sha256=${sig}`, SECRET));
    for (const header of [null, undefined, "", "abc", sig.slice(0, 63), "z".repeat(64)]) {
      assert.ok(!verifyVobizWebhookSignature(BODY, header, SECRET), String(header));
    }
  });

  test("fails closed without a configured secret, even for a body signed with an empty one", () => {
    const sig = signVobizWebhookBody(BODY, "");
    assert.ok(!verifyVobizWebhookSignature(BODY, sig, ""));
    assert.ok(!verifyVobizWebhookSignature(BODY, sig, null));
  });
});

describe("envelope", () => {
  test("parses event_id, event_type, occurred_at and the Cloud API payload", () => {
    const env = parseVobizWebhookEnvelope(BODY)!;
    assert.equal(env.eventId, "evt-1");
    assert.equal(env.eventType, "message.inbound");
    assert.equal(env.occurredAt, "2026-10-27T10:00:00Z");
    assert.deepEqual(
      (env.payload["metadata"] as Record<string, unknown>)["phone_number_id"],
      "PN_A",
    );
  });

  test("anything that isn't a complete envelope is rejected, never guessed at", () => {
    for (const raw of [
      "not json",
      "[]",
      JSON.stringify({ event_type: "message.inbound", payload: {} }),
      JSON.stringify({ event_id: "e", payload: {} }),
      JSON.stringify({ event_id: "e", event_type: "message.inbound", payload: [] }),
      JSON.stringify({ event_id: "e", event_type: "message.inbound" }),
    ]) {
      assert.equal(parseVobizWebhookEnvelope(raw), null, raw);
    }
  });
});
