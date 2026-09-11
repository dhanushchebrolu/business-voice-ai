import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isDashboardLocked } from "./dashboard-access.ts";

/**
 * Real unit tests (not source-scanned) against the pure, shared dashboard-
 * access rule that both PublicNav (the navbar button) and /app (the actual
 * route) now use, so the two can never disagree again.
 */

describe("customer-level lock always wins", () => {
  for (const lifecycleStatus of ["suspended", "cancelled", "archived"] as const) {
    test(`${lifecycleStatus} is locked even with an explicit dashboard unlock and payment override`, () => {
      assert.equal(
        isDashboardLocked({ lifecycleStatus, paymentOverride: true, dashboardOverride: false }),
        true,
      );
    });
  }
});

describe("explicit admin lock for 'dashboard' wins over everything below it", () => {
  test("active org, no payment issue, but explicitly locked -> locked", () => {
    assert.equal(
      isDashboardLocked({
        lifecycleStatus: "active",
        paymentOverride: false,
        dashboardOverride: true,
      }),
      true,
    );
  });

  test("not_provisioned org with payment_override=true is still locked if explicitly locked", () => {
    assert.equal(
      isDashboardLocked({
        lifecycleStatus: "not_provisioned",
        paymentOverride: true,
        dashboardOverride: true,
      }),
      true,
    );
  });
});

describe("explicit admin unlock for 'dashboard' bypasses the setup-payment gate — the bug this fixes", () => {
  test("not_provisioned + no payment_override + explicit unlock -> NOT locked", () => {
    assert.equal(
      isDashboardLocked({
        lifecycleStatus: "not_provisioned",
        paymentOverride: false,
        dashboardOverride: false,
      }),
      false,
    );
  });

  test("setup_payment_pending + no payment_override + explicit unlock -> NOT locked", () => {
    assert.equal(
      isDashboardLocked({
        lifecycleStatus: "setup_payment_pending",
        paymentOverride: null,
        dashboardOverride: false,
      }),
      false,
    );
  });
});

describe("no explicit override -> falls back to the existing setup-payment gate, unchanged", () => {
  test("not_provisioned, no override row, no payment_override -> locked (setup pending)", () => {
    assert.equal(
      isDashboardLocked({
        lifecycleStatus: "not_provisioned",
        paymentOverride: false,
        dashboardOverride: null,
      }),
      true,
    );
  });

  test("not_provisioned, no override row, payment_override=true -> NOT locked (existing mechanism)", () => {
    assert.equal(
      isDashboardLocked({
        lifecycleStatus: "not_provisioned",
        paymentOverride: true,
        dashboardOverride: undefined,
      }),
      false,
    );
  });

  test("setup_payment_pending, no override, no payment_override -> locked", () => {
    assert.equal(
      isDashboardLocked({
        lifecycleStatus: "setup_payment_pending",
        paymentOverride: false,
        dashboardOverride: null,
      }),
      true,
    );
  });

  for (const lifecycleStatus of ["setup_paid", "provisioning", "ready", "active"] as const) {
    test(`${lifecycleStatus}, no override, no payment_override -> NOT locked`, () => {
      assert.equal(
        isDashboardLocked({ lifecycleStatus, paymentOverride: false, dashboardOverride: null }),
        false,
      );
    });
  }
});

describe("no organization at all", () => {
  test("null lifecycleStatus (no workspace) -> locked (nothing to show)", () => {
    assert.equal(
      isDashboardLocked({
        lifecycleStatus: null,
        paymentOverride: null,
        dashboardOverride: null,
      }),
      true,
    );
  });
});
