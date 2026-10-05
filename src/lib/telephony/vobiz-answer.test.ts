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
      /import\s*\{\s*\n?\s*checkTelephonyAccess,\s*\n?\s*resolveActivePhoneNumberByDestination,?\s*\n?\s*\}\s*from\s*"@\/lib\/telephony-guard\.server"/,
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

  test("inbound call resolution uses the shared resolveActivePhoneNumberByDestination helper — the same (e164, provider, active) rule the shared webhook route uses, case-insensitive on provider (see telephony-guard.server.test.ts's own regression coverage for why)", () => {
    assert.match(
      routeSrc,
      /const phoneNumber = await resolveActivePhoneNumberByDestination\("vobiz", calledNumber\);/,
    );
  });
});

describe('unresolved-call diagnostic (production incident: +918071580870 — provider stored as "Vobiz" vs. the code\'s lowercase "vobiz"; fixed via resolveActivePhoneNumberByDestination\'s case-insensitive match, see telephony-guard.server.ts/.test.ts)', () => {
  test("logs the exact (unmasked) queried value plus any matching phone_numbers rows regardless of provider/status — a destination DID routed to a business's own line is not a secret", () => {
    assert.match(routeSrc, /vobiz_answer:unresolved_call/);
    assert.match(routeSrc, /calledNumber,/);
    assert.match(routeSrc, /matchingRowsForNumber/);
  });

  test("the diagnostic log block never references headers, auth tokens, verify_token, or signature/nonce values — only event/payload-derived, non-secret fields", () => {
    const unresolvedIdx = routeSrc.indexOf('console.error("vobiz_answer:unresolved_call"');
    assert.ok(unresolvedIdx > -1);
    const block = routeSrc.slice(unresolvedIdx, routeSrc.indexOf("});", unresolvedIdx));
    assert.doesNotMatch(block, /\bheaders\b/);
    assert.doesNotMatch(block, /authToken/);
    assert.doesNotMatch(block, /webhookVerifyToken/);
    assert.doesNotMatch(block, /x-vobiz-signature/i);
    assert.doesNotMatch(block, /\bnonce\b/i);
  });

  test("the verbose TEMPORARY diagnostics added in commit 0ceb15f (raw-field dump, destination_diagnostic log) are gone now that the root cause is confirmed and fixed", () => {
    assert.doesNotMatch(routeSrc, /vobiz_answer:destination_diagnostic/);
    assert.doesNotMatch(routeSrc, /rawFieldsPresent/);
    assert.doesNotMatch(routeSrc, /calledNumberExact/);
  });
});

describe("stream_response diagnostic (production incident: media WebSocket never reached us at all — no log confirmed which XML branch this route actually returned)", () => {
  test("logs immediately before the Stream-XML return, the only log statement on this route's success path", () => {
    const logIdx = routeSrc.indexOf('console.info("vobiz_answer:stream_response"');
    const returnIdx = routeSrc.indexOf("return xmlResponse(buildVobizStreamXml(wsUrl));");
    assert.ok(logIdx > -1, "expected a vobiz_answer:stream_response log");
    assert.ok(returnIdx > -1);
    assert.ok(
      logIdx < returnIdx,
      "the diagnostic must log before returning the Stream XML, not after",
    );
    // There must be exactly one Stream-XML return in the whole file (the
    // success path), and the log must sit directly before it — not before
    // some other, earlier return.
    assert.strictEqual(
      (routeSrc.match(/return xmlResponse\(buildVobizStreamXml\(wsUrl\)\);/g) ?? []).length,
      1,
    );
  });

  test("records the HTTP method, the wsUrl Vobiz was told to connect to, and that the Stream branch was reached", () => {
    const logIdx = routeSrc.indexOf('console.info("vobiz_answer:stream_response"');
    assert.ok(logIdx > -1);
    const block = routeSrc.slice(logIdx, routeSrc.indexOf("});", logIdx));
    assert.match(block, /method: request\.method/);
    assert.match(block, /wsUrl,/);
    assert.match(block, /calledNumber,/);
    assert.match(block, /streamXmlReturned: true/);
  });

  test("carries a non-sensitive per-invocation id so two answer_url deliveries for the same call (e.g. a duplicate delivery) can be told apart in logs", () => {
    assert.match(routeSrc, /const invocationId = crypto\.randomUUID\(\)/);
    const logIdx = routeSrc.indexOf('console.info("vobiz_answer:stream_response"');
    const block = routeSrc.slice(logIdx, routeSrc.indexOf("});", logIdx));
    assert.match(block, /invocationId,/);
  });

  test("never logs the webhook verify token, Vobiz signature, auth token, or any other secret", () => {
    const logIdx = routeSrc.indexOf('console.info("vobiz_answer:stream_response"');
    assert.ok(logIdx > -1);
    const block = routeSrc.slice(logIdx, routeSrc.indexOf("});", logIdx));
    assert.doesNotMatch(block, /\bheaders\b/);
    assert.doesNotMatch(block, /authToken/);
    assert.doesNotMatch(block, /webhookVerifyToken/);
    assert.doesNotMatch(block, /x-vobiz-signature/i);
    assert.doesNotMatch(block, /\bnonce\b/i);
    assert.doesNotMatch(block, /\braw\b/);
  });

  test("does not change the actual XML generation or call flow — buildVobizStreamXml is still called with the same wsUrl immediately after", () => {
    const logIdx = routeSrc.indexOf('console.info("vobiz_answer:stream_response"');
    const afterLog = routeSrc.slice(routeSrc.indexOf("});", logIdx));
    assert.match(afterLog, /^\s*\}\);\s*\n\s*return xmlResponse\(buildVobizStreamXml\(wsUrl\)\);/);
  });
});
