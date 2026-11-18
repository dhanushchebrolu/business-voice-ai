import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_METADATA_KEYS,
  RAW_PROVIDER_METADATA_MARKERS,
  buildProviderMetadata,
  isPlausibleClientReference,
  sanitizeProviderMetadata,
} from "./webhook-correlation.server.ts";
import { SarvamTelephonyAdapter } from "./sarvam-provider.server.ts";
import type { NormalizedCallEvent } from "./adapter.ts";

function baseEvent(overrides: Partial<NormalizedCallEvent> = {}): NormalizedCallEvent {
  return {
    providerCallId: "int_1",
    status: "completed",
    occurredAt: "2026-09-08T10:00:00Z",
    raw: { interaction_id: "int_1", some_raw_field: "x" },
    ...overrides,
  };
}

const SARVAM_INBOUND = {
  app_id: "Conversatio-9c6a04cd-3334",
  app_version: "5",
  deployment_id: "Smile-Denta-be071be0-703e",
  interaction_id: "20261118/int_1",
  user_phone_number: "+919876500099",
  agent_phone_number: "+917900000061",
  duration: 42,
  recording_url: "https://recordings.example/abc.wav",
  final_agent_variables: { customer_name: "Asha", call_summary: "Root canal enquiry" },
  output_agent_variables: { opted_out: "no" },
  start_datetime: "2026-11-18T10:00:00Z",
  end_datetime: "2026-11-18T10:00:42Z",
  interaction_transcript: [{ role: "user", en_text: "My number is 98765 00099" }],
  metadata: { organization_id: "org_1" },
};

const SARVAM_OUTBOUND = {
  attempt_id: "att_1",
  status: "connected",
  channel_info: { channel_type: "v2v", agent_phone_number: "+917900000061" },
  duration: 61,
  interaction_id: "20261118/out_1",
  user_phone_number: "+919876500098",
  final_agent_variables: { opted_out: "yes" },
  webhook_config: {
    url: "https://clickai.test/api/public/webhooks/telephony?provider=sarvam&verify_token=SECRET123",
    metadata: { organization_id: "org_1", call_id: "8f14e45f-ceea-467e-a4a9-1c1c1c1c1c1c" },
  },
  interaction_transcript: [{ role: "agent", en_text: "Hello Asha" }],
};

const adapter = new SarvamTelephonyAdapter({ inboundApiKey: "sk_in", outboundApiKey: "sk_out" });

/** Every string anywhere in a value, to prove nothing personal or secret survives. */
const strings = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : v && typeof v === "object"
      ? Object.values(v as Record<string, unknown>).flatMap(strings)
      : [];

test("buildProviderMetadata: a Sarvam inbound call keeps only its identifiers", () => {
  const event = adapter.normalizeWebhookEvent(JSON.stringify(SARVAM_INBOUND))!;
  const metadata = buildProviderMetadata(event);
  assert.deepEqual(metadata, {
    interaction_id: "20261118/int_1",
    app_id: "Conversatio-9c6a04cd-3334",
    recording_url: "https://recordings.example/abc.wav",
  });
  const text = JSON.stringify(metadata);
  for (const leak of ["+919876500099", "+917900000061", "Asha", "Root canal", "98765", "opted_out"])
    assert.ok(!text.includes(leak), leak);
});

test("buildProviderMetadata: a Sarvam outbound result never stores the payload, numbers or webhook token", () => {
  const event = adapter.normalizeWebhookEvent(JSON.stringify(SARVAM_OUTBOUND))!;
  const metadata = buildProviderMetadata(event);
  assert.deepEqual(metadata, { interaction_id: "20261118/out_1" });
  const all = strings(metadata).join(" ");
  for (const leak of ["SECRET123", "verify_token", "+919876500098", "Hello Asha", "opted_out"])
    assert.ok(!all.includes(leak), leak);
});

test("buildProviderMetadata: another provider's raw fields (numbers, call ids) are not stored", () => {
  const metadata = buildProviderMetadata(
    baseEvent({
      raw: { CallSid: "CA1", From: "+919876500097", To: "+911234567890", Status: "completed" },
      recordingUrl: "https://exotel.example/rec.mp3",
    }),
  );
  assert.deepEqual(metadata, { recording_url: "https://exotel.example/rec.mp3" });
});

test("sanitizeProviderMetadata: an older raw row is reduced to the allowlist, keeping a late report", () => {
  const late = { status: "completed", receivedAt: "2026-11-18T11:00:00Z" };
  const cleaned = sanitizeProviderMetadata({
    ...SARVAM_INBOUND,
    _agent_variables: { final: { customer_name: "Asha" } },
    _deployment_id: "dep_1",
    late_provider_report: late,
  });
  assert.deepEqual(cleaned, {
    interaction_id: "20261118/int_1",
    app_id: "Conversatio-9c6a04cd-3334",
    recording_url: "https://recordings.example/abc.wav",
    late_provider_report: late,
  });
  assert.deepEqual(Object.keys(cleaned).sort(), [...PROVIDER_METADATA_KEYS].sort());
  assert.deepEqual(sanitizeProviderMetadata(null), {});
  assert.deepEqual(sanitizeProviderMetadata(["x"]), {});
});

test("every older raw Sarvam payload carries at least one marker the cleanup looks for", () => {
  for (const payload of [SARVAM_INBOUND, SARVAM_OUTBOUND])
    assert.ok(
      RAW_PROVIDER_METADATA_MARKERS.some((k) => k in payload),
      "a raw row would be found",
    );
  for (const key of RAW_PROVIDER_METADATA_MARKERS)
    assert.ok(!(PROVIDER_METADATA_KEYS as readonly string[]).includes(key), key);
});

test("isPlausibleClientReference: accepts a well-formed UUID", () => {
  assert.equal(isPlausibleClientReference("8f14e45f-ceea-467e-a4a9-1c1c1c1c1c1c"), true);
  assert.equal(isPlausibleClientReference("8F14E45F-CEEA-467E-A4A9-1C1C1C1C1C1C"), true);
});

test("isPlausibleClientReference: rejects non-UUID values rather than letting them reach a database lookup", () => {
  assert.equal(isPlausibleClientReference(""), false);
  assert.equal(isPlausibleClientReference("not-a-uuid"), false);
  assert.equal(isPlausibleClientReference("' OR '1'='1"), false);
  assert.equal(isPlausibleClientReference("8f14e45f-ceea-467e-a4a9"), false); // truncated
  assert.equal(isPlausibleClientReference("8f14e45fceea467ea4a91c1c1c1c1c1c"), false); // no dashes
});
