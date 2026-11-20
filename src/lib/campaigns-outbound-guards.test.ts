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
const launch = src.slice(src.indexOf("export const launchCampaign"));

describe("campaign launch and cohort upload obey the outbound safety switches", () => {
  test("the kill switch refuses a launch before the campaign is read or anything is uploaded", () => {
    const kill = launch.indexOf(
      "if (outboundCallingDisabled()) throw new Error(OUTBOUND_DISABLED_MESSAGE);",
    );
    const read = launch.indexOf('.from("campaigns")');
    const running = launch.indexOf('status: "running"');
    assert.ok(kill > -1, "kill switch checked");
    assert.ok(kill < read && read < running);
  });

  test("no cohort is ever uploaded: every campaign call goes through ClickAI's own dispatcher", () => {
    assert.doesNotMatch(src, /uploadCohort\(/);
    const refuse = launch.indexOf('if (campaign.dispatch_mode === "sarvam_campaign")');
    assert.ok(refuse > -1 && refuse < launch.indexOf('status: "running"'));
  });

  test("resume re-runs every launch check; pause, launch and cancel only move from the expected status", () => {
    assert.match(src, /export const resumeCampaign = launchCampaign;/);
    assert.match(src, /\.in\("status", fromStatuses\)\s*\.select\("id"\)/);
    assert.match(src, /\.in\("status", \["draft", "scheduled", "paused"\]\)\s*\.select\("id"\)/);
    assert.match(src, /\.not\("status", "in", "\(completed,cancelled\)"\)/);
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
