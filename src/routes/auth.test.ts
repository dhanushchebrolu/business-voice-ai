import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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
 *   3. Every successful auth path (signup with an immediate session, signin)
 *      routes through the single resolvePostAuthDestination — never a
 *      hardcoded /app or /app/onboarding. Google OAuth resolves its
 *      destination via the shared /auth/callback page instead of inline
 *      (see the "Google OAuth" describe block below) — the browser
 *      navigates away entirely during the OAuth redirect, so there is
 *      nothing left for onGoogle itself to resolve.
 *   4. Google sign-in no longer depends on Lovable's OAuth relay
 *      (@lovable.dev/cloud-auth-js) — it uses Supabase's own
 *      signInWithOAuth, redirecting through Google and back to
 *      /auth/callback, matching every other Supabase project.
 *   5. Klyro's Supabase project has Confirm Email OFF: signUp is plain
 *      email+password, sends no email, and always returns a live session —
 *      there is no confirmation-link/OTP/"check your email" state left in
 *      this file (see "signup is email+password only" below), matching the
 *      exact scenarios the removal task required covered.
 *
 * Source-scanned, matching this repo's established convention for route
 * files this test runner can't import/render directly.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "auth.tsx"), "utf8");

function extractOnSubmit(): string {
  const start = src.indexOf("async function onSubmit(");
  const end = src.indexOf("\n  async function onGoogle(");
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
  test("resolvePostAuthDestination is called on: the already-signed-in effect, signup-with-immediate-session, and signin — never a hardcoded /app", () => {
    const occurrences = [...src.matchAll(/resolvePostAuthDestination\(/g)];
    assert.ok(
      occurrences.length >= 3,
      `expected at least 3 call sites, found ${occurrences.length}`,
    );
    assert.doesNotMatch(src, /navigate\(\{ to: "\/app"/);
    assert.doesNotMatch(src, /navigate\(\{ to: "\/app\/onboarding"/);
    assert.doesNotMatch(src, /navigate\(\{ to: "\/admin"/);
  });

  test("post-auth destination rules themselves (admin/app/public) are the single shared authority — see post-auth-destination.test.ts, not re-derived here", () => {
    // deriveDestination in post-auth-destination-logic.ts is what actually
    // decides admin -> /admin, provisioned workspace -> /app, everyone else
    // -> / (public site). This file only has to prove every auth path calls into it.
    assert.doesNotMatch(src, /isActivePlatformAdmin/);
    assert.doesNotMatch(src, /organizationLifecycleStatus/);
  });
});

describe("signup is email+password only — no confirmation-email/OTP flow (Confirm Email is OFF for this project)", () => {
  const onSubmit = extractOnSubmit();

  test("signUp is called with no emailRedirectTo — signup never depends on or triggers an emailed link", () => {
    const signUpIdx = onSubmit.indexOf("supabase.auth.signUp(");
    assert.ok(signUpIdx > -1);
    const block = onSubmit.slice(signUpIdx, signUpIdx + 400);
    assert.doesNotMatch(block, /emailRedirectTo/);
  });

  test("a successful signup with a session immediately resolves its destination and navigates — no intermediate waiting state", () => {
    assert.match(onSubmit, /toast\.success\("Account created\."\)/);
    const successIdx = onSubmit.indexOf('toast.success("Account created."');
    const destIdx = onSubmit.indexOf("resolvePostAuthDestination(signedUpUserId", successIdx);
    const navIdx = onSubmit.indexOf("navigate({ to: dest })", successIdx);
    assert.ok(successIdx > -1 && destIdx > -1 && navIdx > -1);
    assert.ok(destIdx < navIdx);
  });

  test("if signUp somehow returns no session (Confirm Email unexpectedly on), the fallback signs in immediately rather than entering any confirmation state", () => {
    assert.match(onSubmit, /if \(!data\.session\)/);
    const fallbackIdx = onSubmit.indexOf("if (!data.session)");
    const block = onSubmit.slice(fallbackIdx, fallbackIdx + 500);
    assert.match(block, /supabase\.auth\.signInWithPassword\(/);
    assert.doesNotMatch(block, /setStep/);
  });

  test("no confirmation-email/OTP state, handlers, components, or copy remain anywhere in this file", () => {
    for (const pattern of [
      /InputOTP/,
      /verifyOtp/,
      /onVerifyOtp/,
      /onResendConfirmation/,
      /resend\(/,
      /pendingEmail/,
      /"check-email"/,
      /Check your email/,
      /Check your inbox/,
      /Resend confirmation/,
      /confirmation link/i,
      /6-digit code/,
      /RESEND_COOLDOWN_SECONDS/,
    ]) {
      assert.doesNotMatch(src, pattern, `expected no match for ${pattern}`);
    }
  });

  test('signup copy invites email+password, and never mentions verification/confirmation/OTP/"check your inbox"', () => {
    assert.match(src, /Use your email and password to get started/);
    for (const forbidden of [
      /email verification/i,
      /confirmation email/i,
      /\bOTP\b/,
      /check your inbox/i,
    ]) {
      assert.doesNotMatch(src, forbidden, `signup copy must not mention ${forbidden}`);
    }
  });
});

describe("forgot-password (Supabase password recovery) is untouched by the confirmation-email removal", () => {
  test("resetPasswordForEmail is still called with redirectTo pointed at /reset-password on the current origin", () => {
    assert.match(src, /supabase\.auth\.resetPasswordForEmail\(/);
    assert.match(src, /redirectTo:\s*`\$\{window\.location\.origin\}\/reset-password`/);
  });

  test("the forgot-password mode still sends a reset link and returns the visitor to sign-in, unrelated to signup's session flow", () => {
    const forgotIdx = src.indexOf("} else {", src.indexOf('mode === "signin"'));
    assert.ok(forgotIdx > -1);
    const block = src.slice(forgotIdx, forgotIdx + 400);
    assert.match(block, /resetPasswordForEmail/);
    assert.match(block, /setMode\("signin"\)/);
  });
});

describe("Google OAuth uses Supabase directly, not Lovable's relay", () => {
  function extractOnGoogle(): string {
    const start = src.indexOf("async function onGoogle(");
    const end = src.indexOf("\n  return (", start);
    assert.ok(start > -1 && end > -1, "expected to find onGoogle");
    return src.slice(start, end);
  }

  test("does not import @lovable.dev/cloud-auth-js or the deleted lovable integration module", () => {
    assert.doesNotMatch(src, /@lovable\.dev\/cloud-auth-js/);
    assert.doesNotMatch(src, /integrations\/lovable/);
    assert.doesNotMatch(src, /\blovable\.auth\./);
  });

  test('onGoogle calls supabase.auth.signInWithOAuth with provider: "google"', () => {
    const onGoogle = extractOnGoogle();
    assert.match(onGoogle, /supabase\.auth\.signInWithOAuth\(/);
    assert.match(onGoogle, /provider:\s*"google"/);
  });

  test("the redirect target is /auth/callback on the current origin — never a hardcoded localhost or a different path", () => {
    const onGoogle = extractOnGoogle();
    assert.match(onGoogle, /redirectTo:\s*`\$\{window\.location\.origin\}\/auth\/callback`/);
    assert.doesNotMatch(onGoogle, /localhost/);
  });

  test("a signInWithOAuth error surfaces a safe toast, never error.message from the provider", () => {
    const onGoogle = extractOnGoogle();
    const errIdx = onGoogle.indexOf("if (error) {");
    assert.ok(errIdx > -1);
    const errBlock = onGoogle.slice(errIdx, errIdx + 150);
    assert.match(
      errBlock,
      /toast\.error\("Google sign-in failed\. Please try again or use email\."\)/,
    );
    assert.doesNotMatch(errBlock, /error\.message/);
  });
});

describe("the Lovable OAuth relay integration is fully removed", () => {
  test("src/integrations/lovable/index.ts no longer exists", () => {
    const path = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "integrations",
      "lovable",
      "index.ts",
    );
    assert.equal(existsSync(path), false, "expected the Lovable OAuth relay module to be deleted");
  });

  test("@lovable.dev/cloud-auth-js is no longer a dependency in package.json", () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(pkg.dependencies?.["@lovable.dev/cloud-auth-js"], undefined);
  });
});
