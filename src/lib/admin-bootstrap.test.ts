import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the first-platform-admin bootstrap
 * (claimPlatformAdmin / bootstrap_first_platform_admin), covering the
 * production incident where platform_admins was empty and /admin had no
 * reachable claim flow once PLATFORM_ADMIN_BOOTSTRAP_SECRET was configured.
 *
 * Source-scanned, matching this repo's established convention: admin.functions.ts
 * exports createServerFn handlers, which this Node-native test runner cannot
 * safely import/execute directly (see admin.functions.test.ts,
 * sarvam-admin.functions.test.ts, telephony-admin.functions.test.ts), and the
 * migration is raw SQL with no live Postgres available to this runner either.
 */

const dir = dirname(fileURLToPath(import.meta.url));
const fnSrc = readFileSync(join(dir, "admin.functions.ts"), "utf8");
const routeSrc = readFileSync(join(dir, "..", "routes", "admin.tsx"), "utf8");
const migrationSrc = readFileSync(
  join(
    dir,
    "..",
    "..",
    "supabase",
    "migrations",
    "20260910120000_atomic_platform_admin_bootstrap.sql",
  ),
  "utf8",
);

function extractFn(name: string): string {
  const start = fnSrc.indexOf(`export const ${name} = createServerFn`);
  assert.ok(start > -1, `expected to find export const ${name}`);
  const nextExportIdx = fnSrc.indexOf("\nexport const ", start + 1);
  const nextInterfaceIdx = fnSrc.indexOf("\ninterface ", start + 1);
  const ends = [nextExportIdx, nextInterfaceIdx].filter((i) => i > -1);
  const end = ends.length ? Math.min(...ends) : fnSrc.length;
  return fnSrc.slice(start, end);
}

describe("claimPlatformAdmin requires authentication before anything else", () => {
  test("both getAdminSession and claimPlatformAdmin are wrapped in requireSupabaseAuth", () => {
    assert.match(extractFn("getAdminSession"), /\.middleware\(\[requireSupabaseAuth\]\)/);
    assert.match(extractFn("claimPlatformAdmin"), /\.middleware\(\[requireSupabaseAuth\]\)/);
  });

  test("requireSupabaseAuth rejects a request with no bearer token before any handler runs", () => {
    const middlewareSrc = readFileSync(
      join(dir, "..", "integrations", "supabase", "auth-middleware.ts"),
      "utf8",
    );
    assert.match(middlewareSrc, /if \(!authHeader\)/);
    assert.match(middlewareSrc, /Unauthorized: No authorization header provided/);
    assert.match(middlewareSrc, /if \(!authHeader\.startsWith\('Bearer '\)\)/);
  });
});

describe("claimPlatformAdmin validates the bootstrap secret with a timing-safe comparison", () => {
  const claim = extractFn("claimPlatformAdmin");

  test("secretsMatch (crypto.timingSafeEqual) is checked before the RPC call, and a mismatch throws before touching the database", () => {
    assert.match(fnSrc, /import \{ timingSafeEqual \} from "crypto"/);
    assert.match(fnSrc, /return timingSafeEqual\(a, b\)/);
    const secretCheckIdx = claim.indexOf("if (!secretsMatch(data.bootstrapSecret, expected))");
    const rpcIdx = claim.indexOf('supabaseAdmin.rpc("bootstrap_first_platform_admin"');
    assert.ok(secretCheckIdx > -1 && rpcIdx > -1);
    assert.ok(secretCheckIdx < rpcIdx, "the secret must be validated before any DB write");
    assert.match(
      claim.slice(secretCheckIdx, secretCheckIdx + 100),
      /throw new Error\("Unauthorized"\)/,
    );
  });

  test("no secret configured (getBootstrapSecret() null) rejects before comparing anything", () => {
    const noSecretIdx = claim.indexOf("if (!expected)");
    const secretCheckIdx = claim.indexOf("if (!secretsMatch(");
    assert.ok(noSecretIdx > -1 && noSecretIdx < secretCheckIdx);
    assert.match(
      claim.slice(noSecretIdx, noSecretIdx + 100),
      /Bootstrap is not enabled for this environment/,
    );
  });

  test("the bootstrap secret is read only from process.env, never import.meta.env (which would bake it into the client bundle)", () => {
    assert.match(fnSrc, /process\.env\["PLATFORM_ADMIN_BOOTSTRAP_SECRET"\]/);
    assert.doesNotMatch(fnSrc, /import\.meta\.env.*PLATFORM_ADMIN_BOOTSTRAP_SECRET/);
    // Repo-wide: this must be the only place the secret is ever read from.
    for (const forbiddenFile of ["client.ts"]) {
      const path = join(dir, "..", "integrations", "supabase", forbiddenFile);
      const src = readFileSync(path, "utf8");
      assert.doesNotMatch(src, /PLATFORM_ADMIN_BOOTSTRAP_SECRET/);
    }
  });
});

