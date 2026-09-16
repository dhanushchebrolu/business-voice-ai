import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Temporary billing-gate UI suppression (mirrors BYPASS_BILLING_GATES —
 * feature-gate.server.ts's backend bypass): while the flag is active, the
 * "Payment required" badge, "Plan" price, "Setup payment", "Next billing
 * date" and the Pay/Billing buttons must not render, but the four channel
 * status cards (Phone/Voice agent/WhatsApp/Website chatbot) — genuine setup
 * state, not payment/entitlement state — must always render regardless.
 *
 * Source-scanned, matching this repo's established convention for JSX files
 * this Node-native test runner can't import/render directly (no jsdom/RTL —
 * see PublicNav.test.ts's own module doc).
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "AccountStatusPanel.tsx"),
  "utf8",
);

describe("AccountStatusPanel reads the bypass flag through the safe server-function channel, never process.env directly", () => {
  test("fetches getBillingBypassStatus via useServerFn/useQuery, not a direct env read", () => {
    assert.match(src, /import \{ getBillingBypassStatus \} from "@\/lib\/billing\.functions";/);
    assert.match(src, /useServerFn\(getBillingBypassStatus\)/);
    assert.doesNotMatch(src, /process\.env/);
  });

  test("billingBypassed is derived from the query result, not hardcoded", () => {
    assert.match(src, /const billingBypassed = bypass\?\.bypassed === true;/);
  });
});

describe("payment UI is gated on billingBypassed", () => {
  test("the 'Payment required' status badge is hidden only when bypassed and the account is actually in payment_required", () => {
    assert.match(src, /billingBypassed && status === "payment_required" \? undefined : \(/);
  });

  test("the Plan price suffix, Setup payment and Next billing date fields are all suppressed while bypassed", () => {
    assert.match(src, /\{!billingBypassed && monthly \? \(/);
    assert.match(src, /\{billingBypassed \? null : \(\s*\n\s*<>/);
    assert.match(src, /Setup payment/);
    assert.match(src, /Next billing date/);
  });

  test("the Pay setup fee / Pay monthly subscription and Billing buttons are suppressed while bypassed", () => {
    const idx = src.indexOf(
      '{billingBypassed ? null : (\n          <div className="flex flex-wrap gap-2">',
    );
    assert.ok(idx > -1, "expected the button row to be wrapped in a billingBypassed guard");
    const block = src.slice(idx, src.indexOf("</div>\n        )}", idx));
    assert.match(block, /Pay setup fee/);
    assert.match(block, /to="\/app\/billing">/);
    assert.match(block, /\n\s+Billing\n/);
  });
});

describe("genuine setup-state UI (requirement 5) is never touched by the bypass", () => {
  test("the channel-cards section (Phone/Voice agent/WhatsApp/Website chatbot) contains no billingBypassed check at all", () => {
    const sectionStart = src.indexOf(
      '<div className="mt-5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">',
    );
    assert.ok(sectionStart > -1);
    const sectionEnd = src.indexOf("</SectionCard>", sectionStart);
    assert.ok(sectionEnd > -1);
    const section = src.slice(sectionStart, sectionEnd);
    assert.match(section, /\{channels\.map\(\(c\) => \(/);
    assert.doesNotMatch(section, /billingBypassed/);
  });

  test("channel hints reflect real setup completeness (published agent, active number), untouched by this change", () => {
    assert.match(src, /hint: voiceReady \? "Published" : "Not published"/);
    assert.match(src, /"Setup required"/);
  });
});
