import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lockMessageFor } from "./service-lock-message.ts";

/**
 * Regression coverage for H2 (customer-facing feature-lock UX).
 *
 * There is no DOM-rendering test setup in this repo (no React Testing
 * Library/jsdom — confirmed absent from package.json), so ServiceLocked.tsx
 * itself (JSX) cannot be rendered and asserted on directly by Node's
 * built-in test runner. This suite instead:
 *
 *   1. Exercises lockMessageFor — the pure wording-selection logic
 *      ServiceLocked.tsx renders verbatim — for every lifecycle state and
 *      both gated features (voice, phone), proving the audit's required
 *      message differentiation (item 10: not every lock means "payment
 *      required") and its exact required copy for the active+locked case
 *      (item 9).
 *   2. Proves no message ever contains internal/provider/billing/security
 *      detail (item 5).
 *   3. Statically verifies (source scan, the same technique used by this
 *      session's earlier migration/H1 regression tests) that the four
 *      route files actually wire ServiceLocked + featureLocksQuery in for
 *      voice/phone, that configuration actions on /app/agent stay enabled
 *      while only publish/rollback are gated, that dashboard-level routing
 *      (app.tsx) was not touched by this change, and that the H1
 *      server-side gates (assertFeatureUnlocked / checkFeatureAccess)
 *      this UI only reflects are still present and unmodified — i.e. the
 *      UI never became the authorization mechanism.
 *
 * Real rendering (does the banner actually show correctly locked, does the
 * Publish button actually stay disabled in a browser) still needs a
 * visual/manual check — this suite proves the logic and the wiring, not
 * the rendered pixels.
 */

describe("lockMessageFor — wording differentiation across lifecycle states", () => {
  test("not_provisioned / setup_payment_pending get payment/setup copy with a CTA to /account", () => {
    for (const lifecycle of ["not_provisioned", "setup_payment_pending"] as const) {
      const msg = lockMessageFor(lifecycle, "AI voice agent");
      assert.match(msg.title, /isn't available yet/);
      assert.match(msg.description, /setup payment/i);
      assert.deepEqual(msg.cta, { label: "Go to account setup", to: "/account" });
    }
  });

  test("setup_paid / provisioning / ready get provisioning copy, NOT payment copy, and no CTA", () => {
    for (const lifecycle of ["setup_paid", "provisioning", "ready"] as const) {
      const msg = lockMessageFor(lifecycle, "Phone number & calls");
      assert.match(msg.title, /still being set up/);
      assert.doesNotMatch(msg.description, /payment/i);
      assert.equal(msg.cta, undefined);
    }
  });

  test("suspended / cancelled / archived get a hold/contact-support message, not payment or provisioning copy", () => {
    for (const lifecycle of ["suspended", "cancelled", "archived"] as const) {
      const msg = lockMessageFor(lifecycle, "AI voice agent");
      assert.match(msg.description, /on hold/i);
      assert.doesNotMatch(msg.description, /payment|provisioning|set up/i);
    }
  });

  test("active but locked anyway uses the audit's exact required generic message (item 9), never payment language", () => {
    const msg = lockMessageFor("active", "Phone number & calls");
    assert.equal(
      msg.description,
      "This service is currently unavailable. Please contact support.",
      "must match the audit spec's exact wording",
    );
    assert.doesNotMatch(msg.description, /payment|provisioning|set up|entitlement|admin/i);
    assert.equal(msg.cta, undefined);
  });

  test("does not assume every lock means payment required (item 10) — three distinct message families exist", () => {
    const pending = lockMessageFor("setup_payment_pending", "X");
    const provisioning = lockMessageFor("provisioning", "X");
    const activeLocked = lockMessageFor("active", "X");
    const descriptions = [pending.description, provisioning.description, activeLocked.description];
    assert.equal(new Set(descriptions).size, 3, "each lifecycle family must have distinct wording");
  });

  test("no message ever leaks internal/provider/billing/security detail (item 5)", () => {
    const lifecycles = [
      "not_provisioned",
      "setup_payment_pending",
      "setup_paid",
      "provisioning",
      "ready",
      "active",
      "suspended",
      "cancelled",
      "archived",
    ] as const;
    const forbidden = [
      "provider_cost",
      "gross_profit",
      "razorpay",
      "sarvam",
      "exotel",
      "sql",
      "postgres",
      "rls",
      "entitlement",
      "organization_feature_locks",
      "admin",
      "stack",
      "error:",
    ];
    for (const lifecycle of lifecycles) {
      const msg = lockMessageFor(lifecycle, "AI voice agent");
      const text = `${msg.title} ${msg.description}`.toLowerCase();
      for (const term of forbidden) {
        assert.ok(!text.includes(term), `lifecycle=${lifecycle} leaked "${term}": ${text}`);
      }
    }
  });

  test("the feature label is always interpolated into the title (works for any FeatureKey, not hardcoded to one feature)", () => {
    assert.match(lockMessageFor("active", "WhatsApp").title, /WhatsApp/);
    assert.match(lockMessageFor("active", "Website chatbot").title, /Website chatbot/);
  });
});

const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");
const componentsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "components", "app");

function readRoute(name: string): string {
  return readFileSync(join(routesDir, name), "utf8");
}

