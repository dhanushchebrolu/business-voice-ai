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

describe("createSarvamInstantOutboundCall — authorization and entitlement gates run before the shared call", () => {
  test("resolves organization membership and calls checkTelephonyAccess before delegating", () => {
    const membershipIdx = src.indexOf('.from("organization_members")');
    const gateIdx = src.indexOf("checkTelephonyAccess(orgId, data.phoneNumberId,");
    const delegateIdx = src.indexOf("await sendSarvamInstantOutboundCall(");
    assert.ok(membershipIdx > -1 && gateIdx > -1 && delegateIdx > -1);
    assert.ok(membershipIdx < gateIdx, "must resolve org membership before the entitlement gate");
    assert.ok(gateIdx < delegateIdx, "must pass the entitlement gate before delegating");
  });

  test("checks wallet affordability before ever delegating to the shared call function", () => {
    const walletIdx = src.indexOf("walletCanAffordOutbound(orgId)");
    const delegateIdx = src.indexOf("await sendSarvamInstantOutboundCall(");
    assert.ok(walletIdx > -1 && delegateIdx > -1);
    assert.ok(walletIdx < delegateIdx);
  });

  test("rejects a non-sarvam phone number before delegating", () => {
    assert.match(src, /gate\.phoneNumber\.provider !== "sarvam"/);
  });

  test("imports and calls sendSarvamInstantOutboundCall — no second implementation of connection/agent validation, call-log creation, or dial logic", () => {
    assert.match(
      src,
      /import \{ sendSarvamInstantOutboundCall \} from "@\/lib\/sarvam-outbound-call\.server"/,
    );
    assert.match(
      src,
      /await sendSarvamInstantOutboundCall\(supabaseAdmin, \{\s*\n\s*phoneNumberId:\s*data\.phoneNumberId,\s*\n\s*toE164:\s*data\.toE164,/,
    );
    // The detailed connection/agent-mapping checks, call_logs insert, and
    // error handling must NOT be reimplemented here.
    assert.doesNotMatch(src, /adapter\.createInstantOutbound\(/);
    assert.doesNotMatch(src, /\.from\("call_logs"\)/);
    assert.doesNotMatch(src, /\.from\("telephony_connections"\)/);
  });
});
