import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the Sarvam migration's tenant-isolation and
 * billing-reuse requirements on routes/api/public/webhooks/telephony.ts.
 *
 * This is a createFileRoute-based route file, which this repo's Node-native
 * test runner cannot import directly (established convention — see e.g.
 * service-lock-message.test.ts, constant-time-equals.server.test.ts). The
 * behavioral pieces that don't need a live Supabase connection are already
 * unit-tested directly in webhook-correlation.server.test.ts and
 * sarvam-provider.server.test.ts; this suite statically verifies the route
 * file's own wiring — that it actually calls into that logic correctly, and
 * that the invariants requirement F/G depend on (never fabricate tenant
 * attribution, always reuse the existing billing pipeline unmodified) hold
 * in the source as written.
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
    "telephony.ts",
  ),
  "utf8",
);

describe("telephony webhook route — signature verification and idempotency (unchanged)", () => {
  test("verifies the webhook signature before anything from the payload is trusted", () => {
    const verifyIdx = routeSrc.indexOf("verifyWebhookSignature");
    const normalizeIdx = routeSrc.indexOf("normalizeWebhookEvent");
    assert.ok(verifyIdx > -1 && normalizeIdx > -1);
    assert.ok(
      verifyIdx < normalizeIdx,
      "signature must be verified before the event is normalized/trusted",
    );
  });

  test("dedupes via the existing webhook_events (provider, event_id) unique index before any side effect", () => {
    assert.match(routeSrc, /from\("webhook_events"\)\s*\.insert\(/);
    assert.match(routeSrc, /code.*===\s*"23505"/);
    assert.match(routeSrc, /"ok \(duplicate\)"/);
  });
});

describe("telephony webhook route — inbound tenant resolution (unchanged from pre-Sarvam)", () => {
  test("resolves the organization from Klyro's own phone_numbers table, keyed on the called number + active status", () => {
    assert.match(routeSrc, /from\("phone_numbers"\)/);
    assert.match(routeSrc, /\.eq\("e164", vaaniNumber\)/);
    assert.match(routeSrc, /\.eq\("status", "active"\)/);
  });

  test("there is exactly one call_logs INSERT in the whole route, and it only fires on the inbound (not outbound) new-call path", () => {
    const inserts = [...routeSrc.matchAll(/from\("call_logs"\)\s*\.insert\(/g)];
    assert.equal(
      inserts.length,
      1,
      "outbound events must never INSERT a call_logs row from webhook data alone",
    );
  });

  test("the inbound insert persists organization_id from the resolved phone_numbers row, never from the event payload", () => {
    assert.match(routeSrc, /organization_id:\s*phoneNumber\.organization_id/);
    assert.doesNotMatch(routeSrc, /organization_id:\s*event\./);
  });

  test("persists transcript, duration and ended_at on the inbound insert (Sarvam's one-shot terminal webhook)", () => {
    assert.match(routeSrc, /ended_at:\s*isTerminal \? event\.occurredAt : null/);
    assert.match(routeSrc, /duration_seconds:\s*event\.durationSeconds \?\? 0/);
    assert.match(routeSrc, /transcript:\s*event\.transcript/);
    assert.match(routeSrc, /provider_metadata:\s*buildProviderMetadata\(event\)/);
  });
});

describe("telephony webhook route — outbound tenant correlation (Sarvam addition)", () => {
  test("imports the correlation helpers from webhook-correlation.server, not ad hoc logic", () => {
    assert.match(
      routeSrc,
      /import\s*\{\s*buildProviderMetadata,\s*\n?\s*isPlausibleClientReference,?\s*\}\s*from\s*"@\/lib\/telephony\/webhook-correlation\.server"/,
    );
  });

  test("an outbound event with no existing call_logs row is resolved ONLY via a validated clientReference, never via phone number or any other field", () => {
    const outboundBranch = routeSrc.slice(
      routeSrc.indexOf('if (event.direction === "outbound") {'),
      routeSrc.indexOf("const vaaniNumber ="),
    );
    assert.match(outboundBranch, /isPlausibleClientReference\(event\.clientReference\)/);
    assert.match(
      outboundBranch,
      /resolveOutboundCallByClientReference\(providerId, event\.clientReference\)/,
    );
    // Never falls back to attributing by phone number/caller id for outbound.
    assert.doesNotMatch(outboundBranch, /fromE164|toE164|vaaniE164|user_phone_number|caller/i);
  });

  test("an unresolved outbound event is dropped (logged, no row created/updated), never guessed", () => {
    const outboundBranch = routeSrc.slice(
      routeSrc.indexOf('if (event.direction === "outbound") {'),
      routeSrc.indexOf("const vaaniNumber ="),
    );
    assert.match(outboundBranch, /if \(!resolved\) \{/);
    assert.match(outboundBranch, /telephony:webhook_unknown_outbound_call/);
  });

  test("resolveOutboundCallByClientReference only ever looks up a row Klyro already owns (by id, provider, direction) — it cannot invent one", () => {
    const fnSrc = routeSrc.slice(
      routeSrc.indexOf("async function resolveOutboundCallByClientReference"),
      routeSrc.indexOf("async function applyCallEvent"),
    );
    assert.doesNotMatch(fnSrc, /\.insert\(/);
    assert.match(fnSrc, /\.eq\("id", clientReference\)/);
    assert.match(fnSrc, /\.eq\("provider", providerId\)/);
    assert.match(fnSrc, /\.eq\("direction", "outbound"\)/);
  });
});

describe("telephony webhook route — reassignment safety (Phase 5 §8)", () => {
  test("the inbound phone_numbers lookup is scoped by provider, not just e164+active", () => {
    const idx = routeSrc.indexOf('.from("phone_numbers")');
    assert.ok(idx > -1);
    const block = routeSrc.slice(idx, idx + 250);
    assert.match(block, /\.eq\("e164", vaaniNumber\)/);
    assert.match(block, /\.eq\("provider", providerId\)/);
    assert.match(block, /\.eq\("status", "active"\)/);
  });

  test("a mismatched event.providerDeploymentId vs phoneNumber.provider_deployment_id is dropped before checkTelephonyAccess/call_logs insert are ever reached", () => {
    const lookupIdx = routeSrc.indexOf('.from("phone_numbers")');
    const mismatchIdx = routeSrc.indexOf("telephony:webhook_stale_deployment_mismatch");
    const gateIdx = routeSrc.indexOf("checkTelephonyAccess(phoneNumber.organization_id");
    const insertIdx = routeSrc.indexOf('.from("call_logs")\n    .insert(');
    assert.ok(lookupIdx > -1 && mismatchIdx > -1 && gateIdx > -1 && insertIdx > -1);
    assert.ok(lookupIdx < mismatchIdx && mismatchIdx < gateIdx && gateIdx < insertIdx);
  });

  test("the mismatch check compares Klyro's own on-file mapping, never trusts the event alone, and requires both sides present before blocking", () => {
    const idx = routeSrc.indexOf("telephony:webhook_stale_deployment_mismatch");
    const block = routeSrc.slice(Math.max(0, idx - 500), idx);
    assert.match(block, /event\.providerDeploymentId\s*&&/);
    assert.match(block, /phoneNumber\.provider_deployment_id\s*&&/);
    assert.match(block, /event\.providerDeploymentId\s*!==\s*phoneNumber\.provider_deployment_id/);
  });

  test("does not attempt to attribute a mismatched event to any organization other than the currently-active one — it only ever returns (drops), never a second lookup/insert", () => {
    const startIdx = routeSrc.indexOf("telephony:webhook_stale_deployment_mismatch");
    const blockEnd = routeSrc.indexOf("const gate = await checkTelephonyAccess", startIdx);
    const block = routeSrc.slice(startIdx, blockEnd);
    assert.doesNotMatch(block, /\.insert\(/);
    assert.doesNotMatch(block, /\.from\("phone_numbers"\)/);
    assert.match(block, /return;/);
  });
});

describe("telephony webhook route — billing/entitlement reuse (requirement E: do not rewrite)", () => {
  test("still imports and calls the exact existing telephony-guard.server functions, not a parallel implementation", () => {
    assert.match(
      routeSrc,
      /import\s*\{\s*\n?\s*checkCallTransition,\s*\n?\s*checkTelephonyAccess,\s*\n?\s*finalizeCallBilling,\s*\n?\s*TERMINAL_CALL_STATUSES,?\s*\n?\s*\}\s*from\s*"@\/lib\/telephony-guard\.server"/,
    );
    assert.match(routeSrc, /checkTelephonyAccess\(/);
    assert.match(routeSrc, /checkCallTransition\(/);
    assert.match(routeSrc, /finalizeCallBilling\(/);
  });

  test("finalizeCallBilling is only ever invoked once a status is confirmed terminal via the shared TERMINAL_CALL_STATUSES list", () => {
    const occurrences = [...routeSrc.matchAll(/finalizeCallBilling\(/g)];
    assert.equal(
      occurrences.length,
      2,
      "expected exactly the two existing call sites (new-call and patch paths)",
    );
  });
});
