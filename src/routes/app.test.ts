import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Production incident regression coverage for /app's route guard:
 *   - Unauthenticated visitors are sent to /auth (unchanged).
 *   - An authenticated visitor with no organization/workspace is sent back
 *     to the public website ("/"), never to /account — a customer workspace
 *     is provisioned only by a platform admin, so a signed-in user without
 *     one is an expected state, not an error, and must not be routed to a
 *     dead-end or admin-only surface.
 * Source-scanned, matching this repo's established convention for route
 * files this test runner can't import/render directly.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.tsx"), "utf8");

describe("/app route guard", () => {
  test("unauthenticated visitors are redirected to /auth", () => {
    assert.match(src, /if \(!loading && !session\) navigate\(\{ to: "\/auth" \}\);/);
  });

  test("an authenticated visitor with no workspace is redirected to / (the public site), not /account", () => {
    assert.match(
      src,
      /if \(!loading && session && !isLoading && !org\) navigate\(\{ to: "\/" \}\);/,
    );
    assert.doesNotMatch(src, /navigate\(\{ to: "\/account" \}\)/);
  });

  test("still gates on workspace/lifecycle/feature-lock state before rendering the Shell — no weakening of customer gating", () => {
    assert.match(src, /showLockedScreen/);
    assert.match(src, /AccountLocked/);
    assert.match(src, /featureLocksQuery/);
  });
});
