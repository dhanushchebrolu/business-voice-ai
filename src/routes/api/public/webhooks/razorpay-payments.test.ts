import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the customer-payment Razorpay webhook route's
 * security invariants. createFileRoute-based handler, so — consistent
 * with this repo's established convention for routes this test runner
 * cannot safely import/execute — a source scan, mirroring razorpay.test.ts
 * (the platform-billing webhook's own test) and google-calendar/
 * callback.test.ts.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "razorpay-payments.ts"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("uses its own, separate signing secret and idempotency stream", () => {
  test("uses getCustomerPaymentsWebhookSecret, never the platform-billing RAZORPAY_WEBHOOK_SECRET", () => {
    assert.match(src, /getCustomerPaymentsWebhookSecret/);
    assert.doesNotMatch(code, /RAZORPAY_WEBHOOK_SECRET/);
  });

  test("delegates idempotency/dedup entirely to processRazorpayPaymentWebhook (payment_webhook_events), never touches webhook_events", () => {
    assert.doesNotMatch(code, /\bwebhook_events\b/);
  });
});

describe("signature verification happens before any payload processing", () => {
  test("verifies the signature before calling processRazorpayPaymentWebhook", () => {
    const sigIdx = src.indexOf("verifySignature(raw, signature, secret)");
    const processIdx = src.indexOf("processRazorpayPaymentWebhook(");
    assert.ok(sigIdx > -1 && processIdx > -1);
    assert.ok(sigIdx < processIdx);
  });

  test("rejects a missing/invalid signature with 401, never processing the payload", () => {
    assert.match(src, /status: 401/);
  });

  test("never logs the raw payload or the signature", () => {
    assert.doesNotMatch(code, /console\.(log|error)\([^)]*\braw\b/);
    assert.doesNotMatch(code, /console\.(log|error)\([^)]*\bsignature\b/);
  });
});

describe("tenant identity is never read from the request by this route", () => {
  test("never reads organization_id/business_id from the request itself — resolution happens entirely inside processRazorpayPaymentWebhook", () => {
    assert.doesNotMatch(code, /organization_id/);
    assert.doesNotMatch(code, /business_id/);
  });
});

describe("failure handling never returns a raw/unhandled error", () => {
  test("a PaymentWebhookError maps to its own status code, not a generic 500", () => {
    assert.match(src, /err instanceof PaymentWebhookError/);
    assert.match(src, /err\.status/);
  });

  test("an unexpected error is caught and mapped to a fixed 500 response, never re-thrown raw", () => {
    assert.match(src, /catch \(err\)/);
    assert.match(src, /status: 500/);
  });
});

describe("consumer wiring is additive, not hardcoded to assume every subsystem exists", () => {
  test("passes the calendar, whatsapp, and voice consumers explicitly", () => {
    assert.match(src, /calendar: handlePaymentCapturedForCalendar/);
    assert.match(src, /whatsapp: handlePaymentEventForWhatsApp/);
    assert.match(src, /voice: handlePaymentEventForVoice/);
  });
});
