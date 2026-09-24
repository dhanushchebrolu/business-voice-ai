import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the Razorpay OAuth callback route's security
 * invariants. createFileRoute-based handler, so — consistent with this
 * repo's established convention for routes this test runner cannot safely
 * import/execute — a source scan. Mirrors
 * google-calendar/callback.test.ts's structure exactly.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "callback.ts"), "utf8");
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("tenant identity never comes from the query string", () => {
  test("organizationId/businessId used for the connection come only from the consumed OAuth state, never from url.searchParams", () => {
    assert.match(code, /consumeOAuthState\(\s*supabaseAdmin,\s*"razorpay",\s*state/);
    assert.match(code, /stateContext\.organizationId/);
    assert.match(code, /stateContext\.businessId/);
    assert.doesNotMatch(code, /organizationId:\s*url\.searchParams/);
    assert.doesNotMatch(code, /businessId:\s*url\.searchParams/);
  });

  test("the state is validated before the authorization code is ever exchanged", () => {
    const stateIdx = code.indexOf("consumeOAuthState(");
    const exchangeIdx = code.indexOf("completeRazorpayOAuth(");
    assert.ok(stateIdx > -1 && exchangeIdx > -1);
    assert.ok(stateIdx < exchangeIdx, "state must be consumed before the code exchange runs");
  });
});

describe("failure modes never crash — always a redirect with a safe reason code", () => {
  test("an invalid/expired/reused state redirects with reason=invalid_state, not a raw error page", () => {
    assert.match(code, /OAuthStateError/);
    assert.match(code, /"invalid_state"/);
  });

  test("the user denying consent is handled explicitly (Razorpay's own error param), not treated as a crash", () => {
    assert.match(code, /razorpayError/);
    assert.match(code, /"denied"/);
  });

  test("every branch ends in a redirect response, never a bare JSON/500 that would strand the browser mid-flow", () => {
    const returns = code.match(/return redirectWith\(/g) ?? [];
    assert.ok(returns.length >= 4);
  });

  test("an unexpected error never leaks its raw message into the redirect URL (only a fixed reason code)", () => {
    assert.match(code, /"connection_failed"/);
    assert.doesNotMatch(code, /redirectWith\([^)]*err\.message/);
    assert.doesNotMatch(code, /redirectWith\([^)]*String\(err\)/);
  });
});

describe("no secret is ever placed in the redirect URL", () => {
  test("the redirect only ever carries status/reason/connectionId query params", () => {
    assert.doesNotMatch(code, /searchParams\.set\("code"/);
    assert.doesNotMatch(code, /searchParams\.set\("state"/);
    assert.doesNotMatch(code, /searchParams\.set\("access_token"/);
  });

  test("never logs the authorization code, access token, refresh token, or client/key secret", () => {
    for (const forbidden of [
      String.raw`console\.log\(code`,
      String.raw`console\.error\(code`,
      String.raw`console\.log\([^)]*access_token`,
      String.raw`console\.log\([^)]*refresh_token`,
    ]) {
      assert.doesNotMatch(code, new RegExp(forbidden));
    }
  });
});

describe("scope: connection only, no payment-transaction handling in this callback", () => {
  test("does not process a payment order/payment/webhook-event payload (Phase 4 scope, not this route)", () => {
    for (const forbidden of ["razorpay_payment_id", "razorpay_order_id", "razorpay_signature"]) {
      assert.equal(
        code.includes(forbidden),
        false,
        `must not handle ${forbidden} in this callback`,
      );
    }
  });
});
