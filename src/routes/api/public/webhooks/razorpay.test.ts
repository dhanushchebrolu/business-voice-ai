import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Route-level checks for the platform Razorpay webhook (a createFileRoute
 * handler this runner cannot import, so — as elsewhere in this repo — a
 * source scan). The behavior itself is tested in
 * src/lib/payments/razorpay-platform-webhook.server.test.ts and, for
 * record_razorpay_capture, on real PostgreSQL.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "razorpay.ts"), "utf8");

describe("platform Razorpay webhook route", () => {
  test("verifies the signature before parsing the payload", () => {
    const sigIdx = src.indexOf("verifySignature(raw, signature, secret)");
    const parseIdx = src.indexOf("JSON.parse(raw)");
    assert.ok(sigIdx > -1 && parseIdx > -1 && sigIdx < parseIdx);
  });

  test("goes through the event ledger and only acknowledges duplicates already processed", () => {
    const claimIdx = src.indexOf("claimWebhookEvent(");
    const processIdx = src.indexOf("processRazorpayPlatformEvent(");
    assert.ok(claimIdx > -1 && processIdx > claimIdx);
    assert.match(src, /if \(!decision\.process\) return new Response\("ok \(duplicate\)"\)/);
  });

  test("marks the event processed only after processing succeeded, and answers 500 on any failure", () => {
    const processIdx = src.indexOf("processRazorpayPlatformEvent(");
    const markIdx = src.indexOf("markWebhookEvent(supabaseAdmin, eventId, { processed: true");
    assert.ok(markIdx > processIdx);
    assert.match(src, /processed: false, error: message/);
    assert.match(src, /"Processing error", \{ status: 500 \}/);
    assert.match(src, /"Storage error", \{ status: 500 \}/);
  });

  test("no business logic or direct table writes remain in the route", () => {
    assert.doesNotMatch(src, /\.from\("(payments|invoices|payment_orders|organizations)"\)/);
  });
});
