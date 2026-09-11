import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Production incident: platform_admins confirmed (by direct database
 * inspection) to contain an active super_admin row for the signed-in user,
 * yet /admin still rendered "not an admin". Root cause: the authorization
 * check queried platform_admins through the caller's RLS-scoped client
 * (context.supabase, built in auth-middleware.ts from the request's own
 * bearer token) relying on a self-read RLS policy, instead of the
 * service-role client already used elsewhere in this exact file for
 * privileged platform_admins access (the bootstrap-count fallback, and
 * claimPlatformAdmin's atomic RPC). Any drift between the RLS-client's
 * project/key resolution and the service-role client's — or any RLS/
 * PostgREST-schema-cache issue affecting the self-read policy — could
 * silently return zero rows for a row that unquestionably exists, without
 * ever throwing (so the /admin page's `!data?.admin` check reads it as
 * "not an admin" instead of surfacing an error).
 *
 * Fix: both assertPlatformAdmin and getAdminSession now resolve the
 * platform_admins row via the service-role client, scoped by the
 * server-verified `userId` (never client-supplied — see
 * requireSupabaseAuth's getClaims() call). This is not a new bypass or a
 * second authorization system: it's the exact same client already used
 * elsewhere in these two files for the identical table, and RLS remains
 * fully enforced for every other table and query in the app.
 *
 * Source-scanned, matching this repo's established convention for
 * createServerFn modules this test runner can't import/execute directly.
 */

const platformAdminSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "platform-admin.server.ts"),
  "utf8",
);
const adminFunctionsSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "admin.functions.ts"),
  "utf8",
);

function extractFn(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  const startFn = start > -1 ? start : src.indexOf(`export async function ${name}(`);
  assert.ok(startFn > -1, `expected to find ${name}`);
  const nextExportIdx = src.indexOf("\nexport ", startFn + 1);
  return nextExportIdx > -1 ? src.slice(startFn, nextExportIdx) : src.slice(startFn);
}

describe("assertPlatformAdmin resolves platform_admins via the service-role client", () => {
  const fnSrc = extractFn(platformAdminSrc, "assertPlatformAdmin");

  test("queries platform_admins through supabaseAdmin, not the caller's RLS-scoped supabase parameter", () => {
    const importIdx = fnSrc.indexOf('await import("@/integrations/supabase/client.server")');
    const queryIdx = fnSrc.indexOf('supabaseAdmin\n    .from("platform_admins")');
    assert.ok(importIdx > -1, "expected the service-role client to be imported");
    assert.ok(queryIdx > -1, "expected the platform_admins query to use supabaseAdmin");
    assert.ok(importIdx < queryIdx);
    // The RLS-scoped `supabase` parameter must not be the one queried.
    assert.doesNotMatch(fnSrc, /await supabase\s*\n?\s*\.from\("platform_admins"\)/);
  });

  test("the lookup is scoped by the userId parameter — never a client-suppliable value", () => {
    assert.match(fnSrc, /\.eq\("user_id", userId\)/);
  });

  test("still requires is_active and still enforces per-capability authorization — the fix changes the data source, not the authorization rules", () => {
    assert.match(fnSrc, /if \(!data \|\| !data\.is_active\)/);
    assert.match(fnSrc, /if \(capability && !capabilities\.includes\(capability\)\)/);
  });
});

describe("getAdminSession resolves platform_admins via the service-role client", () => {
  const fnSrc = extractFn(adminFunctionsSrc, "getAdminSession");

  test("the primary admin lookup uses supabaseAdmin, not context.supabase", () => {
    const queryIdx = fnSrc.indexOf('supabaseAdmin\n      .from("platform_admins")');
    assert.ok(queryIdx > -1, "expected the platform_admins query to use supabaseAdmin");
    assert.doesNotMatch(fnSrc, /await context\.supabase\s*\n?\s*\.from\("platform_admins"\)/);
  });

  test("scoped by context.userId — the server-verified id from requireSupabaseAuth, not any request field", () => {
    assert.match(fnSrc, /\.eq\("user_id", context\.userId\)/);
  });

  test("the bootstrap-availability fallback still only activates when no admin row was found", () => {
    const ifIdx = fnSrc.indexOf("if (!data || !data.is_active)");
    const countIdx = fnSrc.indexOf('.select("user_id", { count: "exact", head: true })');
    assert.ok(ifIdx > -1 && countIdx > -1 && ifIdx < countIdx);
  });
});

describe("diagnostic logging is present, safe, and never leaks a secret", () => {
  for (const [label, src, marker] of [
    ["assertPlatformAdmin", platformAdminSrc, "admin_auth:assert_platform_admin"],
    ["getAdminSession", adminFunctionsSrc, "admin_auth:get_admin_session"],
  ] as const) {
    test(`${label} logs userId, service-role-configured boolean, admin-row-found boolean, role and is_active — nothing else`, () => {
      const idx = src.indexOf(marker);
      assert.ok(idx > -1, `expected a ${marker} log line`);
      const block = src.slice(idx - 20, idx + 400);
      assert.match(block, /userId/);
      assert.match(
        block,
        /serviceRoleConfigured:\s*Boolean\(process\.env\["SUPABASE_SERVICE_ROLE_KEY"\]\)/,
      );
      assert.match(block, /adminRowFound:\s*Boolean\(data\)/);
      assert.match(block, /role:\s*data\?\.role/);
      assert.match(block, /isActive:\s*data\?\.is_active/);
    });
  }

  test("neither file ever logs a token, key, secret, password or cookie value", () => {
    for (const [label, src] of [
      ["platform-admin.server.ts", platformAdminSrc],
      ["admin.functions.ts", adminFunctionsSrc],
    ] as const) {
      const logCalls = [...src.matchAll(/console\.(log|error|warn|info)\([^;]*\);/gs)].map(
        (m) => m[0],
      );
      for (const call of logCalls) {
        // Every appearance of the key env var inside a log call must be
        // wrapped in Boolean(...) (a presence check) — never passed raw.
        if (call.includes("SUPABASE_SERVICE_ROLE_KEY")) {
          assert.match(
            call,
            /Boolean\(process\.env\["SUPABASE_SERVICE_ROLE_KEY"\]\)/,
            `${label}: the service-role key must only be logged as a Boolean presence check`,
          );
        }
        assert.doesNotMatch(call, /\btoken\b\s*[:=]/i, `${label}: must not log a token value`);
        assert.doesNotMatch(
          call,
          /\bpassword\b\s*[:=]/i,
          `${label}: must not log a password value`,
        );
        assert.doesNotMatch(call, /\bcookie\b/i, `${label}: must not log cookie contents`);
      }
    }
  });
});

describe("no second admin-authorization system was introduced", () => {
  test("assertPlatformAdmin remains the single exported guard other admin functions call", () => {
    assert.match(platformAdminSrc, /export async function assertPlatformAdmin\(/);
  });

  test("no new admin/role table or RPC is referenced by either file", () => {
    for (const src of [platformAdminSrc, adminFunctionsSrc]) {
      assert.doesNotMatch(src, /\.from\("admin_users"\)/);
      assert.doesNotMatch(src, /\.from\("roles"\)/);
      assert.doesNotMatch(src, /\.rpc\("is_admin_v2"/);
    }
  });

  test("no admin email is hardcoded", () => {
    for (const src of [platformAdminSrc, adminFunctionsSrc]) {
      assert.doesNotMatch(src, /@gmail\.com/);
      assert.doesNotMatch(src, /chdhanush56/);
    }
  });
});