describe("route wiring — voice/phone locks are actually surfaced", () => {
  test("app.agent.tsx gates only publish/rollback, using the 'voice' feature key", () => {
    const src = readRoute("app.agent.tsx");
    assert.match(
      src,
      /import\s*\{\s*ServiceLocked\s*\}\s*from\s*"@\/components\/app\/ServiceLocked"/,
    );
    assert.match(src, /featureLocksQuery/);
    assert.match(src, /locks\?\.\["voice"\]/);
    assert.match(src, /<ServiceLocked feature="voice"/);
    // Publish (now a two-step confirm-then-publish flow — Phase 3) and
    // Restore must be disabled when locked. The trigger button that opens
    // the publish confirmation dialog carries the same disabled condition
    // as before; doPublish itself is only reachable from inside that dialog.
    assert.match(
      src,
      /onClick=\{\(\) => \{\s*\n\s*setPublishError\(null\);\s*\n\s*setPublishConfirmOpen\(true\);\s*\n\s*\}\}\s*\n\s*disabled=\{publishing \|\| voiceLocked\}/,
    );
    assert.match(
      src,
      /onClick=\{\(e\) => \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*void doPublish\(\);/,
    );
    assert.match(
      src,
      /disabled=\{voiceLocked\}[\s\S]{0,120}onClick=\{async \(\) => \{\s*\n\s*await rollback/,
    );
    // ...but configuration/preview/test actions must NOT be gated by this
    // change (agent.functions.ts's own H1 comment: these stay usable
    // during setup). None of these onClick handlers should be wrapped in
    // a voiceLocked-disabled prop.
    assert.doesNotMatch(src, /onClick=\{save\}\s+disabled=\{saving \|\| voiceLocked\}/);
    assert.doesNotMatch(src, /onClick=\{send\}\s+disabled=\{thinking \|\| voiceLocked\}/);
  });

  test("app.numbers.tsx replaces the service panel with ServiceLocked for the 'phone' feature when locked", () => {
    const src = readRoute("app.numbers.tsx");
    assert.match(
      src,
      /import\s*\{\s*ServiceLocked\s*\}\s*from\s*"@\/components\/app\/ServiceLocked"/,
    );
    assert.match(src, /featureLocksQuery/);
    assert.match(src, /locks\?\.\["phone"\]/);
    assert.match(src, /phoneLocked \? \(\s*\n\s*<ServiceLocked feature="phone"/);
  });

  test("app.calls.tsx and app.leads.tsx show a compact phone-lock banner without hiding historical data", () => {
    for (const file of ["app.calls.tsx", "app.leads.tsx"]) {
      const src = readRoute(file);
      assert.match(
        src,
        /import\s*\{\s*ServiceLocked\s*\}\s*from\s*"@\/components\/app\/ServiceLocked"/,
        file,
      );
      assert.match(src, /locks\?\.\["phone"\]/, file);
      assert.match(src, /<ServiceLocked feature="phone"[\s\S]{0,40}compact/, file);
      // The compact banner must be additive (rendered alongside, not
      // replacing, the loading/data/empty-state branch below it) —
      // confirm the existing isLoading ternary still immediately follows
      // it, untouched.
      const serviceLockedIdx = src.indexOf("<ServiceLocked");
      const isLoadingIdx = src.indexOf("{isLoading ?", serviceLockedIdx);
      assert.ok(serviceLockedIdx > -1 && isLoadingIdx > -1, file);
      const between = src.slice(serviceLockedIdx, isLoadingIdx);
      assert.ok(
        !/\breturn\b/.test(between),
        `${file}: expected no early return between the lock banner and the existing content branch`,
      );
    }
  });

  test("app.tsx (dashboard-level routing/lifecycle logic) was not modified by this change", () => {
    const src = readRoute("app.tsx");
    assert.doesNotMatch(
      src,
      /ServiceLocked/,
      "dashboard-level gating must stay untouched by the per-page fix",
    );
    // The existing full-dashboard lock conditions must be exactly as before.
    assert.match(
      src,
      /const showLockedScreen = customerLocked \|\| dashboardForceLocked \|\| setupPending;/,
    );
  });
});

describe("server-side authorization remains untouched and authoritative", () => {
  test("agent.functions.ts still calls assertFeatureUnlocked before publish/rollback (H1 unmodified)", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "agent.functions.ts"),
      "utf8",
    );
    const count = [...src.matchAll(/assertFeatureUnlocked\(organizationId, "voice"\)/g)].length;
    assert.equal(
      count,
      2,
      "expected exactly the two H1 gate calls (publish + rollback), unchanged by H2",
    );
  });

  test("telephony-guard.server.ts still calls checkFeatureAccess for 'phone' (H1 unmodified)", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "telephony-guard.server.ts"),
      "utf8",
    );
    assert.match(src, /checkFeatureAccess\(orgId, "phone"\)/);
  });

  test("ServiceLocked.tsx contains no Supabase/RPC/database calls — it is presentation only", () => {
    const src = readFileSync(join(componentsDir, "ServiceLocked.tsx"), "utf8");
    // Check actual code, not the module doc comment (which legitimately
    // names feature_locked()/featureLocksQuery in prose explaining the
    // architecture) — strip everything up to the first import-free line.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(codeOnly, /supabase\.|\.rpc\(/i);
  });
});
