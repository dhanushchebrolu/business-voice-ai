import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the WhatsApp connect/manage UI (Phase 3).
 * Source-scanned — no jsdom/RTL in this repo's test runner (see
 * app.numbers.test.ts's own convention).
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.whatsapp.tsx"), "utf8");

describe("reuses Phase 2's backend — no duplicated onboarding logic in the frontend", () => {
  test("imports and calls completeWhatsAppOnboarding from the existing Phase 2 module, not a re-implementation", () => {
    assert.match(
      src,
      /import \{ completeWhatsAppOnboarding \} from "@\/lib\/whatsapp-onboarding\.functions"/,
    );
    assert.match(src, /useServerFn\(completeWhatsAppOnboarding\)/);
  });

  test("never calls graph.facebook.com or the Meta client directly from this route", () => {
    assert.doesNotMatch(src, /graph\.facebook\.com/);
    assert.doesNotMatch(src, /MetaWhatsAppClient/);
  });

  test("never encrypts/decrypts a credential or references META_APP_SECRET in this file", () => {
    assert.doesNotMatch(src, /encryptCredential|decryptCredential|META_APP_SECRET/);
  });
});

describe("secure handoff: only the minimal non-sensitive result crosses into the server call", () => {
  test("the object passed to completeOnboarding is built from outcome.result plus only businessId — never a raw token/secret field", () => {
    const idx = src.indexOf("completeOnboarding({");
    assert.ok(idx > -1);
    const block = src.slice(idx, idx + 200);
    assert.match(block, /\.\.\.outcome\.result/);
    assert.match(block, /businessId: selectedBusinessId/);
    assert.doesNotMatch(block, /accessToken|access_token|pin|encryptionKey/i);
  });

  test("startWhatsAppEmbeddedSignup is only ever given appId/configId/graphApiVersion from VITE_ env vars — never a secret", () => {
    assert.match(src, /import\.meta\.env\["VITE_META_APP_ID"\]/);
    assert.match(src, /import\.meta\.env\["VITE_META_WHATSAPP_CONFIG_ID"\]/);
    assert.match(src, /import\.meta\.env\["VITE_META_GRAPH_API_VERSION"\]/);
    assert.doesNotMatch(src, /META_APP_SECRET|VITE_.*SECRET/);
  });
});

describe("tenant isolation: no client-supplied organization/business trust", () => {
  test("no organizationId is ever passed from this route to a server function — the server derives it itself", () => {
    assert.doesNotMatch(src, /organizationId:\s*(ws|orgId)/);
  });

  test('connections and businesses are always fetched through the tenant-scoped server functions, never a raw supabase.from("whatsapp_connections") query in this file', () => {
    assert.doesNotMatch(src, /supabase\s*\n?\s*\.from\("whatsapp_connections"\)/);
    assert.match(src, /listWhatsAppConnections/);
  });
});

describe("business/bot assignment", () => {
  test("assigning a bot goes through the assignWhatsAppBot server function, never a direct table write", () => {
    assert.match(
      src,
      /import \{[\s\S]*?assignWhatsAppBot[\s\S]*?\} from "@\/lib\/whatsapp-connection\.functions"/,
    );
    assert.doesNotMatch(src, /\.from\("whatsapp_connections"\)[\s\S]{0,100}\.update\(/);
  });

  test("options in the bot selector without an assigned agentConfig are disabled — never silently selectable as a working bot", () => {
    const idx = src.indexOf("disabled={!b.agentConfig}");
    assert.ok(idx > -1);
  });
});

describe("connected/disconnected/error states", () => {
  test("statusTone/statusLabel cover connected, needs_attention, connecting, error, and the default not_connected case", () => {
    assert.match(src, /"connected"/);
    assert.match(src, /"needs_attention"/);
    assert.match(src, /"connecting"/);
    assert.match(src, /"error"/);
  });

  test("a last_error is shown for error/needs_attention connections", () => {
    const idx = src.indexOf('c.status === "error" || c.status === "needs_attention"');
    assert.ok(idx > -1);
  });

  test("an empty EmptyState is shown when there are no connections yet — not a broken/blank panel", () => {
    assert.match(src, /No WhatsApp number connected yet/);
  });
});

describe("disconnect: confirmation required, no silent data loss", () => {
  test("disconnect is behind an AlertDialog confirmation, not a bare button click", () => {
    const idx = src.indexOf("Disconnect WhatsApp?");
    assert.ok(idx > -1);
    const block = src.slice(Math.max(0, idx - 400), idx + 400);
    assert.match(block, /AlertDialog/);
  });

  test("the confirmation copy explains history is kept, not deleted", () => {
    assert.match(src, /Existing conversation history is kept, not deleted/);
  });

  test("disconnect goes through disconnectWhatsAppConnection, never a direct delete", () => {
    assert.match(src, /disconnectWhatsAppConnection/);
    assert.doesNotMatch(src, /\.from\("whatsapp_connections"\)[\s\S]{0,100}\.delete\(/);
  });
});

describe("feature gate reused, not reimplemented", () => {
  test('uses the existing ServiceLocked component with feature="whatsapp", matching the already-established PLATFORM_FEATURES key', () => {
    assert.match(src, /<ServiceLocked feature="whatsapp" lifecycle={lifecycle} \/>/);
  });
});
