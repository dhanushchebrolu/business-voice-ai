import { test } from "node:test";
import assert from "node:assert/strict";
import { SarvamTelephonyAdapter, SARVAM_WEBHOOK_AUTH_VERIFIED } from "./sarvam-provider.server.ts";
import { TelephonyAdapterError } from "./adapter.ts";

const config = { inboundApiKey: "sk_test_key_in", outboundApiKey: "sk_test_key_out" };

/**
 * Sample payloads shaped exactly per the field lists this session verified
 * from Sarvam's official documentation (see sarvam-provider.server.ts's
 * module doc for the verification trail) — no field name below is invented.
 */
const INBOUND_SAMPLE = {
  app_id: "app_123",
  app_version: "1",
  deployment_id: "dep_abc",
  interaction_id: "int_001",
  user_phone_number: "+919876543210",
  agent_phone_number: "+912222222222",
  duration: 42,
  final_agent_variables: { customer_name: "Asha" },
  output_agent_variables: { intent: "booking" },
  start_datetime: "2026-09-08T10:00:00Z",
  end_datetime: "2026-09-08T10:00:42Z",
  interaction_transcript: [
    { role: "agent", en_text: "Hello, thanks for calling.", indic_text: "नमस्ते" },
    { role: "user", en_text: "Hi, I need help." },
  ],
  metadata: {},
};

const OUTBOUND_SUCCESS_SAMPLE = {
  app_id: "app_123",
  app_version: "1",
  attempt_id: "att_001",
  campaign_id: "camp_1",
  cohort_id: "cohort_1",
  completion_status: "completed",
  connectivity_status: "connected",
  next_action_status: "none",
  failure_reason: null,
  user_identifier: "8f14e45f-ceea-467e-a4a9-1c1c1c1c1c1c",
  user_phone_number: "+919876543210",
  agent_phone_number: "+912222222222",
  duration: 30,
  interaction_id: "int_002",
  retry_attempt: 0,
  executed_at: "2026-09-08T10:05:00Z",
  start_datetime: "2026-09-08T10:05:00Z",
  end_datetime: "2026-09-08T10:05:30Z",
  initial_agent_variables: { customer_name: "Ravi" },
  final_agent_variables: { customer_name: "Ravi" },
  output_agent_variables: { interested: true },
  interaction_transcript: [{ role: "agent", en_text: "Hi Ravi." }],
  metadata: {},
};

test("normalizeWebhookEvent: inbound completion payload maps every verified field", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const event = adapter.normalizeWebhookEvent(JSON.stringify(INBOUND_SAMPLE));
  assert.ok(event);
  assert.equal(event.providerCallId, "int_001");
  assert.equal(event.eventId, "int_001");
  assert.equal(event.status, "completed");
  assert.equal(event.direction, "inbound");
  assert.equal(event.fromE164, "+919876543210");
  assert.equal(event.toE164, "+912222222222");
  assert.equal(event.vaaniE164, "+912222222222");
  assert.equal(event.durationSeconds, 42);
  assert.equal(event.recordingUrl, null);
  assert.equal(event.occurredAt, new Date("2026-09-08T10:00:42Z").toISOString());
  assert.equal(event.providerDeploymentId, "dep_abc");
  assert.deepEqual(event.transcript, [
    { role: "agent", text: "Hello, thanks for calling.", indicText: "नमस्ते" },
    { role: "user", text: "Hi, I need help.", indicText: undefined },
  ]);
  assert.deepEqual(event.agentVariables, {
    final: { customer_name: "Asha" },
    output: { intent: "booking" },
  });
});

test("normalizeWebhookEvent: outbound campaign attempt (connected/completed) maps every verified field", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const event = adapter.normalizeWebhookEvent(JSON.stringify(OUTBOUND_SUCCESS_SAMPLE));
  assert.ok(event);
  assert.equal(event.providerCallId, "int_002");
  assert.equal(event.eventId, "att_001");
  assert.equal(event.status, "completed");
  assert.equal(event.direction, "outbound");
  assert.equal(event.fromE164, "+912222222222");
  assert.equal(event.toE164, "+919876543210");
  assert.equal(event.durationSeconds, 30);
  assert.equal(event.providerCampaignId, "camp_1");
  assert.equal(event.providerAttemptId, "att_001");
  assert.equal(event.clientReference, "8f14e45f-ceea-467e-a4a9-1c1c1c1c1c1c");
  assert.deepEqual(event.agentVariables, {
    initial: { customer_name: "Ravi" },
    final: { customer_name: "Ravi" },
    output: { interested: true },
  });
});

