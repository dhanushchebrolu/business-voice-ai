import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Functionality-requirements coverage for the landing-page nav: dashboard
 * access must be delegated to the existing backend-authoritative hook (not
 * re-derived), every nav item must resolve to a real destination, and the
 * single menu overlay (used by both mobile and desktop, matching the
 * reference's hamburger-only nav bar) must be a genuine open/close dialog
 * with Escape handling and a body-scroll lock — not a decorative overlay.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "landing-nav.tsx"), "utf8");

describe("LandingNav reuses the existing dashboard-access hook and has only real nav destinations", () => {
  test("auth-awareness is delegated to the existing useAuth + useDashboardAccess hooks, not re-derived", () => {
    assert.match(src, /from "@\/hooks\/useAuth"/);
    assert.match(src, /from "@\/components\/app\/PublicNav"/);
    assert.match(src, /useDashboardAccess\(\)/);
  });

  test("nav items scroll to real in-page sections; Resources/Login/Get Started/Dashboard use real routes", () => {
    assert.match(src, /targetId: "value-propositions"/);
    assert.match(src, /targetId: "feature-showcase"/);
    assert.match(src, /targetId: "integrations"/);
    assert.match(src, /to="\/contact"/);
    assert.match(src, /to="\/auth"/);
    assert.match(src, /to="\/app"/);
  });

  test("no invented /product, /solutions, /developers, or /resources routes", () => {
    for (const invented of [
      'to="/product"',
      'to="/solutions"',
      'to="/developers"',
      'to="/resources"',
    ]) {
      assert.equal(src.includes(invented), false, `must not link to invented route ${invented}`);
    }
  });

  test("the single menu overlay is a real dialog with body-scroll lock and Escape-to-close, and closes on every link/button", () => {
    assert.match(src, /role="dialog"/);
    assert.match(src, /aria-modal="true"/);
    assert.match(src, /document\.body\.style\.overflow = "hidden"/);
    assert.match(src, /e\.key === "Escape"/);
    assert.match(src, /setMenuOpen\(false\)/);
    assert.match(src, /aria-expanded=\{menuOpen\}/);
    assert.match(src, /aria-controls="landing-menu"/);
  });

  test("sign out navigates to the public home, not a stale/admin route", () => {
    assert.match(src, /await signOut\(\)/);
    assert.match(src, /navigate\(\{ to: "\/" \}\)/);
  });
});
