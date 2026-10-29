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
  "searchWhatsAppNumbers",
  "orderWhatsAppNumber",
  "connectPurchasedWhatsAppNumber",
  "completeWhatsAppEmbeddedSignup",
];

describe("authentication, authorization, feature gate", () => {
  test("every server function requires a signed-in user", () => {
    for (const name of [
      ...MUTATIONS,
      "reconnectWhatsAppConnection",
      "listWhatsAppNumberOrders",
      "listDisconnectedWhatsAppNumbers",
    ]) {
      assert.match(handler(name), /\.middleware\(\[requireSupabaseAuth\]\)/, name);
    }
  });

  test("every onboarding step resolves owner/admin scope from the target and checks the WhatsApp feature gate", () => {
    assert.match(
      code,
      /async function managerScope[\s\S]*?requireWhatsAppManager\([\s\S]*?assertFeatureUnlocked\(scope\.organizationId, "whatsapp"\)/,
    );
    for (const name of MUTATIONS) {
      assert.match(
        handler(name),
        /await managerScope\(supabaseAdmin, context\.userId, data\.businessId\)/,
        name,
      );
    }
    const reconnect = handler("reconnectWhatsAppConnection");
    assert.match(
      reconnect,
      /requireWhatsAppManager\(supabaseAdmin, context\.userId, \{\s*connectionId: data\.connectionId,?\s*\}\)/,
    );
    assert.match(reconnect, /assertFeatureUnlocked\(scope\.organizationId, "whatsapp"\)/);
  });

  test("no input schema accepts an organization id", () => {
    assert.doesNotMatch(code, /organizationId:\s*z\./);
    assert.doesNotMatch(code, /data\.organizationId/);
  });

  test("buying a number requires an explicit confirmation", () => {
    assert.match(handler("orderWhatsAppNumber"), /confirm: z\.literal\(true\)/);
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
