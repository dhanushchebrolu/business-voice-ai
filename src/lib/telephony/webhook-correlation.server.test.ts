import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProviderMetadata, isPlausibleClientReference } from "./webhook-correlation.server.ts";
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

test("buildProviderMetadata: preserves raw payload untouched when no structured extras are present", () => {
  const event = baseEvent();
  const metadata = buildProviderMetadata(event);
  assert.deepEqual(metadata, { interaction_id: "int_1", some_raw_field: "x" });
});

test("buildProviderMetadata: folds agent variables and provider identifiers in under underscore-prefixed keys", () => {
  const event = baseEvent({
    agentVariables: { final: { name: "Asha" } },
    providerDeploymentId: "dep_1",
    providerCampaignId: "camp_1",
    providerAttemptId: "att_1",
  });
  const metadata = buildProviderMetadata(event);
  assert.deepEqual(metadata["_agent_variables"], { final: { name: "Asha" } });
  assert.equal(metadata["_deployment_id"], "dep_1");
  assert.equal(metadata["_campaign_id"], "camp_1");
  assert.equal(metadata["_attempt_id"], "att_1");
  // Original raw fields are still present alongside the extras.
  assert.equal(metadata["interaction_id"], "int_1");
});

test("buildProviderMetadata: omits extras entirely for a provider that never sets them (e.g. Exotel today)", () => {
  const event = baseEvent({ raw: { CallSid: "CA1", Status: "completed" } });
  const metadata = buildProviderMetadata(event);
  assert.deepEqual(metadata, { CallSid: "CA1", Status: "completed" });
  assert.equal("_agent_variables" in metadata, false);
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
