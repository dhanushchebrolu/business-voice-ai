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
  join(dirname(fileURLToPath(import.meta.url)), "whatsapp-replies.ts"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("WhatsApp reply recovery cron", () => {
  test("authenticates with the cron secret before running the sweep", () => {
    const authIdx = code.indexOf("authenticateCronRequest(request)");
    const sweepIdx = code.indexOf("recoverPendingWhatsAppReplies(");
    assert.ok(authIdx > -1 && sweepIdx > -1);
    assert.ok(authIdx < sweepIdx);
    assert.match(code, /if \(authError\) return authError;/);
  });

  test("takes no tenant or message ids from the request", () => {
    assert.doesNotMatch(code, /organization_id|organizationId|request\.json|searchParams/);
  });

  test("returns only counts, never message content", () => {
    assert.match(code, /examined: summary\.examined, attempted: summary\.attempted/);
    assert.doesNotMatch(code, /summary\.results/);
  });
});
