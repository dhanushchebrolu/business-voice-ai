import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDestination } from "./post-auth-destination-logic.ts";

test("an active platform admin always lands on /admin, even with a workspace", () => {
  assert.equal(
    deriveDestination({ isActivePlatformAdmin: true, organizationLifecycleStatus: "active" }),
    "/admin",
  );
});

test("a non-admin with a non-archived organization lands on /app", () => {
  for (const status of ["not_provisioned", "setup_payment_pending", "active", "suspended", "cancelled"]) {
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
    "/account",
  );
});

test("no organization at all lands on /account (never auto-provisioned)", () => {
  assert.equal(
    deriveDestination({ isActivePlatformAdmin: false, organizationLifecycleStatus: null }),
    "/account",
  );
});
