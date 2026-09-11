import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the customer-facing phone-number request flow
 * (Part 10/11). Real Sarvam number rental has no verified endpoint
 * anywhere in this codebase (sarvam-provider.server.ts's provisionNumber
 * hard-throws 501 by design) — this function must never fake that. It only
 * queues a real, auditable request after enforcing every access check a
 * genuine provisioning action would need. Source-scanned, matching this
 * repo's convention for createServerFn modules.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "telephony-customer.functions.ts"),
  "utf8",
);

describe("requestPhoneNumber never fakes provisioning", () => {
  test("no phone_numbers INSERT/UPDATE anywhere in this file", () => {
    const fromPhoneNumbersIdx = src.indexOf('.from("phone_numbers")');
    assert.ok(
      fromPhoneNumbersIdx > -1,
      "expected a read of phone_numbers (to check for an existing number)",
    );
    // The only interaction with phone_numbers must be a read.
    const block = src.slice(fromPhoneNumbersIdx, fromPhoneNumbersIdx + 200);
    assert.match(block, /\.select\(/);
    assert.doesNotMatch(src, /\.from\("phone_numbers"\)[\s\S]{0,200}\.insert\(/);
    assert.doesNotMatch(src, /\.from\("phone_numbers"\)[\s\S]{0,200}\.update\(/);
  });

  test("no reference to a Sarvam number-rental/provisioning API call", () => {
    assert.doesNotMatch(src, /\bprovisionNumber\(/);
    assert.doesNotMatch(src, /sarvam-api-client/);
  });

  test("the actual write is a customer_events row (the same generic per-org timeline table Customer 360 already reads), not a new table", () => {
    assert.match(src, /\.from\("customer_events"\)\.insert\(/);
    assert.match(src, /kind: "phone_number_requested"/);
  });
});

describe("organization resolution never trusts a client-supplied id", () => {
  test("organizationId comes from the authenticated user's own organization_members row via the RLS-scoped client, never from input", () => {
    assert.doesNotMatch(src, /inputValidator/);
    const idx = src.indexOf('.from("organization_members")');
    assert.ok(idx > -1);
    const block = src.slice(idx - 60, idx + 200);
    assert.match(block, /context\.supabase/);
    assert.match(block, /eq\("user_id", context\.userId\)/);
  });

  test("requireSupabaseAuth gates the whole handler — no path reachable while unauthenticated", () => {
    assert.match(src, /\.middleware\(\[requireSupabaseAuth\]\)/);
  });
});

describe("the phone feature gate runs before any request is queued, and rejects even a direct call", () => {
  test('assertFeatureUnlocked(organizationId, "phone") is called — the same gate checkTelephonyAccess enforces for real calls', () => {
    const gateIdx = src.indexOf('assertFeatureUnlocked(organizationId, "phone")');
    const insertIdx = src.indexOf('.from("customer_events")');
    assert.ok(gateIdx > -1 && insertIdx > -1);
    assert.ok(gateIdx < insertIdx, "the feature gate must run before the request is queued");
  });

  test("assertFeatureUnlocked throws (never returns a boolean to silently ignore) — a locked customer cannot reach the insert at all", () => {
    // Confirmed against feature-gate.server.ts's own contract: assertFeatureUnlocked
    // throws on !gate.allowed and returns void otherwise — no return value this
    // file could accidentally ignore.
    assert.match(src, /await assertFeatureUnlocked\(organizationId, "phone"\);/);
  });
});

describe("idempotency: repeated calls never queue duplicate requests or ignore an existing number", () => {
  test("an org that already has a live (non-released) number short-circuits before any request is queued", () => {
    const idx = src.indexOf("alreadyHasNumber: true");
    assert.ok(idx > -1);
    const before = src.slice(0, idx);
    assert.match(before, /\.neq\("status", "released"\)/);
  });

  test("a second call while a request is already pending does not insert a second customer_events row", () => {
    assert.match(src, /if \(!recentRequest\) \{/);
  });
});

describe("provider readiness is reported, never fabricated", () => {
  test("readiness is derived from an existing telephony_connections row for this org+provider, not assumed true", () => {
    const idx = src.indexOf('.from("telephony_connections")');
    assert.ok(idx > -1);
    const block = src.slice(idx, idx + 200);
    assert.match(block, /eq\("provider", "sarvam"\)/);
  });
});
