import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ADJUSTMENT_KEY_REUSED_MESSAGE,
  parseWalletAdjustment,
  postWalletAdjustment,
} from "./wallet-adjustment.server.ts";

/**
 * MOCKED: validation and the duplicate/reuse decision. The unique index that
 * makes a second row impossible under real concurrency is proven against
 * PostgreSQL (wallet_ledger_integrity.pg.test.ts and the local QA run).
 */

const KEY = "req_0123456789abcdef0123456789abcdef";
const base = { orgId: "org_1", amount: 500, reason: "Goodwill credit", idempotencyKey: KEY };

describe("what an admin may post", () => {
  test("a valid adjustment is normalized (rounded amount, trimmed reason, default kind)", () => {
    assert.deepEqual(parseWalletAdjustment({ ...base, amount: 499.6, reason: "  x  " }), {
      orgId: "org_1",
      amount: 500,
      kind: "manual_adjustment",
      reason: "x",
      idempotencyKey: KEY,
    });
  });
  test("never a call charge, and only the listed kinds", () => {
    for (const kind of ["call_usage", "topup", "", "anything"])
      assert.throws(() => parseWalletAdjustment({ ...base, kind }), /Adjustment type must be/);
    assert.equal(parseWalletAdjustment({ ...base, kind: "refund" }).kind, "refund");
  });
  test("zero, non-numeric, missing reason or a missing/malformed request id are refused", () => {
    assert.throws(() => parseWalletAdjustment({ ...base, amount: 0 }), /non-zero/);
    assert.throws(() => parseWalletAdjustment({ ...base, amount: 0.4 }), /non-zero/);
    assert.throws(() => parseWalletAdjustment({ ...base, amount: NaN }), /non-zero/);
    assert.throws(() => parseWalletAdjustment({ ...base, reason: "  " }), /reason/);
    assert.throws(
      () => parseWalletAdjustment({ ...base, idempotencyKey: undefined }),
      /request id/,
    );
    assert.throws(() => parseWalletAdjustment({ ...base, idempotencyKey: "short" }), /request id/);
  });
});

function fakeLedger(existing: Record<string, unknown> | null, insertCode: string | null) {
  const inserts: Record<string, unknown>[] = [];
  const admin = {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserts.push(row);
        return { error: insertCode ? { code: insertCode, message: "x" } : null };
      },
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: existing, error: null }) }),
      }),
    }),
  };
  return { admin: admin as never, inserts };
}
const input = { ...parseWalletAdjustment(base), createdBy: "admin_1" };
const stored = {
  organization_id: "org_1",
  amount: 500,
  kind: "manual_adjustment",
  description: "Goodwill credit",
};

describe("posting once", () => {
  test("the first request writes one row carrying the request id", async () => {
    const { admin, inserts } = fakeLedger(null, null);
    assert.deepEqual(await postWalletAdjustment(admin, input), { applied: true });
    assert.equal(inserts[0]!["idempotency_key"], KEY);
    assert.equal(inserts[0]!["created_by"], "admin_1");
  });
  test("a repeat with the same values is reported as already posted, not applied again", async () => {
    const { admin } = fakeLedger(stored, "23505");
    assert.deepEqual(await postWalletAdjustment(admin, input), { applied: false });
  });
  test("the same request id with different values is refused", async () => {
    for (const changed of [
      { amount: 5000 },
      { kind: "refund" },
      { description: "Other" },
      { organization_id: "org_2" },
    ]) {
      const { admin } = fakeLedger({ ...stored, ...changed }, "23505");
      await assert.rejects(
        postWalletAdjustment(admin, input),
        new RegExp(ADJUSTMENT_KEY_REUSED_MESSAGE.slice(0, 30)),
      );
    }
  });
  test("any other database error is raised, never treated as posted", async () => {
    const { admin } = fakeLedger(null, "23514");
    await assert.rejects(postWalletAdjustment(admin, input));
  });
});

describe("source: authorization and audit stay in place", () => {
  const fns = readFileSync(new URL("./admin.functions.ts", import.meta.url), "utf8");
  const handler = fns.slice(
    fns.indexOf("export const adjustWallet"),
    fns.indexOf("export const listPlatformSettings"),
  );
  test("platform admin with wallet.write before anything is written; audited only when applied", () => {
    const gate = handler.indexOf(
      'assertPlatformAdmin(context.supabase, context.userId, "wallet.write")',
    );
    assert.ok(gate > -1 && gate < handler.indexOf("postWalletAdjustment(supabaseAdmin"));
    assert.match(handler, /if \(applied\)\s*await writeAudit\(admin,/);
    assert.match(handler, /parseWalletAdjustment\(input \?\? \{\}\)/);
  });
  test("the dialog reuses one request id per adjustment and replaces it after success", () => {
    const page = readFileSync(
      new URL("../routes/admin.customers.$orgId.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      page,
      /if \(walletAttempt\.current\?\.params !== params\)\s*walletAttempt\.current = \{ key: newRequestKey\(\), params \};/,
    );
    assert.match(page, /idempotencyKey: walletAttempt\.current\.key,/);
    assert.match(page, /walletAttempt\.current = null;/);
  });
});
