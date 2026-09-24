import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * createFileRoute-based handler, so — same established convention as
 * every other public route in this repo — a source scan.
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "expire-payments.ts"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("cron authentication is enforced before any expiration logic runs", () => {
  test("calls authenticateCronRequest and returns its error response before doing anything else", () => {
    const authIdx = src.indexOf("authenticateCronRequest(request)");
    const expireIdx = src.indexOf("expirePendingPayments(");
    assert.ok(authIdx > -1 && expireIdx > -1);
    assert.ok(authIdx < expireIdx);
    assert.match(src, /if \(authError\) return authError;/);
  });

  test("no organization/business id is read from the request itself — resolution happens entirely inside the sweep", () => {
    assert.doesNotMatch(code, /organization_id/);
    assert.doesNotMatch(code, /business_id/);
  });
});

describe("wires all three domain-event consumers, matching the webhook route", () => {
  test("passes calendar, whatsapp, and voice consumers to expirePendingPayments", () => {
    assert.match(src, /calendar: handlePaymentCapturedForCalendar/);
    assert.match(src, /whatsapp: handlePaymentEventForWhatsApp/);
    assert.match(src, /voice: handlePaymentEventForVoice/);
  });
});

describe("failure handling", () => {
  test("an unexpected error is caught and mapped to a 500, never re-thrown raw", () => {
    assert.match(src, /catch \(err\)/);
    assert.match(src, /status: 500/);
  });
});
