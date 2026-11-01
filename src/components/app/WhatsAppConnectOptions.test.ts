import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source checks of the connect UI (no DOM test environment in this repo).
 * The server behaviour behind every button is tested at runtime in
 * whatsapp-vobiz-onboarding.server.test.ts.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "WhatsAppConnectOptions.tsx"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("the three Vobiz connection options", () => {
  test("Bring your own number, a number from ClickAI and Embedded Signup are all offered", () => {
    assert.match(code, /<TabsTrigger value="byon">Bring your own number<\/TabsTrigger>/);
    assert.match(code, /<TabsTrigger value="clickai">Number from ClickAI<\/TabsTrigger>/);
    assert.match(code, /<TabsTrigger value="embedded">Embedded Signup<\/TabsTrigger>/);
  });

  test("each option calls its server function — nothing talks to Vobiz from the browser", () => {
    for (const fn of [
      "startWhatsAppByonVerification",
      "connectWhatsAppByon",
      "connectAssignedWhatsAppNumber",
      "requestWhatsAppNumber",
      "completeWhatsAppEmbeddedSignup",
    ]) {
      assert.match(code, new RegExp(`useServerFn\\(${fn}\\)`), fn);
    }
    assert.doesNotMatch(code, /api\.vobiz\.ai|X-Auth-Token|VOBIZ_AUTH/);
  });
});

describe("safety in the UI", () => {
  test("customers can't buy numbers: no search, order or purchase call from the customer UI", () => {
    assert.doesNotMatch(
      code,
      /searchWhatsAppNumbers|orderWhatsAppNumber|purchaseWhatsAppNumber|searchVobizWhatsAppNumbers|telephony-admin/,
    );
  });

  test("assigned numbers are read through RLS for this organization only, WhatsApp-capable and not released", () => {
    assert.match(
      code,
      /\.from\("phone_numbers"\)[\s\S]*?\.eq\("organization_id", orgId\)[\s\S]*?\.eq\("whatsapp_capable", true\)/,
    );
    assert.match(code, /\.not\("status", "in", "\(released,failed\)"\)/);
  });

  test("the BYON Meta token is a password field and is cleared after a successful connect", () => {
    assert.match(code, /<PasswordInput\s+id="byon-token"/);
    assert.match(code, /setAccessToken\(""\)/);
  });

  test("Embedded Signup uses only public VITE_VOBIZ_WHATSAPP_ES_* config; without it only that option is unavailable", () => {
    assert.match(code, /import\.meta\.env\["VITE_VOBIZ_WHATSAPP_ES_APP_ID"\]/);
    assert.match(code, /import\.meta\.env\["VITE_VOBIZ_WHATSAPP_ES_CONFIG_ID"\]/);
    assert.match(code, /import\.meta\.env\["VITE_VOBIZ_WHATSAPP_ES_GRAPH_VERSION"\]/);
    assert.doesNotMatch(code, /VITE_META_|SECRET/);
    assert.match(code, /Embedded Signup isn.t set up on this deployment yet/);
  });

  test("closing Meta's window isn't shown as an error", () => {
    assert.match(code, /if \(outcome\.reason !== "cancelled"\) setError\(outcome\.message\)/);
  });

  test("only the minimal Embedded Signup result plus the business id reaches the server", () => {
    assert.match(code, /complete\(\{ data: \{ \.\.\.outcome\.result, businessId \} \}\)/);
  });
});

describe("BYON wording: a code request is not a delivery", () => {
  test("after a request, the UI shows only the shared wording — never that a code was sent or delivered", () => {
    assert.doesNotMatch(
      code,
      /Verification code sent to|code should reach|Send verification code/i,
    );
    // Both the toast and the panel come from byon-verification-messages.ts
    // (its wording is tested at runtime in byon-verification-messages.test.ts).
    assert.match(code, /byonRequestMessages\(outcome\)/);
    assert.match(code, /byonRequestMessages\(requested\)\.panel/);
    assert.match(code, /toast\.warning\(messages\.toast\)/);
  });

  test("the eligibility rules are shown before a code is requested", () => {
    assert.match(code, /BYON_ELIGIBILITY_NOTES\.map/);
    const eligibility = code.indexOf("BYON_ELIGIBILITY_NOTES.map");
    const button = code.indexOf("Request verification code");
    assert.ok(
      eligibility > 0 && eligibility < button,
      "eligibility notes come before the request button",
    );
  });
});
