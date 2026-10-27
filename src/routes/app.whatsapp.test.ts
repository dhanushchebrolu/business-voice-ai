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

describe("connecting goes through Vobiz (WhatsAppConnectOptions), not the retired direct-Meta flow", () => {
  test("renders the three-option component for the chosen business", () => {
    assert.match(
      src,
      /import \{ WhatsAppConnectOptions \} from "@\/components\/app\/WhatsAppConnectOptions"/,
    );
    assert.match(src, /<WhatsAppConnectOptions[\s\S]*?businessId=\{targetBusinessId\}/);
  });

  test("missing legacy VITE_META_* variables can no longer block the page", () => {
    assert.doesNotMatch(src, /VITE_META_/);
    assert.doesNotMatch(src, /WhatsApp is not configured on this deployment yet/);
    assert.doesNotMatch(src, /completeWhatsAppOnboarding|graph\.facebook\.com|MetaWhatsAppClient/);
  });

  test("never encrypts/decrypts a credential or references a secret in this file", () => {
    assert.doesNotMatch(src, /encryptCredential|decryptCredential|META_APP_SECRET|VOBIZ_AUTH/);
  });

  test("disconnected Vobiz numbers can be reconnected through the server function", () => {
    assert.match(src, /listDisconnectedWhatsAppNumbers/);
    assert.match(src, /reconnect\(\{ data: \{ connectionId \} \}\)/);
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
