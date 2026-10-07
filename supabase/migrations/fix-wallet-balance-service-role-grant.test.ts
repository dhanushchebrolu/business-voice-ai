import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Static/textual guard rail for the wallet_balance service_role grant fix
 * (production incident: Vobiz background call-finalization processing
 * failed with `vobiz_answer:background_processing_failed permission denied
 * for function wallet_balance`).
 *
 * Root cause (see the new migration's own header comment for the full
 * trace): `debit_wallet_for_call`/`wallet_can_afford` are SECURITY INVOKER
 * functions granted EXECUTE to `service_role` only, and each internally
 * calls `public.wallet_balance(_org)` — but `wallet_balance` itself was
 * only ever granted EXECUTE to `authenticated`, never `service_role`, so
 * every service-role call into either function failed the moment it tried
 * to read the balance.
 *
 * There is no live Postgres instance in this environment (no Supabase
 * project is connected here — the same documented constraint as every
 * other migration-adjacent test in this directory), so this cannot prove
 * runtime GRANT enforcement by actually attempting these calls as
 * `service_role`/`authenticated`/`anon`. What it *can* prove, and does:
 *   1. The new migration grants EXECUTE on wallet_balance to service_role,
 *      and nothing else.
 *   2. It does NOT grant anon or authenticated anything new — the
 *      "never weaken anon/authenticated access to wallet functions"
 *      constraint this fix must preserve.
 *   3. The original migrations were not edited to "fix" this a different
 *      way (this fix must be forward-only, same convention as every other
 *      fix in this directory).
 *   4. debit_wallet_for_call/wallet_can_afford remain revoked from
 *      anon/authenticated in the original migration — this bug must never
 *      be "solved" by exposing wallet mutation/affordability functions to
 *      customer-facing roles.
 *   5. Application code only ever calls these two RPCs through the
 *      service-role `supabaseAdmin` client, never the customer-facing
 *      client — reusing the same source-scan technique
 *      telephony-billing-idempotency.test.ts already established.
 *
 * Real enforcement should still be confirmed by attempting
 * debit_wallet_for_call/wallet_can_afford/wallet_balance as service_role,
 * authenticated, and anon against the live Klyro database before relying
 * on this fix in production.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(migrationsDir, "..", "..");
const srcDir = join(repoRoot, "src");

const NEW_MIGRATION = join(
  migrationsDir,
  "20261007100000_fix_wallet_balance_service_role_grant.sql",
);
const WALLET_BALANCE_MIGRATION = join(
  migrationsDir,
  "20260901051419_61b91201-6016-476c-88a1-59440b4c6265.sql",
);
const PHASE_D_MIGRATION = join(
  migrationsDir,
  "20260904120000_phase_d_telephony_infrastructure.sql",
);

function readSql(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strips `--` line comments so assertions about what the migration actually EXECUTES aren't tripped up by prose in its own explanatory header comment mentioning the same function/keyword names. */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("wallet_balance service_role grant fix (production incident: permission denied for function wallet_balance)", () => {
  test("new migration grants service_role EXECUTE on wallet_balance", () => {
    const sql = readSql(NEW_MIGRATION);
    assert.match(
      sql,
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.wallet_balance\(uuid\)\s+TO\s+service_role/i,
    );
  });

  test("new migration grants nothing to anon or authenticated — only closes the service_role gap", () => {
    const sql = stripSqlComments(readSql(NEW_MIGRATION));
    assert.doesNotMatch(
      sql,
      /GRANT[^\n]*TO\s+(anon|authenticated)\b/i,
      "this fix must never grant anything to anon/authenticated",
    );
  });

  test("new migration's actual SQL does not touch debit_wallet_for_call or wallet_can_afford directly (comments may mention them; the executed statements must not)", () => {
    const sql = stripSqlComments(readSql(NEW_MIGRATION));
    assert.doesNotMatch(sql, /debit_wallet_for_call/i);
    assert.doesNotMatch(sql, /wallet_can_afford/i);
  });

  test("new migration's actual SQL does not REVOKE anything — it only closes a missing grant, never narrows existing access", () => {
    const sql = stripSqlComments(readSql(NEW_MIGRATION));
    assert.doesNotMatch(sql, /\bREVOKE\b/i);
  });

  test("the original wallet_balance migration was not edited (fix is forward-only)", () => {
    const sql = readSql(WALLET_BALANCE_MIGRATION);
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.wallet_balance\(uuid\) FROM PUBLIC, anon;/,
      "original wallet_balance REVOKE must be untouched — this fix must not edit old migrations",
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.wallet_balance\(uuid\) TO authenticated;/,
      "original wallet_balance authenticated grant must be untouched",
    );
  });

  test("the Phase D migration was not edited: debit_wallet_for_call/wallet_can_afford remain service_role-only, never exposed to anon/authenticated", () => {
    const sql = readSql(PHASE_D_MIGRATION);
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.debit_wallet_for_call\(uuid, uuid, integer, text\) FROM PUBLIC, anon, authenticated;/,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.debit_wallet_for_call\(uuid, uuid, integer, text\) TO service_role;/,
    );
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.wallet_can_afford\(uuid, integer\) FROM PUBLIC, anon, authenticated;/,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.wallet_can_afford\(uuid, integer\) TO service_role;/,
    );
  });

  test("debit_wallet_for_call and wallet_can_afford each call wallet_balance internally — confirming why the service_role grant gap actually broke them", () => {
    const sql = readSql(PHASE_D_MIGRATION);
    const debitFn = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.debit_wallet_for_call"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.wallet_can_afford"),
    );
    const affordFn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.wallet_can_afford"));
    assert.match(debitFn, /public\.wallet_balance\(_org\)/);
    assert.match(affordFn, /public\.wallet_balance\(_org\)/);
    // Neither is SECURITY DEFINER — confirming they run as the CALLING
    // role (service_role) for their whole body, including the nested
    // wallet_balance call, which is exactly why service_role needed its
    // own direct EXECUTE grant on wallet_balance (SECURITY DEFINER would
    // have been a larger, unnecessary change to fix the same gap).
    assert.doesNotMatch(debitFn, /SECURITY DEFINER/i);
    assert.doesNotMatch(affordFn, /SECURITY DEFINER/i);
  });

  test("application code only calls debit_wallet_for_call/wallet_can_afford through the service-role supabaseAdmin client", () => {
    for (const file of listTsFiles(srcDir)) {
      const content = readFileSync(file, "utf8");
      if (!/debit_wallet_for_call|wallet_can_afford/.test(content)) continue;
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (!/\.rpc\(\s*["'](debit_wallet_for_call|wallet_can_afford)["']/.test(line)) return;
        // The RPC call itself should be reached via a `supabaseAdmin`
        // receiver — scan nearby lines for the receiver name actually
        // used, same technique as restrict-organization-provisioning-
        // grants.test.ts.
        const windowStart = Math.max(0, i - 5);
        const window = lines.slice(windowStart, i + 1).join("\n");
        assert.match(
          window,
          /supabaseAdmin\.rpc\(/,
          `${file}:${i + 1} must call this RPC via supabaseAdmin (service_role), never a customer-facing client`,
        );
      });
    }
  });
});
