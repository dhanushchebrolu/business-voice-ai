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

  test("never dispatches a sarvam_campaign-mode campaign itself — that mode's contacts are already with Sarvam", () => {
    assert.match(dispatch, /\.eq\("dispatch_mode", "instant_outbound_fallback"\)/);
  });

  test("claims a contact atomically — the UPDATE re-checks status in its own WHERE clause, not just at SELECT time", () => {
    assert.match(dispatch, /\.update\(\{ status: "calling", attempts \}\)/);
    assert.match(
      dispatch,
      /\.in\("status", \["pending", "retry_scheduled"\]\)\s*\n\s*\.select\("id"\)/,
    );
    assert.match(dispatch, /if \(!claimed \|\| claimed\.length === 0\)/);
  });
});

describe("sarvam_campaign dispatch mode — never armed silently", () => {
  test("the platform-wide kill switch defaults closed and is the only thing that can arm sarvam_campaign mode", () => {
    assert.match(campaignsFn, /KLYRO_DISPATCH_MODE.*===\s*"sarvam_campaign"/);
    assert.match(campaignsFn, /sarvamCampaignModeArmed\(\)/);
  });

  test("a campaign requesting sarvam_campaign mode while it is not armed fails launch loudly, it does not silently fall back", () => {
    assert.match(campaignsFn, /is not armed on this platform/);
  });

  test("a sarvam_campaign launch requires an admin-mapped provider_campaign_id — it never invents one", () => {
    assert.match(campaignsFn, /provider_campaign_id/);
    assert.match(campaignsFn, /An admin must create the campaign in Sarvam's dashboard/);
  });

  test("re-launching a paused sarvam_campaign-mode campaign never re-uploads (and re-dials) the same cohort", () => {
    assert.match(campaignsFn, /if \(campaign\.provider_cohort_id\) return;/);
  });

  test("the cohort-upload client function is documented as unverified, not claimed as a confirmed contract", () => {
    const client = readFileSync(
      new URL("./telephony/sarvam-api-client.server.ts", import.meta.url),
      "utf8",
    );
    assert.match(client, /MEDIUM CONFIDENCE, NOT INDEPENDENTLY CONFIRMED/);
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
