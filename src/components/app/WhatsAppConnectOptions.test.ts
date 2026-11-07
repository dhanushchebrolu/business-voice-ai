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
  test("Bring your own number, Buy a number and Embedded Signup are all offered", () => {
    assert.match(code, /<TabsTrigger value="byon">Bring your own number<\/TabsTrigger>/);
    assert.match(code, /<TabsTrigger value="buy">Buy a number<\/TabsTrigger>/);
    assert.match(code, /<TabsTrigger value="embedded">Embedded Signup<\/TabsTrigger>/);
  });

  test("each option calls its server function — nothing talks to Vobiz from the browser", () => {
    for (const fn of [
      "startWhatsAppByonVerification",
      "connectWhatsAppByon",
      "searchWhatsAppNumbers",
      "orderWhatsAppNumber",
      "connectPurchasedWhatsAppNumber",
      "completeWhatsAppEmbeddedSignup",
    ]) {
      assert.match(code, new RegExp(`useServerFn\\(${fn}\\)`), fn);
    }
    assert.doesNotMatch(code, /api\.vobiz\.ai|X-Auth-Token|VOBIZ_AUTH/);
  });
});

describe("safety in the UI", () => {
  test("buying is behind a confirmation dialog and sends confirm: true", () => {
    assert.match(code, /<AlertDialogTitle>Buy \{confirming\}\?<\/AlertDialogTitle>/);
    assert.match(code, /order\(\{ data: \{ businessId, phoneNumber, confirm: true \} \}\)/);
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
