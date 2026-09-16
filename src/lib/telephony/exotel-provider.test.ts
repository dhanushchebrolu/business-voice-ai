import { test, describe } from "node:test";
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

/**
 * Production incident: wrangler tail showed telephony:webhook_request_received
 * followed by telephony:webhook_signature_invalid, with EXOTEL_WEBHOOK_SECRET
 * confirmed present (getTelephonyAdapter would have logged
 * telephony:webhook_provider_not_configured and returned 503 instead of ever
 * reaching signature verification if any Exotel env var, including the
 * secret, were missing). That narrows the failure to a genuine VALUE
 * mismatch between the configured secret and the verify_token Exotel is
 * actually sending — most plausibly an unescaped special character (a
 * literal "&", "=", "+", "#", or space) pasted straight into the Exotel
 * Passthru URL, which either splits the query string (truncating
 * verify_token) or gets decoded differently than the literal secret
 * intended (URLSearchParams follows the application/x-www-form-urlencoded
 * convention, decoding "+" to a space). This suite verifies the new
 * diagnostic — length-only, never either raw value — makes that
 * distinguishable from wrangler tail without ever exposing the secret.
 */
describe("verifyWebhookSignature: diagnostic logging never exposes either raw value", () => {
  function captureLogs() {
    const calls: { level: "info" | "error"; event: string; data: unknown }[] = [];
    const originalInfo = console.info;
    const originalError = console.error;
    console.info = (event: unknown, data?: unknown) => {
      calls.push({ level: "info", event: String(event), data });
    };
    console.error = (event: unknown, data?: unknown) => {
      calls.push({ level: "error", event: String(event), data });
    };
    return {
      calls,
      restore: () => {
        console.info = originalInfo;
        console.error = originalError;
      },
    };
  }

  test("a matching token logs secretLength/receivedLength/matched:true, never either raw string", () => {
    const { calls, restore } = captureLogs();
    try {
      const adapter = new ExotelTelephonyAdapter(config);
      const url = new URL(
        "https://vaani.app/api/public/webhooks/telephony?provider=exotel&verify_token=correct-verify-token",
      );
      adapter.verifyWebhookSignature("", {}, url);
    } finally {
      restore();
    }
    const entry = calls.find((c) => c.event === "exotel_provider:webhook_verify_token_check");
    assert.ok(entry, "expected the diagnostic log line to fire");
    assert.equal(entry!.level, "info");
    const data = entry!.data as Record<string, unknown>;
    assert.equal(data["secretConfigured"], true);
    assert.equal(data["secretLength"], config.webhookVerifyToken.length);
    assert.equal(data["receivedLength"], config.webhookVerifyToken.length);
    assert.equal(data["matched"], true);
    const serialized = JSON.stringify(data);
    assert.doesNotMatch(serialized, /correct-verify-token/);
  });

  test("a length mismatch (e.g. an un-encoded '&' truncating verify_token) is diagnosable from lengths alone", () => {
    const { calls, restore } = captureLogs();
    try {
      const adapter = new ExotelTelephonyAdapter(config);
      // Simulates the exact failure mode: the secret pasted into the
      // Passthru URL contained an un-encoded "&", so only "correct" made it
      // into verify_token before the query string split into a second,
      // unrelated parameter.
      const url = new URL(
        "https://vaani.app/api/public/webhooks/telephony?provider=exotel&verify_token=correct",
      );
      const result = adapter.verifyWebhookSignature("", {}, url);
      assert.equal(result, false);
    } finally {
      restore();
    }
    const entry = calls.find((c) => c.event === "exotel_provider:webhook_verify_token_check");
    assert.ok(entry);
    assert.equal(entry!.level, "error");
    const data = entry!.data as Record<string, unknown>;
    assert.equal(data["secretLength"], config.webhookVerifyToken.length);
    assert.equal(data["receivedLength"], "correct".length);
    assert.notEqual(data["secretLength"], data["receivedLength"]);
    assert.equal(data["matched"], false);
    const serialized = JSON.stringify(data);
    assert.doesNotMatch(serialized, /correct-verify-token/);
  });

  test("a missing verify_token logs receivedTokenPresent:false and receivedLength:0, never throws", () => {
    const { calls, restore } = captureLogs();
    try {
      const adapter = new ExotelTelephonyAdapter(config);
      const url = new URL("https://vaani.app/api/public/webhooks/telephony?provider=exotel");
      assert.equal(adapter.verifyWebhookSignature("", {}, url), false);
    } finally {
      restore();
    }
    const entry = calls.find((c) => c.event === "exotel_provider:webhook_verify_token_check");
    assert.ok(entry);
    const data = entry!.data as Record<string, unknown>;
    assert.equal(data["receivedTokenPresent"], false);
    assert.equal(data["receivedLength"], 0);
    assert.equal(data["secretConfigured"], true);
  });
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

describe("normalizeWebhookEvent: To/From number normalization (live-call regression — Exotel sends local Indian format, not E.164)", () => {
  test("Exotel's real observed local-format To number (09513886363) normalizes to E.164 (+919513886363), matching phone_numbers.e164's stored convention", () => {
    // Reproduces the exact live failure: Exotel's "To" field arrived as
    // "09513886363" (a leading 0, no country code) for a real, correctly-
    // provisioned, active number — a direct string match against
    // phone_numbers.e164 (always "+91..." by this codebase's convention)
    // never succeeded, producing "telephony:webhook_unknown_number" for a
    // tenant that should have resolved correctly.
    const adapter = new ExotelTelephonyAdapter(config);
    const body = new URLSearchParams({
      CallSid: "CA-local-format",
      Status: "ringing",
      To: "09513886363",
      From: "09876543210",
    }).toString();
    const event = adapter.normalizeWebhookEvent(body);
    assert.ok(event);
    assert.equal(event?.toE164, "+919513886363");
    assert.equal(event?.vaaniE164, "+919513886363");
    assert.equal(event?.fromE164, "+919876543210");
  });

  test("an already-E.164 To number (+919513886363) passes through unchanged — normalization is idempotent, not just a one-way transform", () => {
    const adapter = new ExotelTelephonyAdapter(config);
    const body = new URLSearchParams({
      CallSid: "CA-already-e164",
      Status: "ringing",
      To: "+919513886363",
    }).toString();
    const event = adapter.normalizeWebhookEvent(body);
    assert.ok(event);
    assert.equal(event?.toE164, "+919513886363");
    assert.equal(event?.vaaniE164, "+919513886363");
  });

  test("a different, legitimately-unprovisioned number normalizes to its OWN distinct E.164 value, never coerced to match the known/provisioned number", () => {
    // The fix must not make every number "resolve" — a number that
    // genuinely has no phone_numbers row should still end up as its own
    // correct E.164 (so the route's lookup correctly finds nothing), not
    // accidentally collide with the number this bug report is about.
    const adapter = new ExotelTelephonyAdapter(config);
    const body = new URLSearchParams({
      CallSid: "CA-unprovisioned",
      Status: "ringing",
      To: "08000000000",
    }).toString();
    const event = adapter.normalizeWebhookEvent(body);
    assert.ok(event);
    assert.equal(event?.toE164, "+918000000000");
    assert.notEqual(event?.toE164, "+919513886363");
  });

  test("a genuinely unparseable To number (e.g. a short code or garbage) is passed through raw, not fabricated into a fake E.164 value", () => {
    const adapter = new ExotelTelephonyAdapter(config);
    const body = new URLSearchParams({
      CallSid: "CA-unparseable",
      Status: "ringing",
      To: "1234", // too short to be a plausible Indian number — normalizeToE164 returns null for this
    }).toString();
    const event = adapter.normalizeWebhookEvent(body);
    assert.ok(event);
    // Falls back to the raw value exactly as before this fix — never
    // silently dropped, never guessed into a wrong number.
    assert.equal(event?.toE164, "1234");
  });
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
