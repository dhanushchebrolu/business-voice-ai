import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Production incident regression coverage: an authenticated visitor with no
 * customer dashboard access must see the normal public header (identity +
 * Sign out), never the signed-out Sign in / Get started controls, and never
 * a customer-only Dashboard link they don't have backend-confirmed access
 * to. Conversely, an authenticated customer WITH access must see identity +
 * Sign out AND the Dashboard button together — "Vaani | Pricing | Dashboard
 * | user@email.com" — not one or the other.
 *
 * Source-scanned, matching this repo's established convention for files
 * this test runner can't import/render directly (no jsdom/RTL).
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "PublicNav.tsx"), "utf8");

describe("PublicNav has two backend-authoritative signed-in-vs-not branches, plus a Dashboard button that shows/hides within the signed-in one", () => {
  test("dashboard access is derived from workspaceQuery + the shared isDashboardLocked rule, never from session presence alone", () => {
    assert.match(src, /workspaceQuery\(/);
    assert.match(src, /isDashboardLocked\(/);
    assert.match(src, /hasDashboard\s*=\s*\n?\s*Boolean\(org\)/);
  });

  test("the signed-in branch always renders identity + Sign out, and additionally the Dashboard link only when hasDashboard is true", () => {
    const idx = src.indexOf("if (session && !loading) {");
    assert.ok(idx > -1, "expected a single merged signed-in branch");
    const nextReturnIdx = src.indexOf("return (", idx + 20);
    const closingIdx = src.indexOf("\n  }\n\n  return (", nextReturnIdx);
    const block = src.slice(idx, closingIdx > -1 ? closingIdx : idx + 2500);

    assert.match(block, /hasDashboard \? \(/);
    assert.match(block, /to="\/app"/);
    assert.match(block, />Dashboard</);
    assert.match(block, /user\?\.email/);
    assert.match(block, /Sign out/);
    assert.doesNotMatch(block, /Get started/);
    assert.doesNotMatch(block, />Sign in</);
  });

  test("signing out from the signed-in state navigates to / (the public site), not /app or /admin", () => {
    const idx = src.indexOf("if (session && !loading) {");
    const block = src.slice(idx, idx + 2500);
    assert.match(block, /await signOut\(\)/);
    assert.match(block, /navigate\(\{ to: "\/" \}\)/);
  });

  test("the final fallback branch (signed out) shows Sign in / Get started, never a Dashboard link", () => {
    const lastReturnIdx = src.lastIndexOf("return (");
    const block = src.slice(lastReturnIdx);
    assert.match(block, /Sign in/);
    assert.match(block, /Get started/);
    assert.doesNotMatch(block, /to="\/app"/);
  });
});
