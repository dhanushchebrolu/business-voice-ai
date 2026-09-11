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
 * not_provisioned customers. This is the fix, reusing the existing column
 * and write path — no new override concept, no lifecycle change, no fake
 * payment/invoice/subscription.
 *
 * Source-scanned, matching this repo's established convention for route
 * files this test runner can't import/render directly.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.tsx"), "utf8");

describe("setupPending respects an admin's payment_override", () => {
  test("setupPending is false whenever org.payment_override is true, regardless of lifecycle", () => {
    assert.match(
      src,
      /const setupPending =\s*\n?\s*!org\?\.payment_override &&\s*\n?\s*\(lifecycle === "not_provisioned" \|\| lifecycle === "setup_payment_pending"\);/,
    );
  });

  test("customerLocked (suspended/cancelled/archived) is untouched by payment_override — a locked customer stays locked", () => {
    const customerLockedIdx = src.indexOf("const customerLocked =");
    const nextSemicolon = src.indexOf(";", customerLockedIdx);
    const statement = src.slice(customerLockedIdx, nextSemicolon);
    assert.doesNotMatch(statement, /payment_override/);
    assert.match(statement, /lifecycle === "suspended"/);
  });

  test("lifecycle_status itself is never written by this route — payment_override only changes what the gate lets through", () => {
    assert.doesNotMatch(src, /lifecycle_status:\s*"active"/);
    assert.doesNotMatch(src, /\.update\(\{.*lifecycle/s);
  });
});
