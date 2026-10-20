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

  test("a processing failure answers 5xx so Meta retries (the event's claim is released first, and storage is idempotent)", () => {
    const catchIdx = src.indexOf("catch (err)");
    assert.ok(catchIdx > -1);
    assert.match(src.slice(catchIdx), /status: 500/);
  });

  test("never logs the raw payload", () => {
    assert.doesNotMatch(code, /console\.(log|error)\([^)]*\braw\b/);
  });
});

describe("POST is authenticated before anything is parsed or stored", () => {
  test("verifies X-Hub-Signature-256 first and answers 403 on failure", () => {
    const verifyIdx = code.indexOf("verifyWhatsAppWebhookSignature(raw");
    const processIdx = code.indexOf("processInboundWhatsAppWebhook(supabaseAdmin");
    const adminIdx = code.indexOf('import("@/integrations/supabase/client.server")');
    assert.ok(verifyIdx > -1 && processIdx > -1 && adminIdx > -1);
    assert.ok(verifyIdx < adminIdx && verifyIdx < processIdx);
    assert.match(code.slice(verifyIdx, adminIdx), /status: 403/);
    assert.match(code, /request\.headers\.get\("x-hub-signature-256"\)/);
  });

  test("hashes the exact raw body (no re-serialized JSON)", () => {
    assert.match(code, /const raw = await request\.text\(\)/);
    assert.match(code, /update\(raw\)/);
    assert.doesNotMatch(code, /request\.json\(\)/);
  });
});

describe("AI replies never delay Meta's acknowledgement", () => {
  test("replies run through runInBackground with the request's waitUntil, not awaited", () => {
    assert.match(code, /runInBackground\(\s*replyToInboundWhatsAppMessages\(/);
    assert.match(code, /getRequestWaitUntil\(request\)/);
    assert.doesNotMatch(code, /await replyToInboundWhatsAppMessages/);
  });

  test("only messages newly stored by this delivery are handed on", () => {
    assert.match(code, /result\.newInboundTextMessageIds/);
  });
});
