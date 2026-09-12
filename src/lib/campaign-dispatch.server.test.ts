import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-scan regression tests for the campaign dispatcher and its call
 * sites — mirrors this codebase's existing convention for security-critical
 * server files (see e.g. grant-org-client-id-seq-usage.test.ts) rather than
 * mocking the Supabase client, since what matters most here is architectural
 * invariants (no second authorization/billing system, never trust a
 * client-supplied org id, never call Sarvam for anything but 'sarvam') that
 * are cheap to prove by inspecting the actual source rather than fragile to
 * assert against a heavily-mocked call sequence.
 */

const dispatch = readFileSync(new URL("./campaign-dispatch.server.ts", import.meta.url), "utf8");
const cronRoute = readFileSync(
  new URL("../routes/api/public/cron/dispatch-campaigns.ts", import.meta.url),
  "utf8",
);
const campaignsFn = readFileSync(new URL("./campaigns.functions.ts", import.meta.url), "utf8");
const webhookRoute = readFileSync(
  new URL("../routes/api/public/webhooks/telephony.ts", import.meta.url),
  "utf8",
);

describe("campaign dispatcher — architecture invariants", () => {
  test("reuses the existing telephony authorization gate, never a second one", () => {
    assert.match(dispatch, /checkTelephonyAccess\(/);
  });

  test("reuses the existing wallet affordability check, never a second billing system", () => {
    assert.match(dispatch, /walletCanAffordOutbound\(/);
  });

  test("only ever dials through the existing, shared Sarvam adapter method", () => {
    assert.match(dispatch, /adapter\.createInstantOutbound\(/);
    // Never a raw fetch/HTTP call bypassing the adapter boundary.
    assert.doesNotMatch(dispatch, /fetch\(\s*["'`]https:\/\/apps\.sarvam\.ai/);
  });

  test("refuses to dial a non-Sarvam provider rather than guessing a generic path", () => {
    assert.match(dispatch, /gate\.phoneNumber\.provider !== "sarvam"/);
  });

  test("checks the contact's own opted_out flag before dialing, not just at enrollment time", () => {
    assert.match(dispatch, /contact\.opted_out/);
  });

  test("uses the shared outcome-decision function, not ad-hoc retry logic duplicated here", () => {
    assert.match(dispatch, /decideCampaignContactOutcome\(/);
  });

  test("bounds work per campaign per tick (never attempts an unbounded batch)", () => {
    assert.match(dispatch, /MAX_CONTACTS_PER_CAMPAIGN_PER_TICK/);
    assert.match(dispatch, /\.limit\(MAX_CONTACTS_PER_CAMPAIGN_PER_TICK\)/);
  });

  test("respects the campaign's own calling window before dialing anything", () => {
    assert.match(dispatch, /isWithinCallingWindow\(/);
  });
});

describe("campaign dispatch cron route — access control", () => {
  test("requires the cron secret before doing any work", () => {
    assert.match(cronRoute, /authenticateCronRequest\(request\)/);
    assert.match(cronRoute, /if \(authError\) return authError/);
  });

  test("never accepts a caller-supplied campaign/organization id — it dispatches everything due", () => {
    assert.doesNotMatch(cronRoute, /request\.(json|text)\(\)/);
  });
});

describe("campaign lifecycle server functions — tenant isolation", () => {
  test("every transition re-resolves the organization from the authenticated user's own membership, never a client-supplied org id", () => {
    // Each handler calls resolveOrgId(context) rather than trusting an
    // organizationId field on the input.
    const handlerCount = (campaignsFn.match(/\.handler\(async \(\{ data, context \}\)/g) ?? [])
      .length;
    const resolveCount = (campaignsFn.match(/resolveOrgId\(context\)/g) ?? []).length;
    assert.ok(handlerCount > 0, "expected at least one handler");
    assert.equal(resolveCount, handlerCount);
  });

  test("launch re-validates entitlement/billing/readiness — it does not just flip a status column", () => {
    assert.match(campaignsFn, /checkTelephonyAccess\(/);
    assert.match(campaignsFn, /walletCanAffordOutbound\(/);
  });

  test("cancel stops future dialing for not-yet-attempted contacts", () => {
    assert.match(campaignsFn, /status: "cancelled", next_attempt_at: null/);
  });
});

describe("webhook route — campaign hook never bypasses idempotency", () => {
  test("the campaign outcome hook only runs inside the existing TERMINAL_CALL_STATUSES branch", () => {
    const idx = webhookRoute.indexOf("if (TERMINAL_CALL_STATUSES.includes(event.status)) {");
    const hookIdx = webhookRoute.indexOf("applyCampaignTerminalEvent(");
    assert.ok(idx !== -1 && hookIdx !== -1 && hookIdx > idx);
  });

  test("a lead is only ever created from a real terminal 'completed' event, never fabricated", () => {
    assert.match(webhookRoute, /event\.status === "completed" && contactId/);
  });
});
