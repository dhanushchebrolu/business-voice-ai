import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  checkFeatureAccess,
  assertFeatureUnlocked,
  type FeatureRpcResult,
} from "./feature-gate.server.ts";
import { PLATFORM_FEATURES } from "./features.ts";

/**
 * Regression coverage for H1 (server-side feature/entitlement enforcement):
 * defense-in-depth so a gated action (currently publishAgentVersion and
 * rollbackAgentVersion — "publishing and running the voice receptionist",
 * per the "voice" feature's own description) independently enforces the
 * canonical feature_locked() decision server-side, not just relying on the
 * frontend hiding a button or on RLS row-scoping.
 *
 * There is no live Postgres/Supabase instance in this environment (confirmed
 * blocked earlier this session), so this cannot execute the real
 * feature_locked() SQL function and prove its precedence directly — that is
 * already covered, as a static/logic mirror, by
 * supabase/migrations/enforce-lifecycle-gate-before-feature-defaults.test.ts.
 * What THIS suite proves, using the real (not reimplemented)
 * checkFeatureAccess/assertFeatureUnlocked functions with only the RPC call
 * itself swapped for a controllable fake (the same dependency-injection
 * shape already established by public-assistant.functions.ts's
 * runPublicChat/runPublicVoiceTurn):
 *
 *   - the actual TypeScript branching (RPC says locked/unlocked/errors ->
 *     what checkFeatureAccess/assertFeatureUnlocked actually do) is correct
 *     for every lifecycle scenario the audit asked for
 *   - assertFeatureUnlocked throws (never silently proceeds) when locked
 *   - the reason string never contains provider/billing/internal detail
 *   - publishAgentVersion/rollbackAgentVersion actually call the gate BEFORE
 *     any mutating write, and derive organizationId from the trusted,
 *     RLS-scoped requireBusinessAccess() result — never from a
 *     client-supplied field (there is no such field in their input schemas)
 *   - platform-admin functions and configuration/setup functions were not
 *     touched by this fix (structural/source proof, not just narrative)
 *
 * Real end-to-end enforcement (an actual locked organization actually being
 * rejected by a real publishAgentVersion call against the live Klyro Ai
 * database) still needs confirming there before relying on this in
 * production — consistent with every other DB-dependent fix this session.
 */

const agentFunctionsSql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "agent.functions.ts"),
  "utf8",
);

function fakeRpc(
  result: FeatureRpcResult,
): (orgId: string, feature: string) => Promise<FeatureRpcResult> {
  return async () => result;
}

function recordingRpc(result: FeatureRpcResult): {
  rpc: (orgId: string, feature: string) => Promise<FeatureRpcResult>;
  calls: { orgId: string; feature: string }[];
} {
  const calls: { orgId: string; feature: string }[] = [];
  return {
    calls,
    rpc: async (orgId: string, feature: string) => {
      calls.push({ orgId, feature });
      return result;
    },
  };
}

