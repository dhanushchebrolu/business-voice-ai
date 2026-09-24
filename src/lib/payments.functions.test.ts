import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "payments.functions.ts"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("authentication and tenant derivation", () => {
  test("listPaymentRequests is gated by requireSupabaseAuth", () => {
    assert.match(src, /\.middleware\(\[requireSupabaseAuth\]\)/);
  });

  test("organizationId always comes from organization_members via resolveOrgId, never from client input", () => {
    assert.match(src, /await resolveOrgId\(context\)/);
    assert.doesNotMatch(code, /organizationId:\s*(data|input)\./);
  });

  test("reads via the RLS-scoped context.supabase client, never supabaseAdmin — no code path bypasses the tenant-read policy", () => {
    assert.doesNotMatch(code, /supabaseAdmin/);
    assert.match(src, /context\.supabase/);
  });
});

describe("no secrets exposed (spec: 'no secrets exposed')", () => {
  test("never selects a Razorpay access/refresh token or the webhook secret column", () => {
    assert.doesNotMatch(code, /access_token/i);
    assert.doesNotMatch(code, /refresh_token/i);
    assert.doesNotMatch(code, /encrypted_credentials/i);
    assert.doesNotMatch(code, /webhook_secret/i);
  });

  test("never queries razorpay_connections directly — only the already-tenant-scoped payment_requests/bookings tables", () => {
    assert.doesNotMatch(code, /razorpay_connections/);
  });
});

describe("read-only surface (only a verified webhook may transition payment state)", () => {
  test("exports exactly one server function — no mutation entry point exists here", () => {
    const matches = code.match(/export const \w+ = createServerFn/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test("the one exported function is a GET, never a POST/mutation", () => {
    assert.match(src, /createServerFn\(\{ method: "GET" \}\)/);
  });
});

describe("data shape returned to the dashboard", () => {
  test("includes status, amount, currency, provider reference, timestamps, and last_error — the fields spec §11 lists", () => {
    for (const field of [
      "status",
      "amountMinorUnits",
      "currency",
      "providerReference",
      "createdAt",
      "capturedAt",
      "expiresAt",
      "lastError",
    ]) {
      assert.match(code, new RegExp(field));
    }
  });
});