describe("the bootstrap secret and the raw comparison inputs are never returned, logged, or echoed", () => {
  test("claimPlatformAdmin's only return value is { ok: true }, never the secret or comparison internals", () => {
    const claim = extractFn("claimPlatformAdmin");
    const returnStatements = [...claim.matchAll(/return\s+\{[^}]*\}/g)].map((m) => m[0]);
    assert.ok(returnStatements.length > 0);
    for (const stmt of returnStatements) {
      assert.doesNotMatch(stmt, /secret/i);
      assert.doesNotMatch(stmt, /bootstrapSecret/);
    }
  });

  test("no console.log/console.error call in this file ever includes the secret or the raw provided value", () => {
    const logCalls = [...fnSrc.matchAll(/console\.(log|error|warn|info)\([^)]*\)/g)].map(
      (m) => m[0],
    );
    for (const call of logCalls) {
      assert.doesNotMatch(call, /bootstrapSecret/);
      assert.doesNotMatch(call, /getBootstrapSecret/);
      assert.doesNotMatch(call, /\bexpected\b/);
    }
  });

  test("the client route (admin.tsx) never imports process.env, import.meta.env, or the raw secret — it only forwards the user's typed value to the server function", () => {
    assert.doesNotMatch(routeSrc, /PLATFORM_ADMIN_BOOTSTRAP_SECRET/);
    assert.doesNotMatch(routeSrc, /process\.env/);
    assert.match(routeSrc, /claim\(\{ data: \{ bootstrapSecret \} \}\)/);
  });
});

