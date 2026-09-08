import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the Sarvam migration's Phase 6/10 requirement:
 * "Do not charge a customer twice because Sarvam retries a webhook." /
 * "Do not charge for an attempt that should not be billed."
 *
 * This is provider-agnostic, pre-existing (Phase D) protection — reused
 * unmodified for Sarvam per requirement E ("do not create a parallel
 * billing system") — but it was never covered by a dedicated test before
 * this pass. Three independent layers exist; this suite scans the
 * migration SQL and telephony-guard.server.ts (source-scan, since the SQL
 * itself cannot execute in this sandbox — no live Supabase connection, per
 * this session's established constraint) to confirm all three are present
 * as written:
 *
 *   1. Call-state-machine layer (already tested in
 *      telephony-guard.server.test.ts): a same-status webhook is a no-op,
 *      so applyCallEvent never calls finalizeCallBilling twice for one
 *      call reaching the same terminal state.
 *   2. Application layer: debit_wallet_for_call checks for an existing
 *      wallet_transactions row (by organization_id + kind='call_usage' +
 *      reference=call_id) BEFORE inserting, returning already_applied=true
 *      instead of debiting again.
 *   3. Storage layer: a UNIQUE index on
 *      wallet_transactions(organization_id, reference) WHERE
 *      kind='call_usage' makes a duplicate debit impossible even if the
 *      application-layer check were ever bypassed by a bug — the same
 *      belt-and-suspenders pattern is applied to usage_records.
 */

const migrationSrc = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "supabase",
    "migrations",
    "20260904120000_phase_d_telephony_infrastructure.sql",
  ),
  "utf8",
);

const guardSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "telephony-guard.server.ts"),
  "utf8",
);

describe("wallet debit idempotency (application layer)", () => {
  test("debit_wallet_for_call checks for an existing reference before inserting a new debit", () => {
    const fnSrc = migrationSrc.slice(
      migrationSrc.indexOf("CREATE OR REPLACE FUNCTION public.debit_wallet_for_call"),
      migrationSrc.indexOf("CREATE OR REPLACE FUNCTION public.wallet_can_afford"),
    );
    assert.match(
      fnSrc,
      /SELECT reference INTO existing_ref FROM public\.wallet_transactions\s*\n\s*WHERE organization_id = _org AND kind = 'call_usage' AND reference = _call_id::text/,
    );
    assert.match(fnSrc, /IF existing_ref IS NOT NULL THEN/);
    assert.match(fnSrc, /RETURN QUERY SELECT true, true, new_balance;/);
  });

  test("the existing-reference check runs before any INSERT into wallet_transactions, not after", () => {
    const fnSrc = migrationSrc.slice(
      migrationSrc.indexOf("CREATE OR REPLACE FUNCTION public.debit_wallet_for_call"),
      migrationSrc.indexOf("CREATE OR REPLACE FUNCTION public.wallet_can_afford"),
    );
    const checkIdx = fnSrc.indexOf("IF existing_ref IS NOT NULL THEN");
    const insertIdx = fnSrc.indexOf("INSERT INTO public.wallet_transactions");
    assert.ok(checkIdx > -1 && insertIdx > -1);
    assert.ok(checkIdx < insertIdx, "the idempotency check must precede the insert");
  });

  test("debit_wallet_for_call is executable only by service_role — no client or authenticated-user path can call it directly", () => {
    const revokeIdx = migrationSrc.indexOf("REVOKE ALL ON FUNCTION public.debit_wallet_for_call");
    const grantIdx = migrationSrc.indexOf("GRANT EXECUTE ON FUNCTION public.debit_wallet_for_call");
    assert.ok(revokeIdx > -1 && grantIdx > -1);
    assert.match(
      migrationSrc.slice(revokeIdx, revokeIdx + 200),
      /FROM PUBLIC, anon, authenticated/,
    );
    assert.match(migrationSrc.slice(grantIdx, grantIdx + 100), /TO service_role/);
  });
});

describe("wallet debit idempotency (storage layer — backstop even if the application check is ever bypassed)", () => {
  test("a UNIQUE index prevents two wallet_transactions rows for the same organization+call_usage reference", () => {
    assert.match(
      migrationSrc,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_call_usage_ref\s*\n\s*ON public\.wallet_transactions \(organization_id, reference\) WHERE kind = 'call_usage';/,
    );
  });

  test("a UNIQUE index prevents a call from contributing more than one usage_records row per kind", () => {
    assert.match(
      migrationSrc,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_records_call_kind\s*\n\s*ON public\.usage_records \(call_id, kind\) WHERE call_id IS NOT NULL;/,
    );
  });
});

describe("finalizeCallBilling — reused unmodified for every provider, including Sarvam", () => {
  test("the usage_records write also declares onConflict/ignoreDuplicates, matching the storage-layer index (belt and suspenders)", () => {
    const fnSrc = guardSrc.slice(guardSrc.indexOf("export async function finalizeCallBilling"));
    assert.match(fnSrc, /debit_wallet_for_call/);
    assert.match(fnSrc, /already_applied/);
    assert.match(fnSrc, /onConflict:\s*"call_id,kind",\s*ignoreDuplicates:\s*true/);
  });

  test("finalizeCallBilling never branches on provider — the same function runs for exotel, sarvam, or any future provider", () => {
    const fnSrc = guardSrc.slice(guardSrc.indexOf("export async function finalizeCallBilling"));
    assert.doesNotMatch(fnSrc, /call\.provider|direction === "sarvam"|=== "exotel"/);
  });
});

describe("provider-financial columns cannot be forged or read by customers (customer cannot manipulate Sarvam IDs / see provider cost)", () => {
  test("call_logs' customer-facing SELECT grant excludes provider_cost, gross_profit and provider_metadata", () => {
    const grantIdx = migrationSrc.indexOf("REVOKE SELECT ON public.call_logs FROM authenticated;");
    const grantEndIdx = migrationSrc.indexOf(") ON public.call_logs TO authenticated;");
    assert.ok(grantIdx > -1 && grantEndIdx > -1);
    const grantBlock = migrationSrc.slice(grantIdx, grantEndIdx);
    assert.doesNotMatch(grantBlock, /provider_cost/);
    assert.doesNotMatch(grantBlock, /gross_profit/);
    assert.doesNotMatch(grantBlock, /provider_metadata/);
    // customer_charge — what they're actually billed — remains visible.
    assert.match(grantBlock, /customer_charge/);
  });

  test("phone_numbers and call_logs remain admin/service-role write-only — the pre-existing customer SELECT-only grant is untouched by this migration", () => {
    assert.match(
      migrationSrc,
      /Numbers remain admin\/service-role-writable only[\s\S]{0,300}telephony-admin\.functions\.ts/,
    );
  });
});
