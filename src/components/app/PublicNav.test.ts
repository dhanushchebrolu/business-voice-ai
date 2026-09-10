import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Production incident regression coverage: an authenticated visitor with no
 * customer workspace must see the normal public header (identity + Sign
 * out), never the signed-out Sign in / Get started controls, and never a
 * customer-only Dashboard link they don't have backend-confirmed access to.
 * Source-scanned, matching this repo's established convention for files
 * this test runner can't import/render directly (no jsdom/RTL).
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "PublicNav.tsx"), "utf8");

describe("PublicNav has three backend-authoritative states", () => {
  test("dashboard access is derived from workspaceQuery (RLS-scoped), never from session presence alone", () => {
    assert.match(src, /workspaceQuery\(/);
    assert.match(src, /hasDashboard\s*=\s*Boolean\(org\)/);
  });

  test("session && !loading && hasDashboard renders the Dashboard link", () => {
    const idx = src.indexOf("if (session && !loading && hasDashboard)");
    assert.ok(idx > -1);
    const block = src.slice(idx, idx + 400);
    assert.match(block, /to="\/app"/);
    assert.match(block, /Dashboard/);
  });

  test("session && !loading && !hasDashboard renders identity + Sign out, not Sign in/Get started", () => {
    const idx = src.indexOf("if (session && !loading && !hasDashboard)");
    assert.ok(idx > -1, "expected an authenticated-no-workspace branch");
    const nextBranchIdx = src.indexOf("return (\n    <nav", idx);
    const block = src.slice(idx, nextBranchIdx > -1 ? nextBranchIdx : idx + 2000);
    assert.match(block, /user\?\.email/);
    assert.match(block, /Sign out/);
    assert.doesNotMatch(block, /Get started/);
    assert.doesNotMatch(block, />Sign in</);
    assert.doesNotMatch(block, /to="\/app"/, "must not expose the customer dashboard link");
  });

  test("signing out from the authenticated-no-workspace state navigates to / (the public site), not /app or /admin", () => {
    const idx = src.indexOf("if (session && !loading && !hasDashboard)");
    const block = src.slice(idx, idx + 2000);
    assert.match(block, /await signOut\(\)/);
    assert.match(block, /navigate\(\{ to: "\/" \}\)/);
  });

  test("the final fallback branch (signed out) shows Sign in / Get started", () => {
    const lastReturnIdx = src.lastIndexOf("return (");
    const block = src.slice(lastReturnIdx);
    assert.match(block, /Sign in/);
    assert.match(block, /Get started/);
  });
});
