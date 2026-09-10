import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Production incident regression coverage: the public "/" landing page must
 * never require customer auth, a workspace, setup payment, entitlement,
 * Razorpay, Sarvam, telephony, or platform-admin authorization — none of
 * that belongs on marketing surface, and pulling any of it in here is
 * exactly the shape of bug that took the whole site down (see
 * useAuth.test.ts for the actual fix: AuthProvider, which every route is
 * wrapped in via __root.tsx, no longer lets a Supabase failure crash
 * rendering). Source-scanned, matching this repo's established convention
 * for route files this test runner can't import/render directly.
 */

const routeSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.tsx"), "utf8");

describe("/ (public landing page) has no auth/payment/entitlement/provider dependency", () => {
  test("no server-side auth/admin/entitlement gate is imported or referenced", () => {
    for (const forbidden of [
      "requireSupabaseAuth",
      "assertPlatformAdmin",
      "checkFeatureAccess",
      "assertFeatureUnlocked",
      "beforeLoad",
    ]) {
      assert.equal(routeSrc.includes(forbidden), false, `must not reference ${forbidden}`);
    }
  });

  test("no direct database table access — this route renders purely from static content and links", () => {
    assert.doesNotMatch(routeSrc, /\.from\(/);
    assert.doesNotMatch(
      routeSrc,
      /organization_members|organizations\(|payment_orders|subscriptions/,
    );
  });

  test("no Sarvam/Razorpay/telephony/wallet import (marketing copy may still mention telephony in prose)", () => {
    const importLines = routeSrc
      .split("\n")
      .filter((line) => line.trim().startsWith("import "))
      .join("\n")
      .toLowerCase();
    for (const forbidden of ["sarvam", "razorpay", "telephony", "wallet"]) {
      assert.equal(
        importLines.includes(forbidden),
        false,
        `must not import anything ${forbidden}-related`,
      );
    }
  });

  test("the two calls to action are plain links (/auth, /contact) — no gated action, no workspace creation on this page", () => {
    assert.match(routeSrc, /to="\/auth"/);
    assert.match(routeSrc, /to="\/contact"/);
    assert.doesNotMatch(routeSrc, /\.insert\(/);
  });
});
