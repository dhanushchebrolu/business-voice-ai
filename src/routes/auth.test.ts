import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Production incident regression coverage for /auth:
 *
 *   1. Normal signup must never provision a workspace/organization/
 *      membership/subscription — only supabase.auth.signUp (an auth
 *      account) is created, and the account metadata (full_name, phone,
 *      business_name, country) is stored on the auth user itself, not
 *      written to any tenant table. Only a platform admin provisions a
 *      customer workspace (see admin.functions.ts / admin-clients.functions.ts
 *      — untouched by this fix).
 *   2. The signup screen's copy must not claim it creates a workspace — it
 *      previously said "Create your workspace" / "Create workspace" /
 *      "Create a workspace", which contradicted the actual (correct)
 *      behavior and read as if signup itself provisions a customer.
 *   3. Every successful auth path (signup with an immediate session, signin,
 *      OTP verification, Google OAuth) routes through the single
 *      resolvePostAuthDestination — never a hardcoded /app or /app/onboarding.
 *
 * Source-scanned, matching this repo's established convention for route
 * files this test runner can't import/render directly.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "auth.tsx"), "utf8");

function extractOnSubmit(): string {
  const start = src.indexOf("async function onSubmit(");
  const end = src.indexOf("\n  async function onVerifyOtp(");
  assert.ok(start > -1 && end > -1, "expected to find onSubmit");
  return src.slice(start, end);
}

describe("signup never provisions a workspace", () => {
  test("onSubmit's signup branch only calls supabase.auth.signUp — no table insert", () => {
    const onSubmit = extractOnSubmit();
    const signupIdx = onSubmit.indexOf('if (mode === "signup") {');
    const signinIdx = onSubmit.indexOf('} else if (mode === "signin") {');
    assert.ok(signupIdx > -1 && signinIdx > -1 && signupIdx < signinIdx);
    const signupBranch = onSubmit.slice(signupIdx, signinIdx);
    assert.match(signupBranch, /supabase\.auth\.signUp\(/);
    assert.doesNotMatch(signupBranch, /\.insert\(/);
    assert.doesNotMatch(signupBranch, /\.from\(/);
  });

  test("business_name/phone/full_name/country are passed as auth user metadata (options.data), never to a tenant table", () => {
    const onSubmit = extractOnSubmit();
    const signUpIdx = onSubmit.indexOf("supabase.auth.signUp(");
    const block = onSubmit.slice(signUpIdx, signUpIdx + 400);
    assert.match(block, /options:\s*\{/);
    assert.match(block, /data:\s*\{/);
    assert.match(block, /full_name:\s*form\.fullName/);
    assert.match(block, /business_name:\s*form\.businessName/);
  });

  test("no reference anywhere in this file to organizations/organization_members/subscriptions/businesses tables", () => {
    for (const table of ["organizations", "organization_members", "subscriptions", "businesses"]) {
      assert.doesNotMatch(src, new RegExp(`from\\("${table}"\\)`));
    }
  });
});

describe("signup copy accurately describes account creation, not workspace creation", () => {
  test('no stale "Create your workspace" / "Create workspace" / "Create a workspace" copy remains', () => {
    assert.doesNotMatch(src, /Create your workspace/);
    assert.doesNotMatch(src, /Create workspace/);
    assert.doesNotMatch(src, /Create a workspace/);
  });

  test('the signup submit button and heading read as account creation ("Create account" / "Create your account")', () => {
    assert.match(src, /"Create account"/);
    assert.match(src, /"Create your account"/);
  });
});

describe("every successful sign-in/sign-up path resolves its destination through the one authority", () => {
  test("resolvePostAuthDestination is called on: signup-with-immediate-session, signin, OTP verify, and Google OAuth — never a hardcoded /app", () => {
    const occurrences = [...src.matchAll(/resolvePostAuthDestination\(/g)];
    // 1 in the "already signed in" effect + 4 in the action handlers below.
    assert.ok(
      occurrences.length >= 5,
      `expected at least 5 call sites, found ${occurrences.length}`,
    );
    assert.doesNotMatch(src, /navigate\(\{ to: "\/app"/);
    assert.doesNotMatch(src, /navigate\(\{ to: "\/app\/onboarding"/);
  });
});
