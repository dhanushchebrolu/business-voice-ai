import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * createServerFn handlers can't be executed by this test runner, so these
 * checks pin the wrappers' wiring only. Behaviour of the three Vobiz
 * onboarding paths runs for real in
 * whatsapp/whatsapp-vobiz-onboarding.server.test.ts, and authorization in
 * whatsapp/whatsapp-access.server.test.ts.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "whatsapp-onboarding.functions.ts"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function handler(name: string): string {
  const start = code.indexOf(`export const ${name}`);
  assert.ok(start > -1, name);
  const next = code.indexOf("export const ", start + 1);
  return code.slice(start, next === -1 ? undefined : next);
}

const MUTATIONS = [
  "startWhatsAppByonVerification",
  "connectWhatsAppByon",
  "connectAssignedWhatsAppNumber",
  "requestWhatsAppNumber",
  "completeWhatsAppEmbeddedSignup",
];

describe("authentication, authorization, feature gate", () => {
  test("every server function requires a signed-in user", () => {
    for (const name of [
      ...MUTATIONS,
      "reconnectWhatsAppConnection",
      "listDisconnectedWhatsAppNumbers",
    ]) {
      assert.match(handler(name), /\.middleware\(\[requireSupabaseAuth\]\)/, name);
    }
  });

  test("every onboarding step resolves owner/admin scope from the target and checks the WhatsApp feature gate", () => {
    assert.match(
      code,
      /async function managerScope[\s\S]*?requireWhatsAppManager\([\s\S]*?assertWhatsAppUnlockedForCaller\(context\.supabase, scope\.organizationId\)/,
    );
    for (const name of MUTATIONS) {
      assert.match(
        handler(name),
        /await managerScope\(supabaseAdmin, context, data\.businessId\)/,
        name,
      );
    }
    const reconnect = handler("reconnectWhatsAppConnection");
    assert.match(
      reconnect,
      /requireWhatsAppManager\(supabaseAdmin, context\.userId, \{\s*connectionId: data\.connectionId,?\s*\}\)/,
    );
    assert.match(
      reconnect,
      /assertWhatsAppUnlockedForCaller\(context\.supabase, scope\.organizationId\)/,
    );
    // The gate is never evaluated through the service role (no EXECUTE on feature_locked).
    assert.doesNotMatch(code, /assertFeatureUnlocked\(/);
  });

  test("no input schema accepts an organization id", () => {
    assert.doesNotMatch(code, /organizationId:\s*z\./);
    assert.doesNotMatch(code, /data\.organizationId/);
  });

  test("customers can't buy numbers: nothing here searches, orders or records a Vobiz purchase", () => {
    for (const gone of [
      "searchWhatsAppNumbers",
      "orderWhatsAppNumber",
      "listWhatsAppNumberOrders",
      "connectPurchasedWhatsAppNumber",
    ]) {
      assert.doesNotMatch(code, new RegExp(`export const ${gone}\\b`), gone);
    }
    assert.doesNotMatch(
      code,
      /purchaseNumberForOrganization|searchNumbers|createNumberOrder|record_whatsapp_number_purchase|listNumberOrders/,
    );
  });

  test("an assigned ClickAI number is identified by id only; its organization comes from the scope", () => {
    const connect = handler("connectAssignedWhatsAppNumber");
    assert.match(connect, /numberId: z\.string\(\)\.uuid\(\)/);
    assert.match(connect, /connectAssignedNumber\(supabaseAdmin, scope, data, \{ vobiz \}\)/);
  });
});

describe("secrets", () => {
  test("missing Vobiz settings are logged by name only, and the customer sees 'not configured'", () => {
    assert.match(
      code,
      /console\.error\(\s*"whatsapp_onboarding:not_configured",\s*\{\s*missing: missingVobizWhatsAppSettings\(\),?\s*\},?\s*\)/,
    );
    assert.match(code, /WhatsApp is not configured on this deployment yet/);
  });

  test("nothing here logs, stores or returns the BYON Meta token or Vobiz credentials", () => {
    assert.doesNotMatch(code, /console\.[a-z]+\([^)]*(accessToken|authToken|data\b)/);
    assert.doesNotMatch(code, /process\.env\[/);
    assert.doesNotMatch(code, /access_token_ciphertext|encryptCredential/);
  });

  test("the retired direct-Meta onboarding is gone", () => {
    assert.doesNotMatch(
      code,
      /MetaWhatsAppClient|resolveMetaWhatsAppConfig|META_APP_SECRET|exchangeAuthorizationCode/,
    );
  });
});

describe("schema contract (production 42703 incident)", () => {
  test("every onboarding action runs inside withSchemaContract, named after itself", () => {
    for (const name of [...MUTATIONS, "reconnectWhatsAppConnection"]) {
      assert.match(
        handler(name),
        new RegExp(`withSchemaContract\\("${name}", async \\(\\) =>`),
        name,
      );
    }
  });

  test("the WhatsApp page's disconnected list tolerates a database without the Vobiz columns (logged, empty)", () => {
    const list = handler("listDisconnectedWhatsAppNumbers");
    assert.match(
      list,
      /if \(isSchemaMismatch\(error\)\) \{\s*logSchemaMismatch\("listDisconnectedWhatsAppNumbers", error\);\s*return \[\];/,
    );
  });
});