test("normalizeWebhookEvent: outbound busy attempt classifies as busy, never crashes, never billed as completed", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const payload = {
    ...OUTBOUND_SUCCESS_SAMPLE,
    completion_status: "failed",
    connectivity_status: "busy",
    duration: 0,
    interaction_transcript: [],
  };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.status, "busy");
  assert.equal(event.durationSeconds, 0);
});

test("normalizeWebhookEvent: outbound no-answer attempt classifies as no_answer", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const payload = {
    ...OUTBOUND_SUCCESS_SAMPLE,
    connectivity_status: "no_answer",
    completion_status: "failed",
  };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.status, "no_answer");
});

test("normalizeWebhookEvent: outbound cancelled attempt classifies as cancelled", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const payload = {
    ...OUTBOUND_SUCCESS_SAMPLE,
    connectivity_status: "cancelled_by_user",
    completion_status: "cancelled",
  };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.status, "cancelled");
});

test("normalizeWebhookEvent: an unrecognized status combination defaults to failed, never fabricated as completed (billing safety)", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const payload = {
    ...OUTBOUND_SUCCESS_SAMPLE,
    completion_status: "sarvam_added_a_new_status_value",
    connectivity_status: "also_new",
  };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.status, "failed");
  // The unrecognized raw strings are preserved for audit, never discarded.
  assert.equal(
    (event.raw as Record<string, unknown>)["completion_status"],
    "sarvam_added_a_new_status_value",
  );
});

test("normalizeWebhookEvent: preserves failure_reason on outbound attempts", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const payload = {
    ...OUTBOUND_SUCCESS_SAMPLE,
    connectivity_status: "not_connected",
    completion_status: "failed",
    failure_reason: "carrier rejected the call",
  };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.failureReason, "carrier rejected the call");
});

test("normalizeWebhookEvent: falls back to metadata as a candidate client reference when user_identifier is absent", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const { user_identifier: _drop, ...rest } = OUTBOUND_SUCCESS_SAMPLE;
  const payload = { ...rest, metadata: "fallback-reference-value" };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.clientReference, "fallback-reference-value");
});

test("normalizeWebhookEvent: clientReference is undefined when neither user_identifier nor a string metadata is present", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const { user_identifier: _drop, ...rest } = OUTBOUND_SUCCESS_SAMPLE;
  const payload = { ...rest, metadata: {} };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.clientReference, undefined);
});

test("normalizeWebhookEvent: prefers metadata.campaign_contact_id (the structured object shape Klyro now sends) over a flat user_identifier", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const payload = {
    ...OUTBOUND_SUCCESS_SAMPLE,
    metadata: { organization_id: "org_1", campaign_id: "camp_1", campaign_contact_id: "cc_1" },
  };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.clientReference, "cc_1");
});

test("normalizeWebhookEvent: falls back to metadata.call_id when no campaign_contact_id is present (the single instant-outbound path)", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const { user_identifier: _drop, ...rest } = OUTBOUND_SUCCESS_SAMPLE;
  const payload = { ...rest, metadata: { organization_id: "org_1", call_id: "call_abc" } };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.clientReference, "call_abc");
});

test("normalizeWebhookEvent: surfaces metadata.organization_id as metadataOrganizationId for defense-in-depth, never as clientReference itself", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const payload = {
    ...OUTBOUND_SUCCESS_SAMPLE,
    metadata: { organization_id: "org_xyz", campaign_contact_id: "cc_1" },
  };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.metadataOrganizationId, "org_xyz");
  assert.equal(event.clientReference, "cc_1");
});

test("normalizeWebhookEvent: malformed JSON returns null rather than throwing", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  assert.equal(adapter.normalizeWebhookEvent("{not json"), null);
});

test("normalizeWebhookEvent: a JSON array (not an object) returns null", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  assert.equal(adapter.normalizeWebhookEvent("[1,2,3]"), null);
});

