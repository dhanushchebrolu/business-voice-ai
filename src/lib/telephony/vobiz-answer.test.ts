import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for routes/api/public/webhooks/vobiz-answer.ts — the
 * one route whose job genuinely differs from every other telephony
 * webhook: Vobiz expects an immediate Voice XML response body, not just a
 * 200. Same source-scan approach as telephony-webhook-route.test.ts (this
 * repo's Node-native test runner cannot import a createFileRoute-based
 * route file directly) — the behavioral pieces (XML building, signature
 * verification, event normalization) are already unit-tested directly in
 * vobiz-xml.test.ts and vobiz-provider.test.ts; this suite verifies the
 * route file's own wiring: that it reuses, never duplicates, the existing
 * call-session pipeline.
 */

const routeSrc = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "routes",
    "api",
    "public",
    "webhooks",
    "vobiz-answer.ts",
  ),
  "utf8",
);

describe("vobiz-answer route — reuses the existing call-session pipeline, never a second copy", () => {
  test("imports processTelephonyEvent from the shared webhook route rather than reimplementing call_logs/entitlement/runtime-routing logic", () => {
    assert.match(routeSrc, /import\("@\/routes\/api\/public\/webhooks\/telephony"\)/);
    assert.match(routeSrc, /processTelephonyEvent\("vobiz", event, waitUntil\)/);
  });

  test("the shared pipeline call is fired in the background (runInBackground), not awaited — Vobiz is waiting on this response before it opens the media WebSocket", () => {
    assert.match(routeSrc, /runInBackground\(\s*processTelephonyEvent/);
  });

  test("reuses checkTelephonyAccess (the one entitlement gate every telephony path shares) rather than a parallel authorization rule", () => {
    assert.match(
      routeSrc,
      /import \{ checkTelephonyAccess, maskPhoneNumber \} from "@\/lib\/telephony-guard\.server"/,
    );
    assert.match(routeSrc, /checkTelephonyAccess\(\s*organizationId,\s*phoneNumberId,/);
  });

  test("verifies the webhook signature before anything from the payload is trusted", () => {
    const verifyIdx = routeSrc.indexOf("verifyWebhookSignature");
    const normalizeIdx = routeSrc.indexOf("normalizeWebhookEvent");
    assert.ok(verifyIdx > -1 && normalizeIdx > -1);
    assert.ok(verifyIdx < normalizeIdx);
  });

  test("registers both GET and POST handlers, matching the shared telephony route's own method-agnostic convention", () => {
    assert.match(routeSrc, /GET: \(\{ request \}\) => handleVobizAnswer\(request\)/);
    assert.match(routeSrc, /POST: \(\{ request \}\) => handleVobizAnswer\(request\)/);
  });

  test("a denied/unresolved call still gets valid XML back (never a bare error status Vobiz can't parse as call-flow instructions)", () => {
    const deniedCallSites = routeSrc.match(/buildVobizDeniedXml\(/g) ?? [];
    assert.ok(
      deniedCallSites.length >= 3,
      "expected denied-XML fallbacks for not-configured/invalid-signature/unresolved/denied-by-gate paths",
    );
  });

  test("an allowed call returns the real <Stream> XML pointing at the Vobiz media WS path, not a hardcoded placeholder host", () => {
    assert.match(routeSrc, /buildVobizStreamXml\(wsUrl\)/);
    assert.match(routeSrc, /VOBIZ_MEDIA_STREAM_PATH/);
    assert.match(routeSrc, /url\.protocol === "https:" \? "wss:" : "ws:"/);
  });

  test("outbound call correlation resolves via the existing call_logs row (provider_call_id already set synchronously by initiateOutboundCall), never a guessed/fabricated organization", () => {
    assert.match(routeSrc, /\.eq\("provider", "vobiz"\)/);
    assert.match(routeSrc, /\.eq\("provider_call_id", event\.providerCallId\)/);
  });

  test("inbound call resolution uses the same (e164, provider, active) lookup the shared webhook route uses — never a different rule", () => {
    assert.match(routeSrc, /\.eq\("e164", calledNumber\)/);
    assert.match(routeSrc, /\.eq\("provider", "vobiz"\)/);
    assert.match(routeSrc, /\.eq\("status", "active"\)/);
  });
});
