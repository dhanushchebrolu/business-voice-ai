import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scan coverage for the WhatsApp onboarding createServerFn wrapper
 * — same convention as telephony-customer.functions.test.ts for
 * createServerFn modules (no live Supabase/auth harness in this
 * environment).
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "whatsapp-onboarding.functions.ts"),
  "utf8",
);

describe("authentication and tenant derivation", () => {
  test("requireSupabaseAuth gates the whole handler", () => {
    assert.match(src, /\.middleware\(\[requireSupabaseAuth\]\)/);
  });

  test("organizationId comes from the authenticated user's own organization_members row via the RLS-scoped client, never from input", () => {
    assert.doesNotMatch(src, /organizationId:\s*(data|input)\./);
    const idx = src.indexOf('.from("organization_members")');
    assert.ok(idx > -1);
    const block = src.slice(idx - 60, idx + 200);
    assert.match(block, /context\.supabase/);
    assert.match(block, /eq\("user_id", context\.userId\)/);
  });

  test("the input schema has no organizationId/businessId-trusting field beyond a validated optional businessId", () => {
    assert.doesNotMatch(src, /organizationId:\s*z\./);
  });

  test("assertFeatureUnlocked is called with the server-derived organizationId and the 'whatsapp' feature key", () => {
    assert.match(src, /assertFeatureUnlocked\(organizationId, "whatsapp"\)/);
  });
});

describe("secret handling", () => {
  test("META_APP_SECRET is never referenced directly in this file (only via resolveMetaWhatsAppConfig)", () => {
    assert.doesNotMatch(src, /process\.env\[.META_APP_SECRET.\]/);
  });

  test("WHATSAPP_CREDENTIAL_ENCRYPTION_KEY is never referenced directly in this file (only via encryptCredential)", () => {
    assert.doesNotMatch(src, /process\.env\[.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY.\]/);
  });

  test("the function returns exactly the onboarding core's sanitized result, not a raw credential object", () => {
    assert.match(src, /return result;/);
    assert.doesNotMatch(src, /accessTokenCiphertext|access_token_ciphertext/);
    // generatePin/generateSixDigitPin (the DI wiring itself) are expected —
    // only a literal PIN VALUE would be a real leak, which this file never
    // constructs or returns.
    assert.doesNotMatch(src, /pin:\s*["'`]/i);
  });

  test("the failure log includes no request body, headers, or credential — only organizationId and a safe error message", () => {
    const idx = src.indexOf('console.error("whatsapp_onboarding:failed"');
    assert.ok(idx > -1);
    const block = src.slice(idx, idx + 220);
    assert.doesNotMatch(block, /Authorization|access_token|code:\s*data\.code/);
  });
});

describe("customer_events audit trail", () => {
  test("writes a customer_events row (the same generic per-org timeline table other customer actions use), not a new table", () => {
    assert.match(src, /\.from\("customer_events"\)\.insert\(/);
  });

  test("the customer_events write happens after, not before, onboarding completes", () => {
    const coreCallIdx = src.indexOf("completeWhatsAppOnboardingCore(");
    const eventsIdx = src.indexOf('.from("customer_events")');
    assert.ok(coreCallIdx > -1 && eventsIdx > -1);
    assert.ok(eventsIdx > coreCallIdx);
  });
});

describe("Meta client construction", () => {
  test("MetaWhatsAppClient is constructed from resolveMetaWhatsAppConfig(), not hardcoded credentials", () => {
    assert.match(src, /resolveMetaWhatsAppConfig\(\)/);
    assert.match(src, /new MetaWhatsAppClient\(\{/);
  });

  test("refuses to proceed (throws) when Meta config is not resolved, rather than silently continuing with undefined credentials", () => {
    const idx = src.indexOf("if (!config) {");
    assert.ok(idx > -1);
    assert.match(src.slice(idx, idx + 150), /throw new Error/);
  });
});
