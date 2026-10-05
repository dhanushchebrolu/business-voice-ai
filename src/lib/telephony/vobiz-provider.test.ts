import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { VobizTelephonyAdapter } from "./vobiz-provider.ts";

const config = {
  authId: "AUTH123",
  authToken: "secret-token",
  webhookVerifyToken: "correct-verify-token",
};

function signHmac(url: URL, nonce: string, authToken = config.authToken): string {
  const addressNoQuery = `${url.origin}${url.pathname}`;
  return createHmac("sha256", authToken).update(`${addressNoQuery}.${nonce}`).digest("base64");
}

function signedHeaders(url: URL, nonce = "12345678901234567890") {
  return {
    "x-vobiz-signature-v3": signHmac(url, nonce),
    "x-vobiz-signature-v3-nonce": nonce,
  };
}

describe("verifyWebhookSignature: Klyro's own verify_token is always checked first", () => {
  test("correct verify_token but no Vobiz signature is REJECTED by default (requireVobizSignature defaults to true)", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const url = new URL(
      "https://clickai.test/api/public/webhooks/telephony?provider=vobiz&verify_token=correct-verify-token",
    );
    assert.equal(adapter.verifyWebhookSignature("", {}, url), false);
  });

  test("wrong verify_token fails even with a correct Vobiz signature present", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const url = new URL(
      "https://clickai.test/api/public/webhooks/telephony?provider=vobiz&verify_token=wrong",
    );
    assert.equal(adapter.verifyWebhookSignature("", signedHeaders(url), url), false);
  });

  test("missing verify_token fails closed", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const url = new URL("https://clickai.test/api/public/webhooks/telephony?provider=vobiz");
    assert.equal(adapter.verifyWebhookSignature("", {}, url), false);
  });

  test("no url at all fails closed", () => {
    const adapter = new VobizTelephonyAdapter(config);
    assert.equal(adapter.verifyWebhookSignature("", {}), false);
  });
});

describe("verifyWebhookSignature: Vobiz's own X-Vobiz-Signature-V3 header is REQUIRED by default, per Vobiz's own documented behavior", () => {
  function signedUrl() {
    return new URL(
      "https://clickai.test/api/public/webhooks/telephony?provider=vobiz&verify_token=correct-verify-token",
    );
  }

  test("a correct X-Vobiz-Signature-V3 alongside a correct verify_token passes", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const url = signedUrl();
    const nonce = "12345678901234567890";
    const addressNoQuery = `${url.origin}${url.pathname}`;
    const signature = createHmac("sha256", config.authToken)
      .update(`${addressNoQuery}.${nonce}`)
      .digest("base64");
    const headers = {
      "x-vobiz-signature-v3": signature,
      "x-vobiz-signature-v3-nonce": nonce,
    };
    assert.equal(adapter.verifyWebhookSignature("", headers, url), true);
  });

  test("a present but WRONG X-Vobiz-Signature-V3 fails even though verify_token matches — never ignored", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const url = signedUrl();
    const headers = {
      "x-vobiz-signature-v3": "not-a-real-signature",
      "x-vobiz-signature-v3-nonce": "12345678901234567890",
    };
    assert.equal(adapter.verifyWebhookSignature("", headers, url), false);
  });

  test("no X-Vobiz-Signature-V3 header at all is REJECTED by default, never silently waved through on verify_token alone", () => {
    const adapter = new VobizTelephonyAdapter(config);
    assert.equal(adapter.verifyWebhookSignature("", {}, signedUrl()), false);
  });

  test("a different nonce produces a different signature — the nonce is genuinely part of the signed input, not decorative", () => {
    const url = signedUrl();
    const sigA = signHmac(url, "11111111111111111111");
    const sigB = signHmac(url, "22222222222222222222");
    assert.notEqual(sigA, sigB);
  });

  test("a correct signature computed for the wrong nonce fails — nonce and signature must agree", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const url = signedUrl();
    const wrongSignature = signHmac(url, "99999999999999999999");
    const headers = {
      "x-vobiz-signature-v3": wrongSignature,
      "x-vobiz-signature-v3-nonce": "12345678901234567890", // different nonce than the one signed
    };
    assert.equal(adapter.verifyWebhookSignature("", headers, url), false);
  });

  test("the sub-account X-Vobiz-Signature-MA-V3 header is accepted as a fallback, verified with the exact same HMAC construction", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const url = signedUrl();
    const nonce = "12345678901234567890";
    const headers = {
      "x-vobiz-signature-ma-v3": signHmac(url, nonce),
      "x-vobiz-signature-v3-nonce": nonce,
    };
    assert.equal(adapter.verifyWebhookSignature("", headers, url), true);
  });
});

