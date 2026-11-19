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
const cohort = src.slice(src.indexOf("async function launchViaSarvamCampaign"));

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

  test("a cohort with any number outside the test allowlist is refused before upload", () => {
    const allow = cohort.indexOf(
      'if (dialable.some((cc) => !isSarvamOutboundDestinationAllowed(cc.contacts?.phone ?? "")))',
    );
    const upload = cohort.indexOf("adapter.uploadCohort(");
    assert.ok(allow > -1, "allowlist checked");
    assert.ok(allow < upload, "before Sarvam is asked to dial anyone");
    assert.match(cohort.slice(allow, upload), /throw new Error\(OUTBOUND_TEST_ALLOWLIST_MESSAGE\)/);
  });
});
