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

  test("the launch/pause/cancel buttons are disabled while an action is in flight", () => {
    const actionsIdx = code.indexOf("actions={");
    const sectionEndIdx = code.indexOf('<SectionCard title="Progress"');
    const block = code.slice(actionsIdx, sectionEndIdx);
    const disabledCount = (block.match(/disabled=\{actionPending\}/g) ?? []).length;
    assert.ok(
      disabledCount >= 3,
      `expected launch/pause/cancel all disabled, found ${disabledCount}`,
    );
  });

  test("doLaunch still calls launchCampaign for both 'Launch' and 'Resume' (unchanged dispatch — launchCampaign re-runs the full readiness bar, deliberately not resumeCampaign, for a UI-driven resume)", () => {
    const idx = code.indexOf('{["draft", "scheduled", "paused"].includes(campaign.status)');
    const block = code.slice(idx, idx + 300);
    assert.match(block, /onClick=\{doLaunch\}/);
  });
});
