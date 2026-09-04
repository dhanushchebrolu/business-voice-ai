import { test } from "node:test";
import assert from "node:assert/strict";
import { ExotelTelephonyAdapter } from "./exotel-provider.ts";

const config = {
  accountSid: "acsid",
  apiKey: "key",
  apiToken: "token",
  subdomain: "api.exotel.com",
  webhookVerifyToken: "correct-verify-token",
};

test("verifyWebhookSignature: correct verify_token query param passes", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  const url = new URL(
    "https://vaani.app/api/public/webhooks/telephony?provider=exotel&verify_token=correct-verify-token",
  );
  assert.equal(adapter.verifyWebhookSignature("", {}, url), true);
});

test("verifyWebhookSignature: wrong verify_token fails", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  const url = new URL(
    "https://vaani.app/api/public/webhooks/telephony?provider=exotel&verify_token=wrong",
  );
  assert.equal(adapter.verifyWebhookSignature("", {}, url), false);
});

test("verifyWebhookSignature: missing verify_token fails closed", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  const url = new URL("https://vaani.app/api/public/webhooks/telephony?provider=exotel");
  assert.equal(adapter.verifyWebhookSignature("", {}, url), false);
});

test("verifyWebhookSignature: no url at all fails closed", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  assert.equal(adapter.verifyWebhookSignature("", {}), false);
});

test("normalizeWebhookEvent: form-urlencoded status callback parses correctly", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  const body = new URLSearchParams({
    CallSid: "CA123",
    Status: "completed",
    Direction: "inbound",
    From: "+919876543210",
    To: "+912222222222",
    CallDuration: "42",
  }).toString();
  const event = adapter.normalizeWebhookEvent(body);
  assert.ok(event);
  assert.equal(event?.providerCallId, "CA123");
  assert.equal(event?.status, "completed");
  assert.equal(event?.direction, "inbound");
  assert.equal(event?.durationSeconds, 42);
});

test("normalizeWebhookEvent: JSON body also parses", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  const event = adapter.normalizeWebhookEvent(JSON.stringify({ CallSid: "CA999", Status: "busy" }));
  assert.ok(event);
  assert.equal(event?.status, "busy");
});

test("normalizeWebhookEvent: unknown status returns null rather than a guessed mapping", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  const event = adapter.normalizeWebhookEvent(
    new URLSearchParams({ CallSid: "CA1", Status: "some-new-status-exotel-invented" }).toString(),
  );
  assert.equal(event, null);
});

test("normalizeWebhookEvent: missing CallSid returns null", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  const event = adapter.normalizeWebhookEvent(
    new URLSearchParams({ Status: "completed" }).toString(),
  );
  assert.equal(event, null);
});

test("provisionNumber and releaseNumber fail honestly rather than fabricating success", async () => {
  const adapter = new ExotelTelephonyAdapter(config);
  await assert.rejects(() => adapter.provisionNumber({ country: "IN" }));
  await assert.rejects(() => adapter.releaseNumber("some-id"));
});
