import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for /admin's route guard, confirming the invariants
 * this task must not weaken:
 *   - Admin authorization is resolved entirely server-side (getAdminSession /
 *     assertPlatformAdmin), never from a hardcoded email or a client-side
 *     check.
 *   - /admin has no dependency on customer workspace/organization state —
 *     an admin is never forced through customer setup/payment gating.
 * Source-scanned, matching this repo's established convention for route
 * files this test runner can't import/render directly.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "admin.tsx"), "utf8");

describe("/admin route guard", () => {
  test("unauthenticated visitors are redirected to /auth", () => {
    assert.match(src, /if \(!loading && !session\) navigate\(\{ to: "\/auth" \}\);/);
  });

  test("admin access is resolved via the server function, never a hardcoded email", () => {
    assert.match(src, /getAdminSession/);
    assert.doesNotMatch(src, /@gmail\.com/);
    assert.doesNotMatch(src, /chdhanush56/);
  });

  test("no workspace/organization/lifecycle/payment query is used to gate this route", () => {
    for (const forbidden of [
      "workspaceQuery",
      "organization_members",
      "lifecycle_status",
      "featureLocksQuery",
    ]) {
      assert.equal(src.includes(forbidden), false, `must not reference ${forbidden}`);
    }
  });
});
