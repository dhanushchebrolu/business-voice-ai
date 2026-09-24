import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scan coverage for the Google Calendar server functions — same
 * convention as whatsapp-connection.functions.test.ts for createServerFn
 * modules (no live Supabase/auth harness in this environment).
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "google-calendar.functions.ts"),
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
      6,
      "listGoogleCalendarConnections, connectGoogleCalendar, listGoogleCalendars, selectGoogleCalendar, disconnectGoogleCalendar, listOrgBusinessesForCalendar",
    );
  });

  test("organizationId always comes from organization_members via resolveOrgId, never from client input", () => {
    assert.match(src, /await resolveOrgId\(context\)/);
    assert.doesNotMatch(src, /organizationId:\s*(data|input)\./);
  });

  test("no input schema accepts an organizationId field", () => {
    assert.doesNotMatch(src, /organizationId:\s*z\./);
  });

  test("business ownership is explicitly re-validated (not merely assumed from a client-supplied businessId)", () => {
    assert.match(src, /assertBusinessOwnership\(/);
    assert.match(src, /business\.organization_id !== organizationId/);
  });

  test("connection ownership is explicitly re-validated before listing calendars", () => {
    assert.match(src, /connection\.organization_id !== organizationId/);
  });
});

describe("credential handling", () => {
  test("never returns encrypted_credentials, an access token, or a refresh token to the caller", () => {
    for (const forbidden of [
      "encrypted_credentials",
      "accessToken",
      "refreshToken",
      "access_token",
      "refresh_token",
    ]) {
      assert.equal(code.includes(forbidden), false, `must not reference/return ${forbidden}`);
    }
  });

  test("connect uses the centralized scope list, never a hand-written scope string", () => {
    assert.match(src, /GOOGLE_CALENDAR_SCOPES/);
    assert.doesNotMatch(src, /"https:\/\/www\.googleapis\.com\/auth\//);
  });

  test("uses server-generated OAuth state, never trusts a client-supplied one", () => {
    assert.match(src, /createOAuthState\(/);
  });
});

describe("mutations use the privileged client because RLS has no authenticated write policy for this table", () => {
  test("connect/select/disconnect all go through supabaseAdmin", () => {
    const mutationFns = [
      "connectGoogleCalendar",
      "selectGoogleCalendar",
      "disconnectGoogleCalendar",
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
