import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { VobizTelephonyAdapter } from "./vobiz-provider.ts";

const config = {
  authId: "AUTH123",
  authToken: "secret-token",
  webhookVerifyToken: "correct-verify-token",
};

describe("verifyWebhookSignature: Klyro's own verify_token is the primary, guaranteed-correct gate", () => {
  test("correct verify_token query param passes (no Vobiz signature present)", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const url = new URL(
      "https://clickai.test/api/public/webhooks/telephony?provider=vobiz&verify_token=correct-verify-token",
    );
    assert.equal(adapter.verifyWebhookSignature("", {}, url), true);
  });

  test("wrong verify_token fails", () => {
    const adapter = new VobizTelephonyAdapter(config);
    const url = new URL(
      "https://clickai.test/api/public/webhooks/telephony?provider=vobiz&verify_token=wrong",
    );
    assert.equal(adapter.verifyWebhookSignature("", {}, url), false);
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

describe("verifyWebhookSignature: Vobiz's own X-Vobiz-Signature-V3 header, when present, is an additional mandatory check", () => {
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

  test("no X-Vobiz-Signature-V3 header at all still passes on verify_token alone (graceful degradation)", () => {
    const adapter = new VobizTelephonyAdapter(config);
    assert.equal(adapter.verifyWebhookSignature("", {}, signedUrl()), true);
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