describe("checkFeatureAccess / assertFeatureUnlocked — RPC branching", () => {
  test("locked (feature_locked() returned true) -> not allowed, gated action must be rejected", async () => {
    const gate = await checkFeatureAccess("org-1", "voice", fakeRpc({ data: true, error: null }));
    assert.equal(gate.allowed, false);
    assert.match(gate.reason ?? "", /voice agent|not available/i);
  });

  test("unlocked (feature_locked() returned false) -> allowed", async () => {
    const gate = await checkFeatureAccess("org-1", "voice", fakeRpc({ data: false, error: null }));
    assert.equal(gate.allowed, true);
    assert.equal(gate.reason, null);
  });

  test("RPC error -> fails closed (not allowed), never fails open", async () => {
    const gate = await checkFeatureAccess(
      "org-1",
      "voice",
      fakeRpc({ data: null, error: { message: "connection reset" } }),
    );
    assert.equal(gate.allowed, false);
  });

  test("assertFeatureUnlocked throws when locked (this is how a gated action gets rejected)", async () => {
    await assert.rejects(
      () => assertFeatureUnlocked("org-1", "voice", fakeRpc({ data: true, error: null })),
      /voice agent|not available/i,
    );
  });

  test("assertFeatureUnlocked resolves without throwing when unlocked (active entitlement / active default) — the action proceeds", async () => {
    await assertFeatureUnlocked("org-1", "voice", fakeRpc({ data: false, error: null }));
    // No throw = success. Nothing further to assert.
  });

  test("the reason string never leaks internal/provider/billing detail", async () => {
    const gate = await checkFeatureAccess("org-1", "voice", fakeRpc({ data: true, error: null }));
    const reason = (gate.reason ?? "").toLowerCase();
    for (const forbidden of [
      "provider_cost",
      "razorpay",
      "sarvam",
      "exotel",
      "sql",
      "postgres",
      "stack",
    ]) {
      assert.ok(!reason.includes(forbidden), `reason leaked "${forbidden}": ${gate.reason}`);
    }
  });

  test("the RPC is called with the exact orgId/feature passed in — no silent substitution", async () => {
    const { rpc, calls } = recordingRpc({ data: false, error: null });
    await checkFeatureAccess("org-42", "voice", rpc);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { orgId: "org-42", feature: "voice" });
  });

  test("a caller cannot bypass the gate by passing a different tenant's org id — the check is keyed strictly on whatever orgId is supplied by the (trusted, server-derived) caller", async () => {
    // This is a contract test: checkFeatureAccess has no notion of "my org"
    // vs "another org" — it trusts orgId completely. Cross-tenant safety
    // therefore depends entirely on callers deriving orgId from a trusted
    // source, never a client field — see the source-scan tests below for
    // publishAgentVersion/rollbackAgentVersion specifically.
    const { rpc, calls } = recordingRpc({ data: true, error: null });
    const gateForOrgA = await checkFeatureAccess("org-a", "voice", rpc);
    const gateForOrgB = await checkFeatureAccess("org-b", "voice", rpc);
    assert.equal(gateForOrgA.allowed, false);
    assert.equal(gateForOrgB.allowed, false);
    assert.deepEqual(
      calls.map((c) => c.orgId),
      ["org-a", "org-b"],
      "each call must be evaluated against exactly the orgId it was given",
    );
  });

  test("works for every canonical feature key, not just voice", async () => {
    for (const { key } of PLATFORM_FEATURES) {
      const locked = await checkFeatureAccess("org-1", key, fakeRpc({ data: true, error: null }));
      assert.equal(locked.allowed, false, `${key} should be rejected when locked`);
      const unlocked = await checkFeatureAccess(
        "org-1",
        key,
        fakeRpc({ data: false, error: null }),
      );
      assert.equal(unlocked.allowed, true, `${key} should be allowed when unlocked`);
    }
  });
});

