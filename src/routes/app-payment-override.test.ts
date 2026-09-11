import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for Phase H: organizations.payment_override (Phase B
 * — setPaymentOverride / CustomerControlPanel's existing "Override payment
 * requirement" control) previously had no effect on /app's dashboard gate.
 * feature_locked()'s own SQL already treats payment_override as sufficient
 * to unlock the "dashboard" feature (it short-circuits before the lifecycle
 * gate whenever payment_override is true), but app.tsx computed
 * setupPending from raw lifecycle_status alone and ignored it, so an admin
 * demo override could never actually reach setup_payment_pending/
 * not_provisioned customers.
 *
 * That fix was later folded into a single shared rule — isDashboardLocked
 * (src/lib/dashboard-access.ts, with its own full behavioral test suite in
 * dashboard-access.test.ts) — used by both app.tsx and PublicNav, as part
 * of fixing a related bug: an explicit admin "Dashboard access" unlock
 * (organization_feature_locks) also failed to bypass the setup-payment
 * gate, for the same reason (a hand-rolled setupPending computation that
 * ignored the relevant override). This file now only proves the wiring —
 * that app.tsx actually passes payment_override and lifecycle_status
 * through to the shared rule, and never fabricates lifecycle_status itself
 * — since the boolean logic itself is covered exhaustively elsewhere.
 *
 * Source-scanned, matching this repo's established convention for route
 * files this test runner can't import/render directly.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.tsx"), "utf8");

describe("app.tsx's dashboard gate is wired to the shared isDashboardLocked rule", () => {
  test("showLockedScreen is computed by isDashboardLocked, not a hand-rolled boolean", () => {
    assert.match(src, /const showLockedScreen = isDashboardLocked\(\{/);
  });

  test("org.payment_override is passed through to the shared rule", () => {
    const idx = src.indexOf("const showLockedScreen = isDashboardLocked({");
    const block = src.slice(idx, idx + 300);
    assert.match(block, /paymentOverride:\s*org\?\.payment_override/);
  });

  test("org.lifecycle_status is passed through, never a hardcoded/fabricated value", () => {
    const idx = src.indexOf("const showLockedScreen = isDashboardLocked({");
    const block = src.slice(idx, idx + 300);
    assert.match(block, /lifecycleStatus:\s*org\?\.lifecycle_status/);
  });

  test("lifecycle_status itself is never written by this route — payment_override/dashboard override only change what the gate lets through", () => {
    assert.doesNotMatch(src, /lifecycle_status:\s*"active"/);
    assert.doesNotMatch(src, /\.update\(\{.*lifecycle/s);
  });
});
