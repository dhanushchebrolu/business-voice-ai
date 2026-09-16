import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * getBillingBypassStatus is the safe, frontend-visible channel dashboard
 * components use to learn whether BYPASS_BILLING_GATES is active on the
 * Worker, since browser code cannot read process.env directly. Source-scanned
 * like every other createServerFn module in this repo (this test runner
 * cannot safely import/execute one — see sarvam-admin.functions.test.ts's own
 * module doc for why).
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "billing.functions.ts"),
  "utf8",
);

describe("getBillingBypassStatus", () => {
  test("is a GET server function requiring no auth (the bypass state itself isn't sensitive)", () => {
    const start = src.indexOf("export const getBillingBypassStatus = createServerFn");
    assert.ok(start > -1);
    const block = src.slice(start, src.indexOf("});", start));
    assert.match(block, /createServerFn\(\{ method: "GET" \}\)/);
    assert.doesNotMatch(block, /requireSupabaseAuth/);
  });

  test("reads the exact same env var feature-gate.server.ts's backend bypass checks, nothing else", () => {
    const start = src.indexOf("export const getBillingBypassStatus = createServerFn");
    const block = src.slice(start, src.indexOf("});", start));
    assert.match(block, /process\.env\["BYPASS_BILLING_GATES"\] === "true"/);
    assert.match(
      block,
      /return \{ bypassed: process\.env\["BYPASS_BILLING_GATES"\] === "true" \};/,
    );
  });

  test("never touches a billing/payment/feature-lock table — the handler body is a single env read", () => {
    const start = src.indexOf("export const getBillingBypassStatus = createServerFn");
    const block = src.slice(start, src.indexOf("});", start));
    assert.doesNotMatch(block, /\.from\(/);
    assert.doesNotMatch(block, /supabaseAdmin/);
  });
});
