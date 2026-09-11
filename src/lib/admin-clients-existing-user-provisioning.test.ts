import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Production case: Admin > Customers > Create Client for an email that
 * already has an auth.users row and a profiles row (self-signed-up, per
 * 20260902091500_signup_no_longer_auto_provisions_workspace.sql — signup
 * only ever creates a profile now) but no organizations /
 * organization_members / organization_invitations row — i.e. a legitimate
 * "existing auth user, not yet provisioned as a customer" case.
 *
 * createClientAccount now resolves that existing auth user (via `profiles`,
 * never `auth.admin.createUser`) and attaches them as the workspace owner
 * immediately, instead of only ever creating an ownerless org shell that
 * assumed the eventual member would arrive through a fresh invitation.
 *
 * Source-scanned, matching this repo's established convention for
 * createServerFn modules this test runner can't import/execute directly
 * (see admin-clients-demo-conversion.test.ts, admin-auth-service-role-fix.test.ts).
 */

const dir = dirname(fileURLToPath(import.meta.url));
const adminClientsSrc = readFileSync(join(dir, "admin-clients.functions.ts"), "utf8");
const migrationSrc = readFileSync(
  join(
    dir,
    "..",
    "..",
    "supabase",
    "migrations",
    "20260911150000_organizations_contact_email_unique.sql",
  ),
  "utf8",
);

function extractFn(name: string): string {
  const start = adminClientsSrc.indexOf(`export const ${name} = createServerFn`);
  assert.ok(start > -1, `expected to find export const ${name}`);
  const nextExportIdx = adminClientsSrc.indexOf("\nexport const ", start + 1);
  return nextExportIdx > -1
    ? adminClientsSrc.slice(start, nextExportIdx)
    : adminClientsSrc.slice(start);
}

const fnSrc = extractFn("createClientAccount");

