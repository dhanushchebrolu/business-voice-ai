import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The route file only wires production dependencies (this runner can't
 * execute createFileRoute handlers). The behaviour — 401 on a bad
 * signature, dedupe, background replies, 500 on failure — is tested at
 * runtime in src/lib/whatsapp/whatsapp-webhook-handler.server.test.ts.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "whatsapp.ts"), "utf8");
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("webhook route wiring", () => {
  test("POST only: the retired Meta GET handshake is gone", () => {
    assert.match(code, /POST:\s*async/);
    assert.doesNotMatch(code, /GET:/);
    assert.doesNotMatch(code, /hub\.challenge|verify_token|x-hub-signature/i);
  });

  test("delegates to the tested handler", () => {
    assert.match(code, /handleWhatsAppWebhookPost\(request, \{/);
  });

  test("AI replies run through runInBackground with the request's waitUntil, never awaited", () => {
    assert.match(code, /runInBackground\(\s*replyToInboundWhatsAppMessages\(/);
    assert.match(code, /getRequestWaitUntil\(req\)/);
    assert.doesNotMatch(code, /await replyToInboundWhatsAppMessages/);
  });
});
