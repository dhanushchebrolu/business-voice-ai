import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deriveDestination } from "./post-auth-destination-logic.ts";

/**
 * Investigation (ClickAI branding mismatch after login): clickai.in/auth
 * shows ClickAI branding, but the dashboard observed after signing in was
 * at https://klyro.aiblaze-io.workers.dev/app/business. Reading every
 * navigation call in the login/callback flow (auth.tsx, auth.callback.tsx,
 * post-auth-destination.ts/-logic.ts) found none of them construct an
 * absolute URL or hostname — every destination is a bare relative path fed
 * to TanStack Router's `navigate({ to })`, and the one absolute URL built
 * client-side (`resetPasswordForEmail`'s redirectTo) uses
 * `window.location.origin`, the CURRENT page's own host, never a hardcoded
 * one. "klyro.aiblaze-io.workers.dev" is explained by wrangler.json's
 * pinned Worker name "klyro" (a workers.dev URL is always
 * `<worker-name>.<subdomain>.workers.dev`, per DEPLOYMENT.md) — not by any
 * redirect this app's own code issues. These tests lock in the half of
 * that finding this repo can actually guarantee: the login/callback flow
 * never hardcodes an absolute destination, and the dashboard chrome never
 * regresses back to literal "Klyro" text. They cannot verify the Cloudflare
 * custom-domain routing or the Supabase Auth "Site URL" setting — both are
 * external dashboard configuration with no file in this repo to assert
 * against (see the final report for the manual checks still needed there).
 *
 * Source-scanned like other route/component files in this codebase (see
 * appointment-slots.test.ts) for primitives.tsx/__root.tsx/Shell.tsx/
 * NoWorkspace.tsx/AccountLocked.tsx, which have no DOM-rendering harness.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relPath: string) => readFileSync(join(here, relPath), "utf8");

describe("post-login destination is always a bare relative path, never an absolute URL or hostname", () => {
  const cases = [
    { isActivePlatformAdmin: true, organizationLifecycleStatus: null },
    { isActivePlatformAdmin: false, organizationLifecycleStatus: "active" },
    { isActivePlatformAdmin: false, organizationLifecycleStatus: "archived" },
    { isActivePlatformAdmin: false, organizationLifecycleStatus: null },
    { isActivePlatformAdmin: true, organizationLifecycleStatus: "archived" },
  ];

  for (const input of cases) {
    test(`deriveDestination(${JSON.stringify(input)}) returns a path starting with "/" and contains no scheme/host`, () => {
      const dest = deriveDestination(input);
      assert.match(dest, /^\//, "destination must start with /");
      assert.doesNotMatch(dest, /:\/\//, "destination must never embed a scheme/host");
      assert.doesNotMatch(
        dest,
        /workers\.dev|klyro/i,
        "destination must never name a specific host",
      );
    });
  }
});

describe("auth.tsx / auth.callback.tsx never hardcode an absolute destination or a non-origin host", () => {
  const authSrc = read("../routes/auth.tsx");
  const callbackSrc = read("../routes/auth.callback.tsx");

  test("every navigate({ to: ... }) call passes the resolver's own relative `dest`, never a literal URL", () => {
    for (const src of [authSrc, callbackSrc]) {
      const navigateCalls = src.match(/navigate\(\{\s*to:\s*[^}]+\}\)/g) ?? [];
      assert.ok(navigateCalls.length > 0, "expected at least one navigate({ to }) call");
      for (const call of navigateCalls) {
        assert.doesNotMatch(
          call,
          /https?:\/\//,
          `navigate call must not embed an absolute URL: ${call}`,
        );
      }
    }
  });

  test("the only absolute URL either file builds (password-reset / OAuth redirectTo) is derived from window.location.origin, never a hardcoded host", () => {
    const redirectTo = /redirectTo:\s*`[^`]*`/g;
    const redirectBuilders: string[] = [
      ...(authSrc.match(redirectTo) ?? []),
      ...(callbackSrc.match(redirectTo) ?? []),
    ];
    for (const builder of redirectBuilders) {
      assert.match(
        builder,
        /\$\{window\.location\.origin\}/,
        `redirectTo must be built from window.location.origin: ${builder}`,
      );
      assert.doesNotMatch(
        builder,
        /klyro|workers\.dev|clickai\.in/i,
        `redirectTo must not hardcode a host: ${builder}`,
      );
    }
  });

  test("neither file references the workers.dev host or a hardcoded production domain", () => {
    for (const src of [authSrc, callbackSrc]) {
      assert.doesNotMatch(src, /workers\.dev/i);
      assert.doesNotMatch(src, /clickai\.in/i);
    }
  });
});

describe("authenticated dashboard chrome and branding say ClickAI, never Klyro", () => {
  const filesToCheck = [
    "../components/app/primitives.tsx",
    "../components/app/Shell.tsx",
    "../components/app/AuthenticatedShell.tsx",
    "../components/app/NoWorkspace.tsx",
    "../components/app/AccountLocked.tsx",
    "../routes/__root.tsx",
    "../routes/admin.tsx",
    "../routes/admin.demo-requests.tsx",
  ];

  for (const relPath of filesToCheck) {
    test(`${relPath} contains no literal "Klyro" text`, () => {
      const src = read(relPath);
      assert.doesNotMatch(
        src,
        /Klyro/,
        `${relPath} must not contain the legacy "Klyro" brand name`,
      );
    });
  }

  test('primitives.tsx\'s Logo renders the literal text "ClickAI"', () => {
    const src = read("../components/app/primitives.tsx");
    assert.match(src, /export function Logo/);
    const logoStart = src.indexOf("export function Logo");
    const logoEnd = src.indexOf("\n}", logoStart);
    assert.match(src.slice(logoStart, logoEnd), />ClickAI</);
  });

  test("Shell.tsx (the authenticated dashboard frame) renders <Logo />, reusing the one brand component rather than its own literal name", () => {
    const src = read("../components/app/Shell.tsx");
    assert.match(src, /<Logo\s*\/>/);
    assert.doesNotMatch(src, />\s*Klyro\s*</);
  });

  test("__root.tsx's default <head> meta carries the ClickAI title and og:site_name, not a stale brand", () => {
    const src = read("../routes/__root.tsx");
    assert.match(src, /title:\s*"ClickAI/);
    assert.match(src, /og:site_name.*ClickAI/s);
  });
});