test("normalizeWebhookEvent: missing interaction_id returns null on both shapes", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const { interaction_id: _drop1, ...inboundRest } = INBOUND_SAMPLE;
  assert.equal(adapter.normalizeWebhookEvent(JSON.stringify(inboundRest)), null);
  const { interaction_id: _drop2, ...outboundRest } = OUTBOUND_SUCCESS_SAMPLE;
  assert.equal(adapter.normalizeWebhookEvent(JSON.stringify(outboundRest)), null);
});

test("normalizeWebhookEvent: malformed transcript turns are dropped, never thrown", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const payload = {
    ...INBOUND_SAMPLE,
    interaction_transcript: [
      { role: "agent", en_text: "Valid turn." },
      { role: "not-a-real-role", en_text: "Dropped: bad role." },
      { role: "user" }, // dropped: no en_text
      "not even an object", // dropped: not an object
      { role: "user", en_text: "Also valid." },
    ],
  };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.transcript?.length, 2);
  assert.equal(event.transcript?.[0]?.text, "Valid turn.");
  assert.equal(event.transcript?.[1]?.text, "Also valid.");
});

test("normalizeWebhookEvent: a payload with no transcript field omits transcript rather than throwing", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const { interaction_transcript: _drop, ...rest } = INBOUND_SAMPLE;
  const event = adapter.normalizeWebhookEvent(JSON.stringify(rest));
  assert.ok(event);
  assert.equal(event.transcript, undefined);
});

test("verifyWebhookSignature fails closed unconditionally — the real Sarvam webhook auth mechanism is unverified", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  assert.equal(SARVAM_WEBHOOK_AUTH_VERIFIED, false);
  assert.equal(adapter.verifyWebhookSignature("", {}), false);
  assert.equal(
    adapter.verifyWebhookSignature(JSON.stringify(INBOUND_SAMPLE), {
      "x-sarvam-signature": "anything",
    }),
    false,
  );
  assert.equal(
    adapter.verifyWebhookSignature(
      "",
      {},
      new URL("https://vaani.app/api/public/webhooks/telephony?provider=sarvam"),
    ),
    false,
  );
});

test("verifyWebhookSignature: Phase 5 verify_token defense-in-depth accepts a matching token only when a webhookSecret is configured", () => {
  const adapter = new SarvamTelephonyAdapter({ ...config, webhookSecret: "shared-secret" });
  const urlWith = (token: string) =>
    new URL(
      `https://vaani.app/api/public/webhooks/telephony?provider=sarvam&verify_token=${token}`,
    );
  assert.equal(adapter.verifyWebhookSignature("", {}, urlWith("shared-secret")), true);
  assert.equal(adapter.verifyWebhookSignature("", {}, urlWith("wrong-secret")), false);
  assert.equal(
    adapter.verifyWebhookSignature(
      "",
      {},
      new URL("https://vaani.app/api/public/webhooks/telephony?provider=sarvam"),
    ),
    false,
    "no verify_token at all must still reject",
  );
});

test("verifyWebhookSignature: the verify_token path never activates when webhookSecret is not configured — same fail-closed behavior as before Phase 5", () => {
  const adapter = new SarvamTelephonyAdapter(config); // no webhookSecret
  const url = new URL(
    "https://vaani.app/api/public/webhooks/telephony?provider=sarvam&verify_token=anything",
  );
  assert.equal(adapter.verifyWebhookSignature("", {}, url), false);
});

test("verifyWebhookSignature: an empty configured webhookSecret behaves as not configured (falsy), never matches an empty verify_token", () => {
  const adapter = new SarvamTelephonyAdapter({ ...config, webhookSecret: "" });
  const url = new URL(
    "https://vaani.app/api/public/webhooks/telephony?provider=sarvam&verify_token=",
  );
  assert.equal(adapter.verifyWebhookSignature("", {}, url), false);
});

test("normalizeWebhookEvent: malformed/non-E.164 phone numbers are dropped (undefined), not passed through as if valid", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const payload = {
    ...INBOUND_SAMPLE,
    user_phone_number: "not-a-phone-number",
    agent_phone_number: "0000000", // no leading +, implausible
  };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.fromE164, undefined);
  assert.equal(event.toE164, undefined);
  assert.equal(event.vaaniE164, undefined);
});

