import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
 *
 * The landing page is composed from src/components/landing/*.tsx (nav,
 * hero, voice demo, etc.) rather than being a single file, so the scan
 * covers index.tsx plus every component it pulls in from that directory —
 * the same safety bar applies wherever the page's own markup/logic lives.
 */

const routeDir = dirname(fileURLToPath(import.meta.url));
const routeSrc = readFileSync(join(routeDir, "index.tsx"), "utf8");

const landingDir = join(routeDir, "..", "components", "landing");
const landingFiles = readdirSync(landingDir).filter((name) => name.endsWith(".tsx"));
const landingSources = landingFiles.map((name) => ({
  name,
  src: readFileSync(join(landingDir, name), "utf8"),
}));

const allSources = [{ name: "index.tsx", src: routeSrc }, ...landingSources];
const combinedSrc = allSources.map((f) => f.src).join("\n");

describe("/ (public landing page) has no auth/payment/entitlement/provider dependency", () => {
  test("no server-side auth/admin/entitlement gate is imported or referenced", () => {
    for (const { name, src } of allSources) {
      for (const forbidden of [
        "requireSupabaseAuth",
        "assertPlatformAdmin",
        "checkFeatureAccess",
        "assertFeatureUnlocked",
        "beforeLoad",
      ]) {
        assert.equal(src.includes(forbidden), false, `${name} must not reference ${forbidden}`);
      }
    }
  });

  test("no direct database table access — this page renders purely from static content, links and the existing dashboard-access hook", () => {
    // Matches real Supabase table access (`.from("table")` / `.from('table')`),
    // not incidental uses like `Array.from({ length })` in the canvas/animation code.
    assert.doesNotMatch(combinedSrc, /\.from\(\s*["']/);
    assert.doesNotMatch(
      combinedSrc,
      /organization_members|organizations\(|payment_orders|subscriptions/,
    );
  });

  test("no Sarvam/Razorpay/telephony/wallet import (marketing copy may still mention telephony in prose)", () => {
    for (const { name, src } of allSources) {
      const importLines = src
        .split("\n")
        .filter((line) => line.trim().startsWith("import "))
        .join("\n")
        .toLowerCase();
      for (const forbidden of ["sarvam", "razorpay", "telephony", "wallet"]) {
        assert.equal(
          importLines.includes(forbidden),
          false,
          `${name} must not import anything ${forbidden}-related`,
        );
      }
    }
  });

  test("the primary calls to action are plain links (/auth, /contact) — no gated action, no workspace/table writes on this page", () => {
    assert.match(combinedSrc, /to="\/auth"/);
    assert.match(combinedSrc, /to="\/contact"/);
    assert.doesNotMatch(combinedSrc, /\.insert\(/);
  });

  test("no dead interactive elements — every href/onClick is a real route, real scroll target, or real handler", () => {
    assert.doesNotMatch(combinedSrc, /href="#"/);
    assert.doesNotMatch(combinedSrc, /javascript:void/);
    assert.doesNotMatch(combinedSrc, /onClick=\{\(\)\s*=>\s*\{\}\}/);
    assert.doesNotMatch(combinedSrc, /alert\(/);
  });

  test("every nav-anchor id referenced by scrollToSection/getElementById exists as a real section id somewhere in the page", () => {
    const referencedIds = new Set<string>();
    for (const match of combinedSrc.matchAll(/scrollToSection\(["'`]([\w-]+)["'`]\)/g)) {
      referencedIds.add(match[1]!);
    }
    for (const match of combinedSrc.matchAll(/getElementById\(["'`]([\w-]+)["'`]\)/g)) {
      referencedIds.add(match[1]!);
    }
    // dynamic-only references (e.g. `scrollToSection(link.targetId!)`) aren't literal ids to check here
    referencedIds.delete("id");

    const definedIds = new Set<string>();
    for (const match of combinedSrc.matchAll(/\bid="([\w-]+)"/g)) {
      definedIds.add(match[1]!);
    }

    for (const id of referencedIds) {
      assert.ok(definedIds.has(id), `scroll target #${id} must exist as a real section id="${id}"`);
    }
    assert.ok(referencedIds.size > 0, "expected at least one scroll-to-section reference to check");
  });
});
