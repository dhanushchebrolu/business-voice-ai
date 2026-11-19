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
 * instance.
 *
 * The actual validation/dial/call-log logic this handler delegates to
 * (sendSarvamInstantOutboundCall) now lives in sarvam-outbound-call.server.ts
 * and is exercised behaviorally there — this file only covers the
 * authorization spine unique to the customer-facing path: org membership,
 * the entitlement gate, wallet affordability, all running before the
 * shared function is ever called.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "sarvam-outbound.functions.ts"),
  "utf8",
);

describe("createSarvamInstantOutboundCall — who may dial, then the one shared gate", () => {
  test("resolves the number's own organization (owner or admin) before the shared gate", () => {
    const membershipIdx = src.indexOf("await outboundNumberOrganizationForCaller(");
    const gateIdx = src.indexOf("await placeSarvamCallForOrganization(supabaseAdmin, {");
    assert.ok(membershipIdx > -1 && gateIdx > -1);
    assert.ok(membershipIdx < gateIdx, "must resolve org membership before dialling");
  });

  test("dials only through placeSarvamCallForOrganization, with the organization it resolved", () => {
    assert.match(
      src,
      /await placeSarvamCallForOrganization\(supabaseAdmin, \{\s*orgId,\s*phoneNumberId:\s*data\.phoneNumberId,\s*toE164:\s*data\.toE164,/,
    );
    // No second implementation of the gates, the call row or the dial.
    assert.doesNotMatch(src, /checkTelephonyAccess\(/);
    assert.doesNotMatch(src, /walletCanAffordOutbound\(/);
    assert.doesNotMatch(src, /sendSarvamInstantOutboundCall\(/);
    assert.doesNotMatch(src, /adapter\.createInstantOutbound\(/);
    assert.doesNotMatch(src, /\.from\("call_logs"\)/);
    assert.doesNotMatch(src, /\.from\("telephony_connections"\)/);
  });
});

describe("getOutboundCallingStatus — members only, dialling for owners and admins", () => {
  test("refuses a non-member before reading anything, and reports canDial from the role", () => {
    const fn = src.slice(src.indexOf("export const getOutboundCallingStatus"));
    const roleIdx = fn.indexOf("await memberRole(supabase, userId, data.orgId)");
    const refuseIdx = fn.indexOf('if (!role) throw new Error("Workspace not found.")');
    const loadIdx = fn.indexOf("await loadOutboundCallingStatus(");
    assert.ok(roleIdx > -1 && refuseIdx > roleIdx && loadIdx > refuseIdx);
    assert.match(fn, /canDial: OUTBOUND_DIAL_ROLES\.includes\(role\)/);
  });
});
