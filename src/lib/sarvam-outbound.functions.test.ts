import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for sarvam-outbound.functions.ts's
 * createSarvamInstantOutboundCall — a createServerFn-wrapped handler, tested
 * via source scan for the same reason as telephony-admin.functions.test.ts /
 * sarvam-admin.functions.test.ts: this repo's Node-native test runner cannot
 * safely import/execute createServerFn modules or reach a live Supabase
 * instance. HTTP-mocked behavioral coverage of the actual Sarvam request
 * lives in sarvam-api-client.server.test.ts; this file asserts the
 * *ordering* and *presence* of the authorization/validation/persistence
 * steps around that call.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "sarvam-outbound.functions.ts"),
  "utf8",
);

describe("createSarvamInstantOutboundCall — authorization and entitlement gates run before any Sarvam call", () => {
  test("resolves organization membership and calls checkTelephonyAccess before touching the adapter", () => {
    const membershipIdx = src.indexOf('.from("organization_members")');
    const gateIdx = src.indexOf("checkTelephonyAccess(orgId, data.phoneNumberId,");
    const adapterIdx = src.indexOf('getTelephonyAdapter("sarvam")');
    assert.ok(membershipIdx > -1 && gateIdx > -1 && adapterIdx > -1);
    assert.ok(membershipIdx < gateIdx, "must resolve org membership before the entitlement gate");
    assert.ok(gateIdx < adapterIdx, "must pass the entitlement gate before touching the adapter");
  });

  test("checks wallet affordability before ever calling the adapter", () => {
    const walletIdx = src.indexOf("walletCanAffordOutbound(orgId)");
    const adapterIdx = src.indexOf('getTelephonyAdapter("sarvam")');
    assert.ok(walletIdx > -1 && adapterIdx > -1);
    assert.ok(walletIdx < adapterIdx);
  });

  test("rejects a non-sarvam phone number, a number with no connection, or a number with no agent", () => {
    assert.match(src, /gate\.phoneNumber\.provider !== "sarvam"/);
    assert.match(src, /!gate\.phoneNumber\.connection_id/);
    assert.match(src, /!gate\.phoneNumber\.agent_config_id/);
  });

  test("validates the Sarvam connection is registered and the agent is Sarvam-mapped before dialing", () => {
    const connectionCheckIdx = src.indexOf(
      'connection.provider !== "sarvam" || !connection.provider_connection_id',
    );
    const agentCheckIdx = src.indexOf(
      "!agentConfig.sarvam_app_id || !agentConfig.sarvam_app_version",
    );
    const dialIdx = src.indexOf("adapter.createInstantOutbound(");
    assert.ok(connectionCheckIdx > -1 && agentCheckIdx > -1 && dialIdx > -1);
    assert.ok(connectionCheckIdx < dialIdx);
    assert.ok(agentCheckIdx < dialIdx);
  });

  test("rejects when the mapped agent belongs to a different organization than the caller's", () => {
    assert.match(src, /agentConfig\.organization_id !== orgId/);
  });
});

describe("createSarvamInstantOutboundCall — create-call-log-first pattern, preserved", () => {
  test("inserts the call_logs row (status: initiated) BEFORE calling the Sarvam adapter", () => {
    const insertIdx = src.indexOf('.from("call_logs")\n      .insert({');
    const dialIdx = src.indexOf("adapter.createInstantOutbound(");
    assert.ok(insertIdx > -1 && dialIdx > -1);
    assert.ok(
      insertIdx < dialIdx,
      "the call_logs row must exist before the provider is ever called",
    );
    assert.match(src, /status:\s*"initiated"/);
  });

  test("passes the call_logs row's own id as metadata.callId — the correlation key the webhook fallback expects", () => {
    assert.match(src, /metadata:\s*\{\s*organizationId:\s*orgId,\s*callId:\s*call\.id\s*\}/);
  });

  test("does NOT unconditionally write provider_call_id — only when interactionId is actually present in the response", () => {
    const ifIdx = src.indexOf("if (dialed.interactionId)");
    const updateIdx = src.indexOf(".update({ provider_call_id: dialed.interactionId })");
    assert.ok(ifIdx > -1 && updateIdx > -1);
    assert.ok(ifIdx < updateIdx);
  });

  test("marks the call failed (never silently drops it) when the adapter call throws", () => {
    const catchIdx = src.indexOf("} catch (err) {");
    assert.ok(catchIdx > -1);
    const catchBlock = src.slice(catchIdx);
    assert.match(catchBlock, /status:\s*"failed"/);
    assert.match(catchBlock, /failure_reason:\s*\(err as Error\)\.message/);
    assert.match(catchBlock, /throw err/);
  });
});