test("normalizeWebhookEvent: a plausible E.164 number is still accepted (no regression)", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const event = adapter.normalizeWebhookEvent(JSON.stringify(INBOUND_SAMPLE));
  assert.ok(event);
  assert.equal(event.fromE164, "+919876543210");
  assert.equal(event.vaaniE164, "+912222222222");
});

test("normalizeWebhookEvent: a SQL-injection-shaped or overlong 'phone number' string is rejected the same way as any other malformed value", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  for (const bad of ["'; DROP TABLE call_logs; --", "+1".padEnd(50, "1"), "++912222222222", ""]) {
    const payload = { ...INBOUND_SAMPLE, agent_phone_number: bad };
    const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
    assert.ok(event);
    assert.equal(event.vaaniE164, undefined, `expected "${bad}" to be rejected`);
  }
});

test("normalizeWebhookEvent: transcript is capped at MAX_TRANSCRIPT_TURNS turns to bound payload-driven storage growth", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const hugeTranscript = Array.from({ length: 3000 }, (_, i) => ({
    role: i % 2 === 0 ? "agent" : "user",
    en_text: `turn ${i}`,
  }));
  const payload = { ...INBOUND_SAMPLE, interaction_transcript: hugeTranscript };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.transcript?.length, 2000);
});

test("normalizeWebhookEvent: an individual transcript turn's text is truncated, never stored unbounded", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  const payload = {
    ...INBOUND_SAMPLE,
    interaction_transcript: [
      { role: "agent", en_text: "x".repeat(50000), indic_text: "य".repeat(50000) },
    ],
  };
  const event = adapter.normalizeWebhookEvent(JSON.stringify(payload));
  assert.ok(event);
  assert.equal(event.transcript?.[0]?.text.length, 20000);
  assert.equal(event.transcript?.[0]?.indicText?.length, 20000);
});

test("provisionNumber, releaseNumber and initiateOutboundCall reject honestly rather than faking success", async () => {
  const adapter = new SarvamTelephonyAdapter(config);
  await assert.rejects(() => adapter.provisionNumber({ country: "IN" }), TelephonyAdapterError);
  await assert.rejects(() => adapter.releaseNumber("some-id"), TelephonyAdapterError);
  await assert.rejects(
    () =>
      adapter.initiateOutboundCall({
        fromE164: "+912222222222",
        toE164: "+919876543210",
        callbackUrl: "https://vaani.app/api/public/webhooks/telephony?provider=sarvam",
      }),
    TelephonyAdapterError,
  );
});

test("id/supportsPurchase reflect the verified Sarvam capability, and no live media bridge is offered", () => {
  const adapter = new SarvamTelephonyAdapter(config);
  assert.equal(adapter.id, "sarvam");
  assert.equal(adapter.supportsPurchase, true);
  assert.equal("openMediaBridge" in adapter, false);
});

test("createInboundDeployment: rejects with a distinct error when orgId/workspaceId are not configured, before ever attempting a request", async () => {
  const adapter = new SarvamTelephonyAdapter(config); // no orgId/workspaceId
  await assert.rejects(
    () =>
      adapter.createInboundDeployment({
        name: "test-deployment",
        appId: "app_1",
        appVersion: 1,
        connectionId: "conn_1",
        phoneNumbers: ["+912222222222"],
      }),
    (err: unknown) => {
      assert.ok(err instanceof TelephonyAdapterError);
      assert.match(err.message, /SARVAM_ORG_ID and SARVAM_WORKSPACE_ID/);
      return true;
    },
  );
});

