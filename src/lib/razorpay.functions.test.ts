import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scan coverage for the Razorpay dashboard server functions — same
 * convention as google-calendar.functions.test.ts for createServerFn
 * modules (no live Supabase/auth harness in this environment).
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "razorpay.functions.ts"),
  "utf8",
);
// Actual code only — strips the file's own doc comments, which legitimately
// discuss (in prose) the column this file must never select/return.
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("authentication and tenant derivation", () => {
  test("every exported server function is gated by requireSupabaseAuth", () => {
    const matches = src.match(/\.middleware\(\[requireSupabaseAuth\]\)/g) ?? [];
    assert.equal(
      matches.length,
      7,
      "listRazorpayConnections, getRazorpayIntegrationStatus, startRazorpayConnection, reconnectRazorpayConnection, verifyRazorpayConnection, disconnectRazorpayConnection, listOrgBusinessesForRazorpay",
    );
  });

  test("organizationId always comes from organization_members via resolveOrgId, never from client input", () => {
    assert.match(src, /await resolveOrgId\(context\)/);
    assert.doesNotMatch(src, /organizationId:\s*(data|input)\./);
  });

  test("no input schema accepts an organizationId or businessId-as-tenant-identity field beyond the one intentional businessId selector input", () => {
    assert.doesNotMatch(src, /organizationId:\s*z\./);
  });

  test("business ownership is explicitly re-validated before starting a connection", () => {
    assert.match(src, /assertBusinessOwnership\(/);
    assert.match(src, /business\.organization_id !== organizationId/);
  });

  test("connection ownership is explicitly re-validated before reconnect/verify/disconnect", () => {
    assert.match(src, /connection\.organization_id !== organizationId/);
  });
});

describe("credential handling", () => {
  test("never returns encrypted_credentials, an access token, a refresh token, or a client/key secret to the caller", () => {
    for (const forbidden of [
      "encrypted_credentials",
      "accessToken",
      "refreshToken",
      "access_token",
      "refresh_token",
      "clientSecret",
      "client_secret",
      "keySecret",
    ]) {
      assert.equal(code.includes(forbidden), false, `must not reference/return ${forbidden}`);
    }
  });

  test("uses server-generated OAuth state, never trusts a client-supplied one", () => {
    assert.match(src, /createOAuthState\(/);
  });

  test("start and reconnect both build the authorization URL through the shared razorpay-oauth module, not a hand-written URL", () => {
    const matches = src.match(/buildAuthorizationUrl\(/g) ?? [];
    assert.equal(matches.length, 2, "startRazorpayConnection and reconnectRazorpayConnection");
  });
});

describe("mutations use the privileged client because RLS has no authenticated write policy for this table", () => {
  test("start/reconnect/verify/disconnect all go through supabaseAdmin", () => {
    const mutationFns = [
      "startRazorpayConnection",
      "reconnectRazorpayConnection",
      "verifyRazorpayConnection",
      "disconnectRazorpayConnection",
    ];
    for (const fn of mutationFns) {
      const start = src.indexOf(`export const ${fn}`);
      const end = src.indexOf("export const", start + 10);
      const block = src.slice(start, end === -1 ? undefined : end);
      assert.match(
        block,
        /await import\("@\/integrations\/supabase\/client\.server"\)/,
        `${fn} must use supabaseAdmin`,
      );
    }
  });
});

describe("scope separation from Phase 4 payment-transaction concerns", () => {
  test("this file contains no payment-transaction operations (Phase 4 scope, not Phase 3)", () => {
    for (const forbidden of [
      "createPaymentRequest",
      "createPaymentLink",
      "createPaymentQr",
      "refundPayment",
      "getPayment",
    ]) {
      assert.equal(code.includes(forbidden), false, `must not implement ${forbidden} in Phase 3`);
    }
  });
});