describe("Case A: existing auth user + profile + no organization -> Create Client succeeds and attaches them", () => {
  test("resolves the existing user by querying profiles (never auth.admin.createUser, never a second profile insert)", () => {
    const resolveIdx = fnSrc.indexOf('.from("profiles")');
    assert.ok(resolveIdx > -1, "expected a profiles lookup");
    const block = fnSrc.slice(resolveIdx, resolveIdx + 200);
    assert.match(block, /\.ilike\("email", email\)/);
    assert.doesNotMatch(fnSrc, /auth\.admin\.createUser\(/);
    assert.doesNotMatch(fnSrc, /\.from\("profiles"\)\s*\n?\s*\.insert\(/);
  });

  test("the resolved user becomes owner_id on the organization insert, not the admin placeholder", () => {
    assert.match(fnSrc, /owner_id: resolvedUserId \?\? admin\.userId,/);
  });

  test("an organization_members row is upserted for the resolved user as owner", () => {
    const memberIdx = fnSrc.indexOf("if (resolvedUserId) {");
    assert.ok(memberIdx > -1);
    const block = fnSrc.slice(memberIdx, memberIdx + 500);
    assert.match(block, /\.from\("organization_members"\)\s*\n?\s*\.upsert\(/);
    assert.match(block, /role: "owner"/);
    assert.match(block, /onConflict: "organization_id,user_id"/);
  });

  test("membership is attached only after the organization is successfully created, never before", () => {
    const orgInsertIdx = fnSrc.indexOf('.from("organizations")\n      .insert(');
    const memberIdx = fnSrc.indexOf("if (resolvedUserId) {");
    assert.ok(orgInsertIdx > -1 && memberIdx > -1);
    assert.ok(orgInsertIdx < memberIdx);
  });

  test("lifecycle_status is still created as not_provisioned regardless of whether an existing user was attached", () => {
    assert.match(fnSrc, /lifecycle_status: "not_provisioned",/);
  });

  test("account_status still starts as payment_required — attaching a known user never skips setup-payment", () => {
    assert.match(fnSrc, /account_status: "payment_required",/);
  });

  test("the audit record captures whether an existing user was attached", () => {
    const auditIdx = fnSrc.indexOf('action: "CREATE_CLIENT"');
    const block = fnSrc.slice(auditIdx, auditIdx + 300);
    assert.match(block, /attachedExistingUser: Boolean\(resolvedUserId\)/);
  });

  test("the return value reports whether an existing user was attached", () => {
    assert.match(
      fnSrc,
      /return \{ id: org\.id, clientId: org\.client_id, attachedExistingUser: Boolean\(resolvedUserId\) \};/,
    );
  });
});

describe("Case B: existing auth user + existing profile + existing organization -> no duplicate organization", () => {
  test("the contact-email clash guard runs before user resolution and before the organization insert", () => {
    const clashIdx = fnSrc.indexOf("if (clash) throw new Error(");
    const resolveIdx = fnSrc.indexOf('.from("profiles")');
    const insertIdx = fnSrc.indexOf('.from("organizations")\n      .insert(');
    assert.ok(clashIdx > -1 && resolveIdx > -1 && insertIdx > -1);
    assert.ok(clashIdx < resolveIdx, "the clash guard must run before resolving the auth user");
    assert.ok(clashIdx < insertIdx, "the clash guard must run before any organization insert");
  });

  test("a database-level unique index also blocks two concurrent creates for the same email (race-safety, not just the app-level pre-check)", () => {
    assert.match(
      migrationSrc,
      /CREATE UNIQUE INDEX IF NOT EXISTS organizations_contact_email_unique/,
    );
    assert.match(migrationSrc, /ON public\.organizations \(lower\(contact_email\)\)/);
  });

  test("a unique-violation surfaces as an admin-safe 'already exists' message, not a raw constraint error", () => {
    const helperIdx = adminClientsSrc.indexOf("async function adminSafeDbError");
    assert.ok(helperIdx > -1);
    const block = adminClientsSrc.slice(helperIdx, helperIdx + 900);
    assert.match(block, /code === "23505"/);
    assert.match(block, /already exists/);
  });
});

describe("Case C: new email -> the existing new-customer flow still works unchanged", () => {
  test("when no profile matches, resolvedUserId is null and owner_id falls back to the admin placeholder", () => {
    assert.match(fnSrc, /const resolvedUserId = existingProfiles\?\.\[0\]\?\.id \?\? null;/);
    assert.match(fnSrc, /owner_id: resolvedUserId \?\? admin\.userId,/);
  });

  test("no organization_members row is inserted for a brand-new email (membership still comes via invitation-accept)", () => {
    const memberIdx = fnSrc.indexOf("if (resolvedUserId) {");
    assert.ok(memberIdx > -1, "the member upsert must be conditional on a resolved user");
  });

  test("subscription, pricing overrides, wallet and CRM note creation are unaffected by user resolution", () => {
    assert.match(
      fnSrc,
      /\.from\("subscriptions"\)\s*\n\s*\.insert\(\{ organization_id: org\.id, plan: data\.plan/,
    );
    assert.match(fnSrc, /\.from\("organization_pricing_overrides"\)/);
    assert.match(fnSrc, /\.from\("wallet_transactions"\)/);
    assert.match(fnSrc, /\.from\("crm_notes"\)/);
  });
});

describe("Case D: existing auth user with no profile row falls back to the standard (supported) provisioning path", () => {
  test("the profile lookup uses .limit(1) rather than .maybeSingle(), so it can never itself throw for zero or unexpectedly-many rows", () => {
    const resolveIdx = fnSrc.indexOf('.from("profiles")');
    const block = fnSrc.slice(resolveIdx, resolveIdx + 200);
    assert.match(block, /\.limit\(1\);/);
    assert.doesNotMatch(block, /\.maybeSingle\(\)/);
  });

  test("a missing profile row is documented as falling back to the existing ownerless + invitation flow, not an error", () => {
    const resolveIdx = fnSrc.indexOf("Resolve an existing auth user");
    assert.ok(resolveIdx > -1);
    const block = fnSrc.slice(resolveIdx, resolveIdx + 900);
    assert.match(block, /is not an error here/);
  });
});

describe("Case E: GSTIN/PAN omitted -> provisioning succeeds (both remain optional)", () => {
  test("gst_number and pan_number are always coerced to null when blank, never required", () => {
    assert.match(fnSrc, /gst_number: data\.gstNumber\?\.trim\(\) \|\| null,/);
    assert.match(fnSrc, /pan_number: data\.panNumber\?\.trim\(\) \|\| null,/);
  });

  test("the input validator does not require gstNumber or panNumber", () => {
    const validatorIdx = fnSrc.indexOf(".inputValidator(");
    const handlerIdx = fnSrc.indexOf(".handler(");
    const block = fnSrc.slice(validatorIdx, handlerIdx);
    assert.doesNotMatch(block, /gstNumber/);
    assert.doesNotMatch(block, /panNumber/);
  });
});

describe("Diagnosable, admin-safe error handling (no more silent 'Could not create client' with no real cause)", () => {
  test("every database write in createClientAccount checks its error and wraps it through adminSafeDbError, never rethrowing a raw Postgrest error", () => {
    assert.doesNotMatch(fnSrc, /if \(error\) throw error;/);
    const wrapCount = (fnSrc.match(/throw await adminSafeDbError\(/g) ?? []).length;
    assert.ok(wrapCount >= 6, `expected at least 6 wrapped db-error throws, found ${wrapCount}`);
  });

  test("adminSafeDbError logs the full error server-side under a short reference, and never returns the raw error to the caller", () => {
    const helperIdx = adminClientsSrc.indexOf("async function adminSafeDbError");
    assert.ok(helperIdx > -1);
    const block = adminClientsSrc.slice(helperIdx, helperIdx + 900);
    assert.match(block, /console\.error\(`admin-clients:\$\{context\}`, \{ ref, error \}\);/);
    assert.match(block, /return new Error\(/);
    assert.doesNotMatch(block, /return error;/);
  });

  test("adminSafeDbError's returned messages never include raw SQL, a token, password, key or secret value", () => {
    const helperIdx = adminClientsSrc.indexOf("async function adminSafeDbError");
    const block = adminClientsSrc.slice(helperIdx, adminClientsSrc.indexOf("\n}", helperIdx));
    assert.doesNotMatch(block, /\bSELECT\b|\bINSERT\b|\bUPDATE\b/);
    assert.doesNotMatch(block, /token|password|service_role|secret/i);
  });

  test("the demo-request conversion link-back failure is still deliberately non-fatal and still logged, unaffected by this change", () => {
    assert.match(fnSrc, /admin-clients:demo_request_conversion_link_failed/);
  });
});

describe("Security invariants preserved", () => {
  test("createClientAccount is still gated by assertPlatformAdmin with the customers.write capability", () => {
    assert.match(
      fnSrc,
      /assertPlatformAdmin\(context\.supabase, context\.userId, "customers\.write"\)/,
    );
  });

  test("the resolved-user lookup and membership insert both go through supabaseAdmin (service role), never a client-supplied id", () => {
    const resolveIdx = fnSrc.indexOf('.from("profiles")');
    const memberBlock = fnSrc.slice(
      fnSrc.indexOf("if (resolvedUserId) {"),
      fnSrc.indexOf("if (resolvedUserId) {") + 400,
    );
    assert.ok(fnSrc.slice(0, resolveIdx).includes("const { supabaseAdmin } = await import"));
    assert.match(memberBlock, /supabaseAdmin\s*\n?\s*\.from\("organization_members"\)/);
    // resolvedUserId is derived only from the profiles query result, never from `data` (client input).
    assert.doesNotMatch(fnSrc, /resolvedUserId = data\./);
    assert.match(fnSrc, /const resolvedUserId = existingProfiles\?\.\[0\]\?\.id \?\? null;/);
  });

  test("no platform_admins row or admin capability is granted anywhere in this function", () => {
    assert.doesNotMatch(fnSrc, /\.from\("platform_admins"\)/);
  });
});
