import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deriveDestination } from "./post-auth-destination-logic.ts";

test("an active platform admin always lands on /admin, even with a workspace", () => {
  assert.equal(
    deriveDestination({ isActivePlatformAdmin: true, organizationLifecycleStatus: "active" }),
    "/admin",
  );
});

test("a non-admin with a non-archived organization lands on /app", () => {
  for (const status of [
    "not_provisioned",
    "setup_payment_pending",
    "active",
    "suspended",
    "cancelled",
  ]) {
    assert.equal(
      deriveDestination({ isActivePlatformAdmin: false, organizationLifecycleStatus: status }),
      "/app",
      `expected /app for lifecycle_status=${status}`,
    );
  }
});

test("an archived organization does not count as a workspace", () => {
  assert.equal(
    deriveDestination({ isActivePlatformAdmin: false, organizationLifecycleStatus: "archived" }),
    "/",
  );
});

test("no organization at all lands on / — the public website (never auto-provisioned)", () => {
  assert.equal(
    deriveDestination({ isActivePlatformAdmin: false, organizationLifecycleStatus: null }),
    "/",
  );
});

/**
 * Whole-app loading/performance audit: resolvePostAuthDestination
 * previously destructured only `data` from each of its two Supabase calls,
 * silently discarding `error` — a transient RLS/network blip read as "no
 * admin, no org" (misrouting a real member to the public site) rather than
 * surfacing anything. The two calls were also sequential despite being
 * independent reads.
 */
const resolveSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "post-auth-destination.ts"),
  "utf8",
);

test("both reads run in parallel via Promise.all, not sequentially", () => {
  assert.match(resolveSrc, /Promise\.all\(\[/);
});

test("both reads check their own error and throw, rather than silently defaulting to 'no admin, no org'", () => {
  assert.match(resolveSrc, /if \(adminRes\.error\) throw adminRes\.error;/);
  assert.match(resolveSrc, /if \(membershipRes\.error\) throw membershipRes\.error;/);
});
