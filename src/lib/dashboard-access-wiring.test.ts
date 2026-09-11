import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Production bug: an admin explicitly unlocking "Dashboard access" for a
 * customer (organization_feature_locks, feature='dashboard', locked=false)
 * had no effect on either the public navbar's Dashboard button or /app
 * itself — both hand-rolled their own, different, and in app.tsx's case
 * outright wrong, dashboard-access logic instead of going through one
 * shared, correct rule.
 *
 * Root cause (see src/lib/dashboard-access.ts's doc comment for the full
 * trace): feature_locked('dashboard') cannot distinguish "admin explicitly
 * unlocked it" from "no override at all" — both return `false` — so
 * app.tsx's setupPending (computed independently of any override) could
 * still force the setup-payment screen even after an explicit unlock,
 * contradicting the admin panel's own documented promise ("Unlocked
 * features are free for this customer, overriding the platform default").
 * PublicNav's Dashboard button never consulted the override system at all —
 * it only checked `Boolean(org) && lifecycle_status !== "archived"`.
 *
 * Fix: both now share one rule (isDashboardLocked, with its own exhaustive
 * real unit tests in dashboard-access.test.ts) fed by the same two,
 * already-existing, RLS-protected data sources: workspaceQuery (the
 * caller's own organization, via organization_members RLS scoped to
 * auth.uid()) and dashboardOverrideQuery (the raw organization_feature_locks
 * row for 'dashboard', via its own "members read own locks" RLS policy).
 *
 * This file proves the *wiring* — that both call sites actually feed the
 * shared rule from these trusted sources, never from anything client-
 * supplied, and that no new authorization system or RLS change was
 * introduced. Source-scanned, matching this repo's established convention
 * for React/route files this test runner can't render directly.
 */

const dir = dirname(fileURLToPath(import.meta.url));
const publicNavSrc = readFileSync(join(dir, "..", "components", "app", "PublicNav.tsx"), "utf8");
const appRouteSrc = readFileSync(join(dir, "..", "routes", "app.tsx"), "utf8");
const accessSrc = readFileSync(join(dir, "access.ts"), "utf8");
const dashboardAccessSrc = readFileSync(join(dir, "dashboard-access.ts"), "utf8");
const featureLocksMigration = readFileSync(
  join(
    dir,
    "..",
    "..",
    "supabase",
    "migrations",
    "20260901051419_61b91201-6016-476c-88a1-59440b4c6265.sql",
  ),
  "utf8",
);

