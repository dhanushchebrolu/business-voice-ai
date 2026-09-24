import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Only the integrations this codebase actually has wired up (WhatsApp,
 * voice telephony, website chat) may be marked "Connect" — everything else
 * on the roadmap (Google Calendar, Razorpay, Instagram, CRMs, e-commerce)
 * must be marked "Coming soon" rather than presented as connectable when
 * no OAuth flow or credential storage exists for it yet.
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "integrations-section.tsx"),
  "utf8",
);

describe("IntegrationsSection is honest about which integrations can actually be connected today", () => {
  test("lists the required categories and providers", () => {
    for (const name of [
      "Google Calendar",
      "Razorpay",
      "HubSpot",
      "Zoho CRM",
      "Salesforce",
      "Pipedrive",
      "Shopify",
      "WooCommerce",
    ]) {
      assert.match(src, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  test("only integrations this codebase actually implements are marked connectable", () => {
    const groupsMatch = src.match(/GROUPS: [\s\S]*?= \[([\s\S]*?)\n\];/);
    assert.ok(groupsMatch, "expected a GROUPS array");
    const block = groupsMatch![1]!;
    const connectNames = [...block.matchAll(/name: "([^"]+)", status: "connect"/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(new Set(connectNames), new Set(["WhatsApp", "Voice", "Website Chat"]));
  });

  test("uses connect-style language, not raw API-key setup language", () => {
    assert.doesNotMatch(src, /enter your API key/i);
    assert.doesNotMatch(src, /paste your API key/i);
    assert.doesNotMatch(src, /Configure/i);
  });
});