describe("publishAgentVersion / rollbackAgentVersion — structural integration proof", () => {
  test("publishAgentVersion calls assertFeatureUnlocked for 'voice' before any mutating write", () => {
    const gateCallIdx = agentFunctionsSql.indexOf('assertFeatureUnlocked(organizationId, "voice")');
    assert.ok(
      gateCallIdx > -1,
      "expected publishAgentVersion/rollbackAgentVersion to call assertFeatureUnlocked",
    );

    const publishHandlerIdx = agentFunctionsSql.indexOf("export const publishAgentVersion");
    const publishInsertIdx = agentFunctionsSql.indexOf(
      'supabaseAdmin.from("agent_versions").insert(',
      publishHandlerIdx,
    );
    const publishGateIdx = agentFunctionsSql.indexOf(
      'assertFeatureUnlocked(organizationId, "voice")',
      publishHandlerIdx,
    );
    assert.ok(publishGateIdx > -1 && publishInsertIdx > -1);
    assert.ok(
      publishGateIdx < publishInsertIdx,
      "the feature gate must run before the mutating agent_versions insert",
    );
  });

  test("rollbackAgentVersion also calls assertFeatureUnlocked for 'voice' before any mutating write", () => {
    const rollbackHandlerIdx = agentFunctionsSql.indexOf("export const rollbackAgentVersion");
    assert.ok(rollbackHandlerIdx > -1);
    const rollbackGateIdx = agentFunctionsSql.indexOf(
      'assertFeatureUnlocked(organizationId, "voice")',
      rollbackHandlerIdx,
    );
    // Match the mutating agent_versions.update() call regardless of how
    // prettier wraps the chained .from()/.update() calls across lines.
    const rollbackUpdateMatch =
      /\.from\(\s*"agent_versions"\s*\)\s*\.update\(\s*\{\s*status:\s*"archived"\s*\}\s*\)/.exec(
        agentFunctionsSql.slice(rollbackHandlerIdx),
      );
    assert.ok(rollbackGateIdx > -1, "expected assertFeatureUnlocked call in rollbackAgentVersion");
    assert.ok(
      rollbackUpdateMatch,
      "expected the mutating agent_versions update in rollbackAgentVersion",
    );
    const rollbackUpdateIdx = rollbackHandlerIdx + (rollbackUpdateMatch?.index ?? -1);
    assert.ok(
      rollbackGateIdx < rollbackUpdateIdx,
      "the feature gate must run before rollback's mutating writes",
    );
  });

  test("organizationId used for the gate comes from requireBusinessAccess, never a client-supplied field", () => {
    // Both handlers' input schemas only accept businessId (+ changeNote /
    // version) — never organizationId — so there is no client-controlled
    // field a customer could set to a different tenant's org id to probe or
    // bypass that tenant's gate.
    assert.doesNotMatch(
      agentFunctionsSql,
      /organizationId:\s*z\./,
      "no input schema should accept a client-supplied organizationId",
    );
    assert.match(
      agentFunctionsSql,
      /const \{ organizationId \} = await requireBusinessAccess\(context\.supabase, data\.businessId\);\s*\n(?:[^\n]*\n){0,6}[^\n]*assertFeatureUnlocked\(organizationId, "voice"\)/,
      "assertFeatureUnlocked must be called with the organizationId resolved from requireBusinessAccess, close to that resolution",
    );
  });

  test("previewAgentConfig, testAgentText and synthesizeVoicePreview remain ungated (configuration/setup, not activation)", () => {
    for (const fnName of ["previewAgentConfig", "testAgentText", "synthesizeVoicePreview"]) {
      const start = agentFunctionsSql.indexOf(`export const ${fnName}`);
      assert.ok(start > -1, `expected to find ${fnName}`);
      const nextExportIdx = agentFunctionsSql.indexOf("\nexport const", start + 1);
      const body = agentFunctionsSql.slice(start, nextExportIdx === -1 ? undefined : nextExportIdx);
      assert.doesNotMatch(
        body,
        /assertFeatureUnlocked/,
        `${fnName} is a configuration/preview action and must stay ungated`,
      );
    }
  });
});

describe("platform-admin functions are untouched by this fix", () => {
  const adminFunctionsFiles = [
    "telephony-admin.functions.ts",
    "admin-clients.functions.ts",
    "admin.functions.ts",
    "admin-finance.functions.ts",
    "website-ai-admin.functions.ts",
  ];

  for (const file of adminFunctionsFiles) {
    test(`${file} does not call assertFeatureUnlocked (platform admins are never blocked by a customer's own feature gate)`, () => {
      const filePath = join(dirname(fileURLToPath(import.meta.url)), file);
      const source = readFileSync(filePath, "utf8");
      assert.doesNotMatch(
        source,
        /assertFeatureUnlocked/,
        `${file} is platform-admin-only (assertPlatformAdmin) and must not gain a customer feature gate`,
      );
      assert.match(
        source,
        /assertPlatformAdmin/,
        `${file} should still be gated by assertPlatformAdmin, unchanged`,
      );
    });
  }
});

describe("checkTelephonyAccess refactor preserves behavior", () => {
  test("telephony-guard.server.ts now delegates its 'phone' lock check to checkFeatureAccess instead of duplicating the RPC call", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "telephony-guard.server.ts"),
      "utf8",
    );
    assert.match(source, /checkFeatureAccess\(orgId, "phone"\)/);
    // The RPC call itself must live in exactly one place now (feature-gate.server.ts) —
    // telephony-guard.server.ts must not also call supabaseAdmin.rpc("feature_locked", ...) directly.
    assert.doesNotMatch(source, /\.rpc\(\s*["']feature_locked["']/);
  });
});