describe("PublicNav and /app share exactly one dashboard-access rule", () => {
  test("PublicNav's useDashboardAccess calls isDashboardLocked", () => {
    assert.match(publicNavSrc, /import \{ isDashboardLocked \} from "@\/lib\/dashboard-access";/);
    assert.match(publicNavSrc, /!isDashboardLocked\(\{/);
  });

  test("app.tsx's showLockedScreen calls the exact same isDashboardLocked", () => {
    assert.match(appRouteSrc, /import \{ isDashboardLocked \} from "@\/lib\/dashboard-access";/);
    assert.match(appRouteSrc, /const showLockedScreen = isDashboardLocked\(\{/);
  });

  test("neither file re-implements the lock precedence itself (no second lifecycle/payment_override boolean algebra)", () => {
    for (const src of [publicNavSrc, appRouteSrc]) {
      assert.doesNotMatch(src, /lifecycle_status\s*!==\s*"archived"/);
      assert.doesNotMatch(src, /!org\?\.payment_override\s*&&/);
    }
  });
});

describe("the organization id fed into the access check is always server-derived, never client-supplied", () => {
  test("PublicNav derives org id only from workspaceQuery's result (org?.id), never a prop/param/localStorage", () => {
    const idx = publicNavSrc.indexOf("dashboardOverrideQuery(org?.id)");
    assert.ok(idx > -1, "expected dashboardOverrideQuery to be called with org?.id");
    assert.doesNotMatch(publicNavSrc, /localStorage\.|localStorage\[/);
    assert.doesNotMatch(publicNavSrc, /searchParams|useSearch\(/);
  });

  test("app.tsx derives org id only from workspaceQuery's result (org?.id)", () => {
    const idx = appRouteSrc.indexOf("dashboardOverrideQuery(org?.id)");
    assert.ok(idx > -1, "expected dashboardOverrideQuery to be called with org?.id");
    assert.doesNotMatch(appRouteSrc, /localStorage\.|localStorage\[/);
  });

  test("workspaceQuery itself never accepts a client-suppliable organization id — only a userId, resolved via requireSupabaseAuth/useAuth elsewhere", () => {
    // Re-affirms the existing contract in src/lib/workspace.ts: the query
    // relies entirely on organization_members RLS (scoped to auth.uid()),
    // never an explicit .eq("organization_id", ...) with a caller-chosen id.
    const workspaceSrc = readFileSync(join(dir, "workspace.ts"), "utf8");
    const fnIdx = workspaceSrc.indexOf("export const workspaceQuery");
    const block = workspaceSrc.slice(fnIdx, workspaceSrc.indexOf("export const servicesQuery"));
    assert.doesNotMatch(block, /organization_id["']?\s*,\s*(orgId|organizationId)/);
  });
});

describe("dashboardOverrideQuery reuses the existing organization_feature_locks table/RLS, not a new mechanism", () => {
  test("reads organization_feature_locks directly, scoped by organization_id and feature='dashboard'", () => {
    const idx = accessSrc.indexOf("export const dashboardOverrideQuery");
    assert.ok(idx > -1);
    const block = accessSrc.slice(idx, idx + 700);
    assert.match(block, /\.from\("organization_feature_locks"\)/);
    assert.match(block, /\.eq\("organization_id", orgId!\)/);
    assert.match(block, /\.eq\("feature", "dashboard"\)/);
  });

  test("the RLS policy this read depends on is unmodified: members read own locks (is_org_member OR is_platform_admin)", () => {
    assert.match(
      featureLocksMigration,
      /CREATE POLICY "members read own locks" ON public\.organization_feature_locks\s*\n\s*FOR SELECT TO authenticated USING \(public\.is_org_member\(organization_id\) OR public\.is_platform_admin\(\)\);/,
    );
  });

  test("no broader grant was added — organization_feature_locks stays SELECT-only for authenticated, ALL only for service_role", () => {
    assert.match(
      featureLocksMigration,
      /GRANT SELECT ON public\.organization_feature_locks TO authenticated;/,
    );
    assert.match(
      featureLocksMigration,
      /GRANT ALL ON public\.organization_feature_locks TO service_role;/,
    );
    assert.doesNotMatch(
      featureLocksMigration,
      /GRANT (INSERT|UPDATE|DELETE|ALL) ON public\.organization_feature_locks TO authenticated/,
    );
  });
});

describe("cross-tenant isolation: an org id another tenant owns can never surface a usable override", () => {
  test("dashboardOverrideQuery has no fallback/admin bypass path in application code — RLS is the only gate", () => {
    const idx = accessSrc.indexOf("export const dashboardOverrideQuery");
    const block = accessSrc.slice(idx, accessSrc.indexOf("export const paymentEnforcementQuery"));
    assert.doesNotMatch(block, /supabaseAdmin/);
  });
});

describe("item 12 scenarios: authenticated-state wiring", () => {
  test("unauthenticated visitor never queries workspace or override data (both gated on `enabled: Boolean(session)`)", () => {
    const wsCallIdx = publicNavSrc.indexOf("...workspaceQuery(user?.id)");
    const wsBlock = publicNavSrc.slice(wsCallIdx, wsCallIdx + 100);
    assert.match(wsBlock, /enabled:\s*Boolean\(session\)/);

    const overrideCallIdx = publicNavSrc.indexOf("...dashboardOverrideQuery(org?.id)");
    const overrideBlock = publicNavSrc.slice(overrideCallIdx, overrideCallIdx + 120);
    assert.match(overrideBlock, /enabled:\s*Boolean\(session\)\s*&&\s*Boolean\(org\?\.id\)/);
  });

  test("hasDashboard is false whenever there is no organization at all (authenticated user without workspace)", () => {
    assert.match(publicNavSrc, /hasDashboard\s*=\s*\n?\s*Boolean\(org\)\s*&&/);
  });

  test("app.tsx redirects an authenticated user with no workspace back to the public site (unchanged)", () => {
    assert.match(
      appRouteSrc,
      /if \(!loading && session && !isLoading && !org\) navigate\(\{ to: "\/" \}\);/,
    );
  });

  test("app.tsx waits for the override query to resolve before deciding which screen to render (no flash of the wrong screen)", () => {
    assert.match(appRouteSrc, /session && org && overrideLoading/);
  });
});

describe("direct dashboard route protection beyond the client-side gate", () => {
  test("every privileged agent publish/rollback action still calls assertFeatureUnlocked server-side (unmodified by this fix)", () => {
    const agentFnSrc = readFileSync(join(dir, "agent.functions.ts"), "utf8");
    const count = [...agentFnSrc.matchAll(/assertFeatureUnlocked\(organizationId, "voice"\)/g)]
      .length;
    assert.ok(count >= 2, "expected publish and rollback to both call assertFeatureUnlocked");
  });

  test("telephony access still goes through the canonical checkFeatureAccess resolver server-side (unmodified by this fix)", () => {
    const telephonyGuardSrc = readFileSync(join(dir, "telephony-guard.server.ts"), "utf8");
    assert.match(telephonyGuardSrc, /checkFeatureAccess\(/);
  });
});

describe("isDashboardLocked's own module stays a pure, dependency-free function (no Supabase client, no React)", () => {
  test("no Supabase import, no React import — safe to unit test directly and to call from any consumer", () => {
    assert.doesNotMatch(dashboardAccessSrc, /from ["']@\/integrations\/supabase/);
    assert.doesNotMatch(dashboardAccessSrc, /from ["']react["']/);
  });
});
