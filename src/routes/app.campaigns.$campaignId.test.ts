import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Whole-app loading/performance audit: `if (isLoading) return <LoadingState
 * label="Loading campaign" />` was a genuine stuck-forever candidate — no
 * error branch at all, so a stalled/failed campaignQuery fetch left the
 * page spinning forever with no retry affordance. Separately, launch/
 * pause/resume/cancel are non-idempotent campaign-wide actions with no
 * in-flight guard — a double click could fire the same action twice
 * concurrently.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "app.campaigns.$campaignId.tsx"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("app.campaigns.$campaignId.tsx — the campaign query's error state is surfaced, never left spinning", () => {
  test("destructures isError/error/refetch from the campaign query", () => {
    assert.match(
      code,
      /isError,\s*\n\s*error,\s*\n\s*refetch,\s*\n\s*\} = useQuery\(campaignQuery/,
    );
  });

  test("renders ErrorState with retry before the 'campaign not found' empty state", () => {
    const loadingIdx = code.indexOf("if (isLoading) return <LoadingState");
    const errorIdx = code.indexOf("if (isError) {");
    const notFoundIdx = code.indexOf("if (!campaign) return <EmptyState");
    assert.ok(loadingIdx > -1 && errorIdx > -1 && notFoundIdx > -1);
    assert.ok(loadingIdx < errorIdx && errorIdx < notFoundIdx);
    const block = code.slice(errorIdx, notFoundIdx);
    assert.match(block, /<ErrorState/);
    assert.match(block, /onRetry=\{\(\) => void refetch\(\)\}/);
  });

  test("the enrolled-contacts list also distinguishes a fetch error from a genuinely empty campaign", () => {
    assert.match(
      code,
      /isError: contactsIsError,\s*\n\s*error: contactsError,\s*\n\s*refetch: refetchContacts,/,
    );
    assert.match(code, /contactsIsError \? \(\s*\n\s*<ErrorState/);
  });
});

describe("app.campaigns.$campaignId.tsx — non-idempotent campaign actions can't be fired twice concurrently", () => {
  test("launch/pause/resume/cancel all route through one guarded runAction, not four independent try/catch blocks", () => {
    assert.match(code, /async function runAction\(/);
    assert.match(code, /if \(actionPending\) return;/);
    assert.match(code, /setActionPending\(true\);/);
    assert.match(code, /\} finally \{\s*\n\s*setActionPending\(false\);/);
  });

  test("the pause/cancel buttons are disabled while an action is in flight", () => {
    const actionsIdx = code.indexOf("actions={");
    const sectionEndIdx = code.indexOf('<SectionCard title="Progress"');
    const block = code.slice(actionsIdx, sectionEndIdx);
    const disabledCount = (block.match(/disabled=\{actionPending\}/g) ?? []).length;
    assert.ok(disabledCount >= 2, `expected pause/cancel disabled, found ${disabledCount}`);
  });
});

// Launching used to be impossible from this page (the button was always disabled).
// It is now gated by the server's own readiness checks: the button stays disabled
// until every check passes, asks for confirmation, can't be fired twice, and the
// server re-runs every check (campaign-launch.server.test.ts). Global dispatch
// (CAMPAIGN_DISPATCH_ENABLED) and per-workspace authorization stay the switches.
const control = readFileSync(
  new URL("../components/app/CampaignLaunchControl.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

describe("app.campaigns.$campaignId.tsx — launch is gated by the server's readiness checks", () => {
  test("the page launches only through CampaignLaunchButton, never a bare button or direct call", () => {
    const idx = code.indexOf('{["draft", "scheduled", "paused"].includes(campaign.status)');
    const block = code.slice(idx, code.indexOf("/>", idx));
    assert.match(block, /<CampaignLaunchButton/);
    assert.doesNotMatch(code, /launchCampaign\s*\(/);
    assert.doesNotMatch(code, /resumeCampaign/);
    assert.match(code, /<CampaignLaunchChecklist campaignId=\{campaignId\} \/>/);
  });

  test("the button is disabled until every server check passes, and while a launch is in flight", () => {
    assert.match(control, /const ready = readiness\?\.ready === true;/);
    assert.match(control, /disabled=\{!ready \|\| pending\}/);
    assert.match(control, /if \(pending\) return;/);
    assert.match(control, /getCampaignLaunchReadiness\(\{ data: \{ campaignId \} \}\)/);
  });

  test("launching asks for confirmation first and reports every blocker the server returns", () => {
    assert.match(control, /<AlertDialog open=\{confirming\}/);
    assert.match(control, /onClick=\{\(\) => setConfirming\(true\)\}/);
    assert.match(control, /launchCampaign\(\{ data: \{ campaignId \} \}\)/);
    assert.match(control, /result\.blockers\.map\(\(b\) => b\.label\)/);
  });

  test("the configuration, import history and activity sections render only saved data", () => {
    assert.match(code, /function CampaignConfiguration\(/);
    assert.match(code, /function ImportHistory\(/);
    assert.match(code, /useQuery\(campaignUploadsQuery\(campaignId\)\)/);
    assert.match(code, /function CampaignActivity\(/);
    assert.match(code, /\.filter\(\(\[, at\]\) => Boolean\(at\)\)/);
  });

  test("a CSV upload shows valid/invalid/duplicate counts before importing, and needs a valid row", () => {
    assert.match(code, /validateContactRows\(csvToTable\(csvText\), phoneColumn\)/);
    assert.match(
      code,
      /disabled=\{importing \|\| !phoneColumn \|\| !uploadPreview\?\.valid\.length \|\| tooLarge\}/,
    );
  });

  test("a file over the row cap shows the cap message and cannot be imported", () => {
    assert.match(code, /const tooLarge = \(uploadPreview\?\.totalRows \?\? 0\) > MAX_IMPORT_ROWS;/);
    assert.match(code, /IMPORT_TOO_LARGE_MESSAGE/);
  });
});

describe("app.campaigns.$campaignId.tsx — editing the configuration", () => {
  test("Edit configuration links to the edit page, only for statuses that can be edited", () => {
    assert.match(
      code,
      /\{configEditBlockedReason\(campaign\.status\) \? null : \(\s*\n\s*<Link to="\/app\/campaigns\/\$campaignId\/edit"/,
    );
    assert.match(code, /Edit configuration/);
  });

  test("the Configuration card explains why a campaign can't be edited, and a missing caller number", () => {
    assert.match(code, /const blocked = configEditBlockedReason\(campaign\.status\);/);
    assert.match(code, /No caller number yet\. Edit the configuration to choose one/);
  });
});
