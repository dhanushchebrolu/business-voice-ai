import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Structural coverage for agent-sarvam-sync.server.ts. Source-scanned (like
 * every other file in this codebase that touches supabaseAdmin directly via
 * a dynamic @/ import) rather than executed — this repo's Node-native test
 * runner cannot reach a live Supabase instance or construct a real
 * SarvamTelephonyAdapter. Real HTTP-mocked coverage of
 * updateInboundDeployment itself already lives in
 * sarvam-api-client.server.test.ts / sarvam-provider.server.test.ts; this
 * file proves the query shape, resolution order, and fail-closed contract
 * this module adds on top of that.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "agent-sarvam-sync.server.ts"),
  "utf8",
);

describe("syncPublishedAgentToSarvam — resolution is entirely server-derived", () => {
  test("resolves the agent_configs row from businessId, never trusts a client-supplied agent/deployment id", () => {
    assert.match(src, /\.from\("agent_configs"\)/);
    assert.match(src, /\.eq\("business_id", businessId\)/);
  });

  test("resolves deployment ids from phone_numbers.agent_config_id, scoped to active Sarvam numbers only", () => {
    const idx = src.indexOf('.from("phone_numbers")');
    assert.ok(idx > -1);
    const block = src.slice(idx, idx + 400);
    assert.match(block, /eq\("agent_config_id", agent\.id\)/);
    assert.match(block, /n\.provider === "sarvam"/);
    assert.match(block, /n\.status === "active"/);
    assert.match(block, /n\.provider_deployment_id/);
  });

  test("deployment ids are de-duplicated (one update call per distinct deployment, not per phone number)", () => {
    assert.match(src, /new Set\(/);
  });
});

describe("syncPublishedAgentToSarvam — no fake success", () => {
  test("returns synced:false (not an error) when the agent has no active Sarvam deployment — nothing to sync is not a failure", () => {
    const idx = src.indexOf("if (deploymentIds.length === 0)");
    assert.ok(idx > -1);
    assert.match(src.slice(idx, idx + 80), /synced:\s*false/);
  });

  test("throws (never silently skips) when a deployment exists but the Sarvam adapter cannot be constructed", () => {
    const idx = src.indexOf("if (!adapter || !(adapter instanceof SarvamTelephonyAdapter))");
    assert.ok(idx > -1);
    const block = src.slice(idx, idx + 300);
    assert.match(block, /throw new TelephonyAdapterError/);
  });

  test("calls the real updateInboundDeployment for every resolved deployment — no other write path exists in this file", () => {
    assert.match(src, /adapter\.updateInboundDeployment\(deploymentId, \{ description: note \}\)/);
    // Never touches the "name" field — an admin/dashboard-set label must not
    // be silently overwritten by a customer publish.
    const callIdx = src.indexOf("adapter.updateInboundDeployment(");
    assert.doesNotMatch(src.slice(callIdx, callIdx + 100), /name:/);
  });

  test("does not swallow an updateInboundDeployment failure — no try/catch around the call inside this function", () => {
    const loopIdx = src.indexOf("for (const deploymentId of deploymentIds)");
    assert.ok(loopIdx > -1);
    const loopBlock = src.slice(loopIdx, src.indexOf("return { synced: true", loopIdx));
    assert.doesNotMatch(loopBlock, /catch/);
  });

  test("only returns synced:true after every deployment update call has resolved without throwing", () => {
    const loopIdx = src.indexOf("for (const deploymentId of deploymentIds)");
    const returnTrueIdx = src.indexOf("return { synced: true, deploymentIds }");
    assert.ok(loopIdx > -1 && returnTrueIdx > -1 && loopIdx < returnTrueIdx);
  });
});

describe("syncPublishedAgentToSarvam — field-mapping honesty", () => {
  test("documents that no agent-content field (persona/voice/greeting/capabilities/etc.) has a verified Sarvam sync target", () => {
    for (const field of [
      "persona",
      "greeting",
      "capabilities",
      "custom_personality",
      "transfer_number",
    ]) {
      assert.match(src, new RegExp(field));
    }
    assert.match(src, /no verified\s*\n \* Sarvam API for agent \*content\*/i);
  });

  test("never reads SARVAM_API_KEY (or any env var) directly — auth stays entirely inside the existing adapter/client, only the var's name may appear in a user-facing diagnostic message", () => {
    assert.equal(src.includes("process.env"), false);
  });
});
