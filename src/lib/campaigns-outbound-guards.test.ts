import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Campaign launch and the Sarvam-cohort upload are createServerFn code, so
 * (like the other server-function tests here) they are checked by source:
 * the global kill switch and the supervised-test allowlist must stop them
 * before anything reaches Sarvam. Found missing in the final outbound audit.
 */
const src = readFileSync(new URL("./campaigns.functions.ts", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);
// Launch is campaign-launch.server.ts (launchCampaignFor): every check lives in
// campaign-launch-readiness.server.ts, and any failing check returns before the
// one status update. campaign-launch.server.test.ts proves each guard
// behaviourally (one test per guard, the campaign left unchanged); these source
// checks keep the wiring from drifting.
const readSrc = (f: string) =>
  readFileSync(new URL(f, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const launchFn = src.slice(src.indexOf("export const launchCampaign"));
const launchModule = readSrc("./campaign-launch.server.ts");
const readiness = readSrc("./campaign-launch-readiness.server.ts");
const refusedBeforeRunning = () => {
  const refuse = launchModule.indexOf("if (blockers.length > 0) {");
  const running = launchModule.indexOf('.update({ status: "running"');
  assert.ok(refuse > -1 && refuse < running, "any failing check returns before the status update");
};

describe("campaign launch and cohort upload obey the outbound safety switches", () => {
  test("the kill switch is a launch check, wired to OUTBOUND_CALLING_DISABLED", () => {
    assert.match(
      launchFn,
      /launchCampaignFor\(\s*await defaultReadinessDeps\("launch"\),\s*orgId,\s*context\.userId,\s*data\.campaignId,?\s*\)/,
    );
    assert.match(readiness, /"kill_switch",[\s\S]{0,80}deps\.killSwitchOn\(\)/);
    assert.match(readiness, /killSwitchOn: eligibility\.outboundCallingDisabled,/);
    refusedBeforeRunning();
  });

  test("no cohort is ever uploaded: every campaign call goes through ClickAI's own dispatcher", () => {
    assert.doesNotMatch(src, /uploadCohort\(/);
    assert.match(readiness, /campaign\.dispatch_mode === "sarvam_campaign"/);
    refusedBeforeRunning();
  });

  test("resume re-runs every launch check; pause, launch and cancel only move from the expected status", () => {
    assert.match(src, /export const resumeCampaign = launchCampaign;/);
    assert.match(src, /\.in\("status", fromStatuses\)\s*\.select\("id"\)/);
    assert.match(
      launchModule,
      /\.in\("status", \["draft", "scheduled", "paused"\]\)\s*\.select\("id"\)/,
    );
    assert.match(src, /\.not\("status", "in", "\(completed,cancelled\)"\)/);
  });
});

describe("campaign launch refuses unsafe retry settings (GATE C4 H1)", () => {
  test("retry settings are a launch check, refused before the campaign is set running", () => {
    assert.match(
      readiness,
      /add\("retry_settings", "Retry settings are valid", retrySettingsProblem\(campaign\)\);/,
    );
    refusedBeforeRunning();
  });
});

describe("single calls: the calling hours are re-checked between admission and the dial", () => {
  test("a call admitted at 20:59 that would dial after 21:00 is recorded as never started", () => {
    const single = readFileSync(
      new URL("./sarvam-outbound-call.server.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const fn = single.slice(single.indexOf("export async function sendSarvamInstantOutboundCall"));
    const admit = fn.indexOf('rpc("admit_single_outbound_call"');
    const hours = fn.indexOf("if (!withinCallingHours(params.now ?? new Date())) {");
    const dial = fn.indexOf("adapter.createInstantOutbound(");
    assert.ok(
      admit > -1 && admit < hours && hours < dial,
      "admission, then the hours, then the dial",
    );
    assert.match(
      fn.slice(hours, dial),
      /recordSarvamStartFailure\(supabaseAdmin, call\.id, new Error\(CALLING_HOURS_MESSAGE\)\);\s*throw new Error\(CALLING_HOURS_MESSAGE\);/,
    );
    assert.match(single, /case "outside_calling_hours":\s*return CALLING_HOURS_MESSAGE;/);
  });
});

describe("a campaign without a caller number can't be launched", () => {
  test("launch refuses a campaign with no caller number before anything is set running", () => {
    assert.match(
      readiness,
      /if \(!campaign\.phone_number_id\)\s*numberProblem\s*=\s*"Choose a caller number/,
    );
    refusedBeforeRunning();
  });

  test("launch also refuses instructions saved only as a draft (not confirmed)", () => {
    assert.match(
      readiness,
      /campaign\.context_reviewed_at \? validateCampaignContext\(campaign\.context\) : null/,
    );
    refusedBeforeRunning();
  });
});

describe("campaign launch is unavailable while campaign dispatch is switched off", () => {
  test("launch (and resume, the same function) refuses while the dispatch switch is off", () => {
    assert.match(readiness, /"dispatch_available",[\s\S]{0,80}!deps\.dispatchEnabled\(\)/);
    refusedBeforeRunning();
    assert.match(src, /export const resumeCampaign = launchCampaign;/);
  });

  test("the switch is the dispatcher's own (CAMPAIGN_DISPATCH_ENABLED), not a second flag", async () => {
    assert.match(
      readiness,
      /const \{ campaignDispatchEnabled \} = await import\("\.\/jobs\/handlers\.server\.ts"\);/,
    );
    assert.match(readiness, /dispatchEnabled: campaignDispatchEnabled,/);
    const handlers = readFileSync(new URL("./jobs/handlers.server.ts", import.meta.url), "utf8");
    assert.match(
      handlers,
      /return process\.env\["CAMPAIGN_DISPATCH_ENABLED"\]\?\.trim\(\)\.toLowerCase\(\) === "true";/,
    );
  });
});
