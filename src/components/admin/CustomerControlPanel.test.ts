import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for Phase H's "granted by / granted at" surfacing on
 * the existing payment-override control (Part 9/12's demo-access
 * indicator). Source-scanned — no jsdom/RTL in this repo's test runner.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "CustomerControlPanel.tsx"),
  "utf8",
);
const routeSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "routes", "admin.customers.$orgId.tsx"),
  "utf8",
);

describe("payment access panel distinguishes PAYMENT from ACCESS OVERRIDE", () => {
  test("the pill shows Locked/Unlocked, never a fabricated payment status", () => {
    assert.match(src, /\{paymentOverride \? "Unlocked" : "Locked"\}/);
  });

  test("an active override explicitly states no payment/invoice/subscription was created", () => {
    assert.match(src, /Admin demo override — no payment, invoice or subscription was created\./);
  });

  test("granted-by/granted-at only render when an override is actually active", () => {
    const idx = src.indexOf("paymentOverride && (paymentOverrideByEmail || paymentOverrideAt)");
    assert.ok(idx > -1);
  });
});

describe("Customer 360 sources granted-by from the audit trail, not a guess", () => {
  test("paymentOverrideByEmail is derived from the most recent PAYMENT_OVERRIDE_SET/CLEARED audit entry", () => {
    assert.match(
      routeSrc,
      /action === "PAYMENT_OVERRIDE_SET" \|\| a\.action === "PAYMENT_OVERRIDE_CLEARED"/,
    );
  });

  test("paymentOverrideAt comes from organizations.payment_override_at — the real column written by setPaymentOverride, not a client-side timestamp", () => {
    assert.match(routeSrc, /payment_override_at\?: string \| null/);
  });
});