describe("first-admin claim: happy path and rejection paths", () => {
  const claim = extractFn("claimPlatformAdmin");

  test("no admins + correct secret: RPC is called with the authenticated caller's own userId, and success writes an audit record and returns ok", () => {
    assert.match(claim, /p_user_id:\s*context\.userId/);
    assert.match(claim, /p_email:\s*email/);
    assert.match(claim, /if \(!claimed\) throw new Error/);
    assert.match(claim, /await writeAudit\(/);
    assert.match(claim, /action:\s*"platform_admin\.bootstrap"/);
    assert.match(claim, /return \{ ok: true as const \};/);
  });

  test("existing admin (RPC returns false): rejected with a clear error, no audit write for a failed claim", () => {
    const rejectIdx = claim.indexOf("if (!claimed) throw new Error");
    assert.ok(rejectIdx > -1);
    assert.match(
      claim.slice(rejectIdx, rejectIdx + 90),
      /Platform administration is already configured/,
    );
    const auditIdx = claim.indexOf("await writeAudit(");
    assert.ok(rejectIdx < auditIdx, "the audit write must be unreachable when claimed is false");
  });

  test("the RPC error path is also surfaced (RPC transport/DB failure does not silently succeed)", () => {
    assert.match(claim, /if \(error\) throw error;/);
  });
});

describe("bootstrap is atomic against concurrent callers (only one first admin can ever be claimed)", () => {
  test("admin.functions.ts no longer does a separate count-then-upsert — the whole check-then-write happens in one RPC call", () => {
    const claim = extractFn("claimPlatformAdmin");
    assert.doesNotMatch(claim, /\.select\("user_id",\s*\{\s*count:/);
    assert.doesNotMatch(claim, /\.from\("platform_admins"\)\s*\n?\s*\.upsert\(/);
    assert.match(claim, /supabaseAdmin\.rpc\("bootstrap_first_platform_admin"/);
  });

  test("bootstrap_first_platform_admin serializes concurrent callers with a Postgres advisory lock before the existence check", () => {
    const lockIdx = migrationSrc.indexOf("pg_advisory_xact_lock");
    const existsIdx = migrationSrc.indexOf(
      "IF EXISTS (SELECT 1 FROM public.platform_admins WHERE is_active)",
    );
    assert.ok(lockIdx > -1 && existsIdx > -1);
    assert.ok(lockIdx < existsIdx, "the lock must be acquired before the emptiness check");
  });

  test("the check and the insert live in the same SECURITY DEFINER transaction (one round trip, not two)", () => {
    assert.match(migrationSrc, /SECURITY DEFINER/);
    const existsIdx = migrationSrc.indexOf("IF EXISTS");
    const insertIdx = migrationSrc.indexOf("INSERT INTO public.platform_admins");
    const returnFalseIdx = migrationSrc.indexOf("RETURN false;");
    assert.ok(existsIdx < returnFalseIdx && returnFalseIdx < insertIdx);
  });

  test("the function is callable only by service_role — never by an authenticated user's own session or anonymously", () => {
    assert.match(
      migrationSrc,
      /REVOKE ALL ON FUNCTION public\.bootstrap_first_platform_admin\(uuid, text\) FROM PUBLIC, anon, authenticated;/,
    );
    assert.match(
      migrationSrc,
      /GRANT EXECUTE ON FUNCTION public\.bootstrap_first_platform_admin\(uuid, text\) TO service_role;/,
    );
  });

  test("a second, later caller re-checks against the committed state and is turned away, without disturbing the already-active admin", () => {
    assert.match(migrationSrc, /RETURN false;/);
    assert.doesNotMatch(migrationSrc, /DELETE FROM public\.platform_admins/);
  });
});

describe("normal platform-admin authorization is unaffected by the bootstrap fix", () => {
  test("getAdminSession still resolves admin/capabilities from platform_admins.is_active — unchanged by the bootstrap fix", () => {
    const session = extractFn("getAdminSession");
    assert.match(session, /\.from\("platform_admins"\)/);
    assert.match(session, /if \(!data \|\| !data\.is_active\)/);
    assert.match(session, /capabilities: capabilitiesFor\(role\)/);
  });

  test("every other admin.functions.ts handler still gates through assertPlatformAdmin — bootstrap did not add a new bypass", () => {
    for (const name of [
      "getAdminOverview",
      "listCustomers",
      "getCustomerDetail",
      "setFeatureLock",
      "adjustWallet",
      "listPlatformSettings",
      "updatePlatformSetting",
      "listAuditLogs",
      "listPlatformAdmins",
      "upsertPlatformAdmin",
    ]) {
      assert.match(
        extractFn(name),
        /assertPlatformAdmin\(context\.supabase, context\.userId/,
        `${name} must still call assertPlatformAdmin`,
      );
    }
  });

  test("no admin email is hardcoded anywhere in the bootstrap path — the caller's identity comes only from their authenticated JWT claims", () => {
    assert.doesNotMatch(fnSrc, /@gmail\.com/);
    assert.doesNotMatch(fnSrc, /chdhanush56/);
    assert.doesNotMatch(routeSrc, /@gmail\.com/);
    assert.doesNotMatch(routeSrc, /chdhanush56/);
    assert.match(fnSrc, /context\.claims\["email"\]/);
  });
});

describe("/admin shows a bootstrap UI instead of a dead end when platform_admins is empty", () => {
  test("the restricted-access screen renders the bootstrap form only when bootstrapAvailable is true, and it is gone once an admin exists", () => {
    assert.match(routeSrc, /data\?\.bootstrapAvailable/);
    assert.match(routeSrc, /Initialize platform administrator/);
    const idx = routeSrc.indexOf("data?.bootstrapAvailable ? (");
    assert.ok(idx > -1);
  });

  test("no plaintext secret is ever displayed — the input is type=password and autoComplete=off", () => {
    const idx = routeSrc.indexOf("Bootstrap secret");
    assert.ok(idx > -1);
    const block = routeSrc.slice(idx - 200, idx + 50);
    assert.match(block, /type="password"/);
    assert.match(block, /autoComplete="off"/);
  });
});