test("updateInboundDeployment, listCampaigns, getCampaign, updateCampaign and createInstantOutbound: reject with the same 'not configured' error as createInboundDeployment when orgId/workspaceId are missing", async () => {
  const adapter = new SarvamTelephonyAdapter(config); // no orgId/workspaceId
  const notConfigured = (err: unknown) => {
    assert.ok(err instanceof TelephonyAdapterError);
    assert.match(err.message, /SARVAM_ORG_ID and SARVAM_WORKSPACE_ID/);
    return true;
  };
  await assert.rejects(
    () => adapter.updateInboundDeployment("dep_1", { name: "x" }),
    notConfigured,
  );
  await assert.rejects(() => adapter.listCampaigns(), notConfigured);
  await assert.rejects(() => adapter.getCampaign("camp_1"), notConfigured);
  await assert.rejects(() => adapter.updateCampaign("camp_1", { name: "x" }), notConfigured);
  await assert.rejects(
    () =>
      adapter.createInstantOutbound({
        appId: "app_1",
        appVersion: 1,
        connectionId: "conn_1",
        fromE164: "+912222222222",
        toE164: "+919876543210",
        webhookUrl: "https://klyro.example.com/api/public/webhooks/telephony?provider=sarvam",
        metadata: { organizationId: "org_1" },
      }),
    notConfigured,
  );
});

test("createInboundDeployment: once orgId/workspaceId are configured, issues a real request via the injected fetchImpl and never fakes success on failure", async () => {
  let calledUrl: string | undefined;
  let calledInit: RequestInit | undefined;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calledUrl = String(url);
    calledInit = init;
    return new Response(JSON.stringify({ message: "invalid connection_id" }), { status: 400 });
  }) as typeof fetch;

  const adapter = new SarvamTelephonyAdapter({
    ...config,
    orgId: "org_1",
    workspaceId: "ws_1",
    fetchImpl,
  });

  await assert.rejects(
    () =>
      adapter.createInboundDeployment({
        name: "test-deployment",
        appId: "app_1",
        appVersion: 1,
        connectionId: "conn_1",
        phoneNumbers: ["+912222222222"],
      }),
    (err: unknown) => {
      assert.ok(err instanceof TelephonyAdapterError);
      assert.equal(err.status, 400);
      return true;
    },
  );

  assert.equal(
    calledUrl,
    "https://apps.sarvam.ai/api/app-authoring/v1/orgs/org_1/workspaces/ws_1/deployments",
  );
  assert.equal(calledInit?.method, "POST");
  const headers = calledInit?.headers as Record<string, string>;
  assert.equal(headers["X-API-Key"], "sk_test_key_in");
  const body = JSON.parse(calledInit?.body as string);
  assert.equal(body.app_id, "app_1");
  assert.deepEqual(body.connection_configs, [
    { connection_id: "conn_1", phone_numbers: ["+912222222222"] },
  ]);
});

test("createInboundDeployment: on a genuinely successful response, returns the real deploymentId — never fabricated", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ deployment_id: "dep_real_123" }), {
      status: 200,
    })) as typeof fetch;
  const adapter = new SarvamTelephonyAdapter({
    ...config,
    orgId: "org_1",
    workspaceId: "ws_1",
    fetchImpl,
  });
  const result = await adapter.createInboundDeployment({
    name: "test-deployment",
    appId: "app_1",
    appVersion: 1,
    connectionId: "conn_1",
    phoneNumbers: ["+912222222222"],
  });
  assert.equal(result.deploymentId, "dep_real_123");
});

test("createInboundDeployment and createInstantOutbound send the inbound and outbound API keys respectively — never the other direction's key", async () => {
  const capturedKeys: string[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    capturedKeys.push((init?.headers as Record<string, string>)["X-API-Key"]!);
    return new Response(JSON.stringify({ deployment_id: "dep_1", interaction_id: "int_1" }), {
      status: 200,
    });
  }) as typeof fetch;
  const adapter = new SarvamTelephonyAdapter({
    ...config,
    orgId: "org_1",
    workspaceId: "ws_1",
    fetchImpl,
  });

  await adapter.createInboundDeployment({
    name: "test-deployment",
    appId: "app_1",
    appVersion: 1,
    connectionId: "conn_1",
    phoneNumbers: ["+912222222222"],
  });
  await adapter.createInstantOutbound({
    appId: "app_1",
    appVersion: 1,
    connectionId: "conn_1",
    fromE164: "+912222222222",
    toE164: "+919876543210",
    webhookUrl: "https://klyro.example.com/api/public/webhooks/telephony?provider=sarvam",
    metadata: { organizationId: "org_1" },
  });

  assert.deepEqual(capturedKeys, [config.inboundApiKey, config.outboundApiKey]);
});
