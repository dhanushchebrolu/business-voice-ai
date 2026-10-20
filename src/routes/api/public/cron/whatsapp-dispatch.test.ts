import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * createFileRoute-based handler, so — same established convention as
 * every other public route in this repo — a source scan.
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "whatsapp-dispatch.ts"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("WhatsApp dispatch cron", () => {
  test("authenticates with the cron secret before doing anything", () => {
    const authIdx = code.indexOf("authenticateCronRequest(request)");
    const firstWork = code.indexOf("client.server");
    assert.ok(authIdx > -1 && firstWork > -1 && authIdx < firstWork);
    assert.match(code, /if \(authError\) return authError;/);
  });

  test("runs every step independently (one failure doesn't stop the rest) and reports failure as 500", () => {
    for (const step of ["expiredProposals", "remindersEnqueued", "notifications", "campaigns"]) {
      assert.match(code, new RegExp(`await step\\("${step}"`));
    }
    assert.match(code, /status: errors\.length > 0 \? 500 : 200/);
  });

  test("takes nothing from the request and returns counts only", () => {
    assert.doesNotMatch(code, /request\.json|searchParams|organization_id|organizationId/);
    assert.doesNotMatch(code, /bodyText|wa_id|customer_phone/);
  });
});
