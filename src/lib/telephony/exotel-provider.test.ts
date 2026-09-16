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

test("normalizeWebhookEvent: an unrecognized status value (valid CallSid) falls back to 'initiated' rather than dropping the event", () => {
  // Regression: this used to return null, silently dropping any webhook
  // whose status string this adapter's STATUS_MAP doesn't recognize — the
  // exact failure mode a live test call hit (see the next two tests for the
  // real observed shape). A CallSid is never fabricated; a status is.
  const adapter = new ExotelTelephonyAdapter(config);
  const event = adapter.normalizeWebhookEvent(
    new URLSearchParams({ CallSid: "CA1", Status: "some-new-status-exotel-invented" }).toString(),
  );
  assert.ok(event, "a valid CallSid must still produce an event, never null");
  assert.equal(event?.providerCallId, "CA1");
  assert.equal(event?.status, "initiated");
});

test("normalizeWebhookEvent: missing CallSid returns null (unlike a missing/unrecognized status, a missing call identity is never fabricated)", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  const event = adapter.normalizeWebhookEvent(
    new URLSearchParams({ Status: "completed" }).toString(),
  );
  assert.equal(event, null);
});

test("normalizeWebhookEvent: a valid CallSid with NO status-ish field present at all falls back to 'initiated', not null", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  const event = adapter.normalizeWebhookEvent(
    new URLSearchParams({ CallSid: "CA-no-status-field" }).toString(),
  );
  assert.ok(event);
  assert.equal(event?.providerCallId, "CA-no-status-field");
  assert.equal(event?.status, "initiated");
});

test("normalizeWebhookEvent: Exotel's real observed Voicebot Passthru shape (CallType=call-attempt, no Status/DialCallStatus/CallStatus field) is not dropped", () => {
  // Reproduces the exact live failure: a real inbound test call's first
  // callback carried a valid CallSid, CallType=call-attempt, and no
  // recognized status field — normalizeWebhookEvent returned null, the
  // call_logs row was never created, and the Voicebot's WebSocket
  // connection was rejected moments later with "No known call for CallSid
  // ...". The exact CallSid value is the one from that live failure.
  const adapter = new ExotelTelephonyAdapter(config);
  const body = new URLSearchParams({
    CallSid: "bdafe129cd8b02424b76989012151a9g",
    CallType: "call-attempt",
  }).toString();
  const event = adapter.normalizeWebhookEvent(body);
  assert.ok(event, "must not be dropped just because no status field was recognized");
  // CallSid preserved byte-for-byte as Exotel sent it — never transformed.
  assert.equal(event?.providerCallId, "bdafe129cd8b02424b76989012151a9g");
  assert.equal(event?.status, "initiated");
});

test("normalizeWebhookEvent: a fallback-status event's provider_call_id round-trips exactly through the same firstString/STATUS_MAP path a recognized event uses — no separate, divergent code path", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  const recognized = adapter.normalizeWebhookEvent(
    new URLSearchParams({ CallSid: "CA-same-path", Status: "ringing" }).toString(),
  );
  const fallback = adapter.normalizeWebhookEvent(
    new URLSearchParams({ CallSid: "CA-same-path", CallType: "call-attempt" }).toString(),
  );
  assert.equal(recognized?.providerCallId, fallback?.providerCallId);
});

test("a fallback-status event is never 'answered'/'in_progress' — the media-stream authorization row exists early, but the agent runtime is never started off a status Exotel didn't actually assert", () => {
  const adapter = new ExotelTelephonyAdapter(config);
  const event = adapter.normalizeWebhookEvent(
    new URLSearchParams({ CallSid: "CA-early-media", CallType: "call-attempt" }).toString(),
  );
  assert.ok(event);
  assert.notEqual(event?.status, "answered");
  assert.notEqual(event?.status, "in_progress");
});

test("provisionNumber and releaseNumber fail honestly rather than fabricating success", async () => {
  const adapter = new ExotelTelephonyAdapter(config);
  await assert.rejects(() => adapter.provisionNumber({ country: "IN" }));
  await assert.rejects(() => adapter.releaseNumber("some-id"));
});