describe("verifyWebhookSignature: requireVobizSignature: false is an explicit, documented opt-out — never the default", () => {
  const optOutConfig = { ...config, requireVobizSignature: false };

  test("a correct verify_token with NO Vobiz signature now passes, only because of the explicit opt-out", () => {
    const adapter = new VobizTelephonyAdapter(optOutConfig);
    const url = new URL(
      "https://clickai.test/api/public/webhooks/telephony?provider=vobiz&verify_token=correct-verify-token",
    );
    assert.equal(adapter.verifyWebhookSignature("", {}, url), true);
  });

  test("a present-but-wrong signature is STILL rejected even with the opt-out — the opt-out only covers absence, never a wrong value", () => {
    const adapter = new VobizTelephonyAdapter(optOutConfig);
    const url = new URL(
      "https://clickai.test/api/public/webhooks/telephony?provider=vobiz&verify_token=correct-verify-token",
    );
    const headers = {
      "x-vobiz-signature-v3": "not-a-real-signature",
      "x-vobiz-signature-v3-nonce": "12345678901234567890",
    };
    assert.equal(adapter.verifyWebhookSignature("", headers, url), false);
  });

  test("verify_token is still mandatory even with the signature requirement opted out — the opt-out never removes the one guaranteed-correct check", () => {
    const adapter = new VobizTelephonyAdapter(optOutConfig);
    const url = new URL(
      "https://clickai.test/api/public/webhooks/telephony?provider=vobiz&verify_token=wrong",
    );
    assert.equal(adapter.verifyWebhookSignature("", {}, url), false);
  });
});

