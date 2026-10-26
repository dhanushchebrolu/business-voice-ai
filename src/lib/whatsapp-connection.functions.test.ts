import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scan coverage for the WhatsApp connection-management server
 * functions (list/assign-bot/disconnect) — same convention as
 * telephony-customer.functions.test.ts and whatsapp-onboarding.
 * functions.test.ts for createServerFn modules (no live Supabase/auth
 * harness in this environment).
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "whatsapp-connection.functions.ts"),
  "utf8",
);

describe("authentication and tenant derivation", () => {
  test("all three exported server functions are gated by requireSupabaseAuth", () => {
    const matches = src.match(/\.middleware\(\[requireSupabaseAuth\]\)/g) ?? [];
    assert.equal(
      matches.length,
      4,
      "listWhatsAppConnections, listOrgBusinessesForWhatsApp, assignWhatsAppBot, disconnectWhatsAppConnection",
    );
  });

  test("list functions take organizationId from organization_members via the RLS-scoped client; management functions derive it from the target (whatsapp-access.server.ts)", () => {
    const occurrences = src.split('.from("organization_members")').length - 1;
    assert.ok(occurrences >= 2);
    assert.doesNotMatch(src, /organizationId:\s*(data|input)\./);
  });

  test("no input schema accepts an organizationId field", () => {
    assert.doesNotMatch(src, /organizationId:\s*z\./);
  });
});

describe("listWhatsAppConnections", () => {
  test("filters by organization_id and excludes disconnected rows", () => {
    const idx = src.indexOf("export const listWhatsAppConnections");
    const block = src.slice(idx, idx + 900);
    assert.match(block, /\.eq\("organization_id", membership\.organization_id\)/);
    assert.match(block, /\.neq\("status", "disconnected"\)/);
  });

  test("never selects access_token_ciphertext or two_step_pin_ciphertext", () => {
    const idx = src.indexOf("export const listWhatsAppConnections");
    const block = src.slice(idx, idx + 900);
    assert.doesNotMatch(block, /ciphertext/);
    assert.doesNotMatch(block, /select\("\*"\)/);
  });

  test("uses the RLS-scoped context.supabase, not supabaseAdmin (read path needs no privileged access)", () => {
    const idx = src.indexOf("export const listWhatsAppConnections");
    const end = src.indexOf("export const listOrgBusinessesForWhatsApp");
    const block = src.slice(idx, end);
    assert.match(block, /context\.supabase/);
    assert.doesNotMatch(block, /supabaseAdmin/);
  });
});

// Behaviour (roles, tenant checks, bot ownership, idempotent disconnect) is
// exercised at runtime in whatsapp/whatsapp-access.server.test.ts; these
// checks only pin the handlers to that tested code.
describe("assignWhatsAppBot: tenant-safe bot assignment", () => {
  test("delegates to assignWhatsAppBotForUser with the authenticated user's id", () => {
    const idx = src.indexOf("export const assignWhatsAppBot");
    const end = src.indexOf("export const disconnectWhatsAppConnection");
    const block = src.slice(idx, end);
    assert.match(block, /assignWhatsAppBotForUser\(supabaseAdmin, context\.userId,/);
    assert.doesNotMatch(block, /\.update\(/);
  });

  test("allows clearing the assignment (agentConfigId: null) — nullable in the schema, not required", () => {
    assert.match(src, /agentConfigId: z\.string\(\)\.uuid\(\)\.nullable\(\)/);
  });
});

describe("disconnectWhatsAppConnection: safe disconnect, no data loss", () => {
  test("delegates to disconnectWhatsAppConnectionForUser and never deletes", () => {
    const idx = src.indexOf("export const disconnectWhatsAppConnection");
    const block = src.slice(idx);
    assert.match(block, /disconnectWhatsAppConnectionForUser\(supabaseAdmin, context\.userId,/);
    assert.doesNotMatch(block, /\.delete\(\)/);
  });

  test("writes a customer_events audit row only when the status actually changed", () => {
    const idx = src.indexOf("export const disconnectWhatsAppConnection");
    const block = src.slice(idx);
    assert.match(block, /if \(result\.changed\)[\s\S]*\.from\("customer_events"\)\.insert\(/);
    assert.match(block, /kind: "whatsapp_disconnected"/);
  });
});

describe("no duplicated onboarding logic", () => {
  test("this file never imports the Meta client, the crypto module, or completeWhatsAppOnboarding — only doc comments may name them", () => {
    assert.doesNotMatch(
      src,
      /^import .*(MetaWhatsAppClient|whatsapp-token-crypto|whatsapp-onboarding\.server|completeWhatsAppOnboarding).*$/m,
    );
  });

  test("this file never reads .env for META_APP_SECRET or writes a ciphertext column — only doc comments may name them", () => {
    assert.doesNotMatch(src, /process\.env\[.META_APP_SECRET.\]/);
    assert.doesNotMatch(src, /\.update\(\{[^}]*ciphertext/s);
    assert.doesNotMatch(src, /\.insert\(\{[^}]*ciphertext/s);
  });

  test("this file never calls graph.facebook.com", () => {
    assert.doesNotMatch(src, /graph\.facebook\.com/);
  });
});
