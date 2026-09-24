import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the inbound Meta WhatsApp webhook route.
 * createFileRoute-based handler, so — consistent with this repo's
 * established convention for routes this test runner cannot safely
 * import/execute — a source scan, mirroring razorpay-payments.test.ts.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "whatsapp.ts"), "utf8");
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("registers both GET (verification handshake) and POST (delivery/inbound) handlers", () => {
  test("has a GET handler", () => {
    assert.match(src, /GET:\s*\(/);
  });
  test("has a POST handler", () => {
    assert.match(src, /POST:\s*async/);
  });
});

describe("GET handshake never trusts an unverified caller", () => {
  test("delegates verification to verifyWebhookHandshake, never comparing tokens inline", () => {
    assert.match(src, /verifyWebhookHandshake/);
    assert.doesNotMatch(code, /===\s*process\.env/);
  });

  test("responds 403 when verification fails", () => {
    assert.match(src, /status: 403/);
  });
});

describe("POST processing never touches payment/booking state directly", () => {
  test("delegates entirely to processInboundWhatsAppWebhook", () => {
    assert.match(src, /processInboundWhatsAppWebhook/);
    assert.doesNotMatch(code, /\bpayment_requests\b/);
    assert.doesNotMatch(code, /\bbookings\b/);
  });

  test("dedupes via a hash of the raw body, since Meta sends no request-level event id", () => {
    assert.match(src, /createHash\("sha256"\)/);
  });

  test("always acks Meta with 200 even on an internal processing error, to avoid retry storms", () => {
    const catchIdx = src.indexOf("catch (err)");
    assert.ok(catchIdx > -1);
    const afterCatch = src.slice(catchIdx);
    assert.match(afterCatch, /status: 200/);
  });

  test("never logs the raw payload", () => {
    assert.doesNotMatch(code, /console\.(log|error)\([^)]*\braw\b/);
  });
});