describe("normalizeWebhookEvent: destination-number resolution (production incident — +918071580870 answer_url callbacks reach vobiz-answer.ts with signature verification passing, but phone_numbers lookup fails with vobiz_answer:unresolved_call / telephony:webhook_unknown_number)", () => {
  const REAL_NUMBER_E164 = "+918071580870";

  test("'To' already in E.164 with a leading + resolves to the real DID unchanged", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({
        CallUUID: "cu-e164",
        CallStatus: "ringing",
        To: REAL_NUMBER_E164,
      }).toString(),
    );
    assert.ok(event);
    assert.equal(event?.toE164, REAL_NUMBER_E164);
    assert.equal(event?.destinationE164, REAL_NUMBER_E164);
  });

  test("'To' as a bare 12-digit 91-prefixed number with no leading + still resolves to the real DID (normalizeToE164's digit-length fallback)", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({
        CallUUID: "cu-bare12",
        CallStatus: "ringing",
        To: "918071580870",
      }).toString(),
    );
    assert.ok(event);
    assert.equal(event?.toE164, REAL_NUMBER_E164);
    assert.equal(event?.destinationE164, REAL_NUMBER_E164);
  });

  test("'To' as a bare 10-digit number (no country code) still resolves to the real DID", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({
        CallUUID: "cu-bare10",
        CallStatus: "ringing",
        To: "8071580870",
      }).toString(),
    );
    assert.ok(event);
    assert.equal(event?.toE164, REAL_NUMBER_E164);
    assert.equal(event?.destinationE164, REAL_NUMBER_E164);
  });

  test("a leading '+' arriving as a literal space (GET answer_url query string, unescaped '+' decoded as space by URLSearchParams/form-urlencoded parsing) still resolves correctly, because trim() + the 12-digit fallback recover it", () => {
    const adapter = new VobizTelephonyAdapter(config);
    // Simulates exactly what `new URLSearchParams("To=+918071580870")` produces
    // for the "+" character per the application/x-www-form-urlencoded spec:
    // it is NOT percent-decoded back to "+", it becomes a literal space.
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams([
        ["CallUUID", "cu-plusasspace"],
        ["CallStatus", "ringing"],
        ["To", " 918071580870"],
      ]).toString(),
    );
    assert.ok(event);
    assert.equal(event?.toE164, REAL_NUMBER_E164);
  });

  test("HYPOTHESIS (unconfirmed — documents the exact failure mode a wrong field name would cause): if the destination field were sent under any key other than 'To'/'to', it is silently NOT extracted — toE164/destinationE164 come back undefined, not the DID", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({
        CallUUID: "cu-wrongfield",
        CallStatus: "ringing",
        // A plausible alternate name for the dialed number in other
        // Twilio/Plivo-family providers' payloads — NOT confirmed as
        // Vobiz's actual field name (vobiz.ai is network-blocked from this
        // environment; see this file's module doc). This test exists only
        // to prove the code's current, exact behavior if the real field
        // name turns out to differ from "To"/"to" — it does NOT assert
        // this is the real cause.
        CalledNumber: REAL_NUMBER_E164,
      }).toString(),
    );
    assert.ok(event);
    assert.equal(event?.toE164, undefined);
    assert.equal(event?.destinationE164, undefined);
  });

  test("the raw parsed fields are preserved on the event (event.raw) regardless of whether 'To' extraction succeeds — this is what the vobiz-answer.ts diagnostic logging depends on", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({
        CallUUID: "cu-raw",
        CallStatus: "ringing",
        To: REAL_NUMBER_E164,
      }).toString(),
    );
    assert.ok(event);
    assert.equal(event?.raw["To"], REAL_NUMBER_E164);
  });
});

describe("normalizeWebhookEvent: CallUUID + status mapping", () => {
  test("form-urlencoded hangup callback parses correctly", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const body = new URLSearchParams({
      CallUUID: "cu-123",
      CallStatus: "completed",
      Direction: "inbound",
      From: "+919876543210",
      To: "+912222222222",
      Duration: "42",
    }).toString();
    const event = adapter.normalizeWebhookEvent(body);
    assert.ok(event);
    assert.equal(event?.providerCallId, "cu-123");
    assert.equal(event?.status, "completed");
    assert.equal(event?.direction, "inbound");
    assert.equal(event?.durationSeconds, 42);
  });

  test("'in-progress' maps to in_progress (Vobiz has no separate 'answered' CallStatus — Twilio-family semantics)", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({ CallUUID: "cu-1", CallStatus: "in-progress" }).toString(),
    );
    assert.ok(event);
    assert.equal(event?.status, "in_progress");
  });

  for (const [vobizStatus, expected] of [
    ["ringing", "ringing"],
    ["busy", "busy"],
    ["failed", "failed"],
    ["timeout", "no_answer"],
    ["no-answer", "no_answer"],
    ["cancelled", "cancelled"],
  ] as const) {
    test(`CallStatus "${vobizStatus}" maps to NormalizedCallStatus "${expected}"`, () => {
      const adapter = new VobizTelephonyAdapter(config);
      const event = adapter.normalizeWebhookEvent(
        new URLSearchParams({ CallUUID: "cu-x", CallStatus: vobizStatus }).toString(),
      );
      assert.equal(event?.status, expected);
    });
  }

  test("an unrecognized CallStatus falls back to 'initiated' rather than dropping the event (matches the answer_url's first, pre-status request)", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({ CallUUID: "cu-new" }).toString(),
    );
    assert.ok(event, "a valid CallUUID must still produce an event, never null");
    assert.equal(event?.status, "initiated");
  });

  test("missing CallUUID returns null — a missing call identity is never fabricated", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({ CallStatus: "completed" }).toString(),
    );
    assert.equal(event, null);
  });

  test("JSON body also parses", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      JSON.stringify({ CallUUID: "cu-json", CallStatus: "busy" }),
    );
    assert.ok(event);
    assert.equal(event?.status, "busy");
  });

  test("outbound direction is recognized from the Direction field", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({ CallUUID: "cu-out", Direction: "outbound" }).toString(),
    );
    assert.equal(event?.direction, "outbound");
  });

  test("RecordUrl becomes recordingUrl", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({
        CallUUID: "cu-rec",
        CallStatus: "completed",
        RecordUrl: "https://vobiz.example/rec.mp3",
      }).toString(),
    );
    assert.equal(event?.recordingUrl, "https://vobiz.example/rec.mp3");
  });

  test("a failed call's HangupCause becomes failureReason", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({
        CallUUID: "cu-fail",
        CallStatus: "failed",
        HangupCause: "NORMAL_TEMPORARY_FAILURE",
      }).toString(),
    );
    assert.equal(event?.failureReason, "NORMAL_TEMPORARY_FAILURE");
  });

  test("a completed (non-failure) call has no failureReason", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const event = adapter.normalizeWebhookEvent(
      new URLSearchParams({ CallUUID: "cu-ok", CallStatus: "completed" }).toString(),
    );
    assert.equal(event?.failureReason, null);
  });
});

describe("initiateOutboundCall: real Vobiz REST shape", () => {
  test("POSTs to /Account/{auth_id}/Call/ with auth headers and the documented body, and parses the call_uuid response", async () => {
    const adapter = new VobizTelephonyAdapter(config);
    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ call_uuid: "cu-new-1", status: "call_initiated" }), {
        status: 201,
      });
    }) as typeof fetch;
    try {
      const result = await adapter.initiateOutboundCall({
        fromE164: "+911111111111",
        toE164: "+912222222222",
        callbackUrl: "https://clickai.test/api/public/webhooks/telephony?provider=vobiz",
      });
      assert.equal(result.providerCallId, "cu-new-1");
      assert.equal(result.status, "initiated");
      assert.equal(capturedUrl, "https://api.vobiz.ai/api/v1/Account/AUTH123/Call/");
      const headers = capturedInit?.headers as Record<string, string>;
      assert.equal(headers["X-Auth-ID"], "AUTH123");
      assert.equal(headers["X-Auth-Token"], "secret-token");
      const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
      assert.equal(body["from"], "+911111111111");
      assert.equal(body["to"], "+912222222222");
      assert.ok(String(body["answer_url"]).includes("/api/public/webhooks/vobiz-answer"));
      assert.ok(String(body["answer_url"]).includes("verify_token=correct-verify-token"));
      assert.ok(String(body["hangup_url"]).includes("verify_token=correct-verify-token"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a non-2xx response throws TelephonyAdapterError rather than returning a fabricated call id", async () => {
    const adapter = new VobizTelephonyAdapter(config);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("account suspended", { status: 403 })) as typeof fetch;
    try {
      await assert.rejects(() =>
        adapter.initiateOutboundCall({
          fromE164: "+911111111111",
          toE164: "+912222222222",
          callbackUrl: "https://clickai.test/api/public/webhooks/telephony?provider=vobiz",
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("openMediaBridge: honest 'no live audio path yet' when Vobiz's WS connection never arrives", () => {
  test("resolves to null after the configured timeout, never hangs or fabricates a bridge", async () => {
    const adapter = new VobizTelephonyAdapter({ ...config, mediaBridgeTimeoutMs: 20 });
    const bridge = await adapter.openMediaBridge("cu-never-connects");
    assert.equal(bridge, null);
  });
});
