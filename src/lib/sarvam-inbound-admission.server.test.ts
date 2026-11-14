import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import {
  blockAdmissionOnUnknownDeployment,
  checkInboundAdmission,
  checkLegacyContextAdmission,
} from "./sarvam-inbound-admission.server.ts";

/**
 * Admission gate (Phase 5): ClickAI serves business context and runs tools
 * only for a customer whose Sarvam number is ACTIVE with a verified
 * deployment mapping that matches the live agent mapping. Everything else
 * fails closed. (It cannot stop Sarvam answering the phone; that is the
 * pause in the pipeline. These tests cover the data side.)
 */

const A = "org_a";
const B = "org_b";

const admitted = (over: Record<string, unknown> = {}) => ({
  id: "num_a",
  e164: "+917900000001",
  status: "active",
  provider: "sarvam",
  organization_id: A,
  agent_config_id: "agent_a",
  inbound_enabled: true,
  provider_deployment_id: "dep-a",
  verified_deployment_id: "dep-a",
  verified_sarvam_app_id: "App-a",
  verified_sarvam_app_version: 3,
  admission_blocked_at: null,
  ...over,
});

function world(numbers: Record<string, unknown>[] = [admitted()]) {
  return memorySupabase({
    tables: {
      organizations: [
        { id: A, lifecycle_status: "active" },
        { id: B, lifecycle_status: "active" },
      ],
      agent_configs: [
        { id: "agent_a", organization_id: A, sarvam_app_id: "App-a", sarvam_app_version: 3 },
        { id: "agent_b", organization_id: B, sarvam_app_id: "App-b", sarvam_app_version: 1 },
      ],
      phone_numbers: numbers,
    },
  });
}

/** A client whose reads of one table fail (database outage). */
function failingReads(client: unknown, table: string) {
  const c = client as { from: (t: string) => unknown };
  return {
    from: (t: string) => {
      if (t !== table) return c.from(t);
      const err = { data: null, error: { message: "connection reset" } };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit"]) b[m] = () => b;
      b["maybeSingle"] = async () => err;
      b["single"] = async () => err;
      b["then"] = (res: (v: unknown) => void) => res(err);
      return b;
    },
  };
}

/** A client that throws outright (network failure inside the driver). */
function throwingReads(client: unknown, table: string) {
  const c = client as { from: (t: string) => unknown };
  return {
    from: (t: string) => {
      if (t === table) throw new Error("socket hang up");
      return c.from(t);
    },
  };
}

const check = (db: { client: unknown }, over: Record<string, unknown> = {}) =>
  checkInboundAdmission(db.client as never, {
    organizationId: A,
    agentConfigId: "agent_a",
    ...over,
  });

describe("admits only an ACTIVE, verified, matching number", () => {
  test("fully verified active number is admitted", async () => {
    const r = await check(world());
    assert.equal(r.admitted, true);
  });

  const denials: [string, Record<string, unknown>, string][] = [
    ["provisioning number", { status: "provisioning" }, "number_not_active"],
    ["failed / suspended number", { status: "suspended" }, "number_not_active"],
    ["inbound switched off", { inbound_enabled: false }, "inbound_disabled"],
    ["missing deployment", { provider_deployment_id: null }, "no_deployment"],
    [
      "never verified",
      {
        verified_deployment_id: null,
        verified_sarvam_app_id: null,
        verified_sarvam_app_version: null,
      },
      "not_verified",
    ],
    [
      "verified a different deployment",
      { verified_deployment_id: "dep-old" },
      "deployment_mismatch",
    ],
    ["verified a different agent", { verified_sarvam_app_id: "App-old" }, "agent_mismatch"],
    ["verified an older version", { verified_sarvam_app_version: 2 }, "version_mismatch"],
    [
      "blocked after an unverified-deployment call",
      { admission_blocked_at: "2026-11-14T10:00:00Z" },
      "blocked",
    ],
  ];
  for (const [name, over, reason] of denials)
    test(`denied: ${name}`, async () => {
      const r = await check(world([admitted(over)]));
      assert.deepEqual(r, { admitted: false, reason });
    });

  test("denied: agent and deployment mismatched together (re-pointed agent on an old deployment)", async () => {
    const r = await check(
      world([admitted({ verified_deployment_id: "dep-x", verified_sarvam_app_id: "App-x" })]),
    );
    assert.equal(r.admitted, false);
  });

  test("denied: no number at all, or only a released one", async () => {
    assert.deepEqual(await check(world([])), { admitted: false, reason: "no_number" });
    assert.deepEqual(await check(world([admitted({ status: "released" })])), {
      admitted: false,
      reason: "no_number",
    });
  });

  test("denied: number reassigned to another customer (row now belongs to B)", async () => {
    const r = await check(world([admitted({ organization_id: B, agent_config_id: "agent_b" })]));
    assert.deepEqual(r, { admitted: false, reason: "no_number" });
  });

  test("denied: suspended / cancelled / archived organization", async () => {
    for (const lifecycle of ["suspended", "cancelled", "archived"]) {
      const db = world();
      db.tables["organizations"]![0]!["lifecycle_status"] = lifecycle;
      assert.deepEqual(await check(db), { admitted: false, reason: "organization_inactive" });
    }
  });

  test("denied: agent not mapped to Sarvam, or belonging to another organization", async () => {
    const db = world();
    db.tables["agent_configs"]![0]!["sarvam_app_id"] = null;
    assert.deepEqual(await check(db), { admitted: false, reason: "agent_not_mapped" });
    assert.deepEqual(await check(world(), { agentConfigId: "agent_b" }), {
      admitted: false,
      reason: "agent_not_found",
    });
  });
});

describe("cross-customer and multiple numbers", () => {
  test("denied: the same deployment is also recorded on another customer's live number", async () => {
    const r = await check(
      world([
        admitted(),
        admitted({
          id: "num_b",
          e164: "+917900000002",
          organization_id: B,
          agent_config_id: "agent_b",
        }),
      ]),
    );
    assert.deepEqual(r, { admitted: false, reason: "deployment_shared" });
  });

  test("a released row elsewhere that still names the deployment does not block", async () => {
    const r = await check(
      world([
        admitted(),
        admitted({
          id: "num_b",
          organization_id: B,
          agent_config_id: "agent_b",
          status: "released",
        }),
      ]),
    );
    assert.equal(r.admitted, true);
  });

  test("multiple numbers: a verified number never carries an unverified one (tool calls cannot say which was dialled)", async () => {
    const second = admitted({
      id: "num_a2",
      e164: "+917900000003",
      provider_deployment_id: "dep-a2",
    });
    // Even two fully verified numbers are refused: one customer = one number.
    const both = await check(world([admitted(), { ...second, verified_deployment_id: "dep-a2" }]));
    assert.deepEqual(both, { admitted: false, reason: "multiple_numbers" });
    for (const unverified of [
      { status: "provisioning" },
      {
        verified_deployment_id: null,
        verified_sarvam_app_id: null,
        verified_sarvam_app_version: null,
      },
      { provider_deployment_id: null },
    ]) {
      const r = await check(world([admitted(), { ...second, ...unverified }]));
      assert.deepEqual(
        r,
        { admitted: false, reason: "multiple_numbers" },
        JSON.stringify(unverified),
      );
    }
  });

  test("multiple numbers: a second number NOT linked to the agent still blocks (it could be routed to it by hand)", async () => {
    const r = await check(
      world([
        admitted(),
        {
          id: "num_a3",
          e164: "+917900000004",
          status: "provisioning",
          provider: "sarvam",
          organization_id: A,
          agent_config_id: null,
        },
      ]),
    );
    assert.deepEqual(r, { admitted: false, reason: "multiple_numbers" });
  });

  test("the customer's only number linked to a different agent is refused", async () => {
    const r = await check(world([admitted({ agent_config_id: "agent_old" })]));
    assert.deepEqual(r, { admitted: false, reason: "number_not_linked" });
  });

  test("a released extra number does not count", async () => {
    const r = await check(
      world([admitted(), admitted({ id: "num_old", e164: "+917900000009", status: "released" })]),
    );
    assert.equal(r.admitted, true);
  });

  test("request identifiers cannot pick the verified number out of several", async () => {
    const second = admitted({
      id: "num_a2",
      e164: "+917900000003",
      provider_deployment_id: "dep-a2",
      status: "provisioning",
    });
    for (const ids of [{ deploymentId: "dep-a" }, { phoneNumber: "+917900000001" }]) {
      const r = await check(world([admitted(), second]), ids);
      assert.deepEqual(r, { admitted: false, reason: "multiple_numbers" });
    }
  });

  test("another row in the SAME customer that names this deployment also blocks (deployment_shared)", async () => {
    const db = world([admitted()]);
    db.tables["phone_numbers"]!.push({
      id: "num_ghost",
      e164: "+917900000008",
      status: "active",
      provider: "vobiz",
      organization_id: A,
      provider_deployment_id: "dep-a",
    });
    assert.deepEqual(await check(db), { admitted: false, reason: "deployment_shared" });
  });

  test("another customer's credential context never admits this customer's number", async () => {
    const r = await checkInboundAdmission(world().client as never, {
      organizationId: B,
      agentConfigId: "agent_b",
    });
    assert.deepEqual(r, { admitted: false, reason: "no_number" });
  });
});

describe("request-supplied identifiers only narrow, never widen", () => {
  test("a matching deployment id or number is fine; anything else is refused", async () => {
    assert.equal((await check(world(), { deploymentId: "dep-a" })).admitted, true);
    assert.equal((await check(world(), { phoneNumber: "+91 79000 00001" })).admitted, true);
    assert.deepEqual(await check(world(), { deploymentId: "dep-b" }), {
      admitted: false,
      reason: "identifier_mismatch",
    });
    assert.deepEqual(await check(world(), { phoneNumber: "+917900000999" }), {
      admitted: false,
      reason: "identifier_mismatch",
    });
  });

  test("an identifier cannot rescue an unverified number", async () => {
    const r = await check(world([admitted({ status: "provisioning" })]), { deploymentId: "dep-a" });
    assert.equal(r.admitted, false);
  });

  test("legacy route: identifiers must match the resolved organization's verified number", async () => {
    const db = world();
    assert.equal(
      (await checkLegacyContextAdmission(db.client as never, A, { deploymentId: "dep-a" }))
        .admitted,
      true,
    );
    assert.deepEqual(
      await checkLegacyContextAdmission(db.client as never, A, { deploymentId: "dep-other" }),
      { admitted: false, reason: "identifier_mismatch" },
    );
    assert.deepEqual(await checkLegacyContextAdmission(db.client as never, A, {}), {
      admitted: false,
      reason: "identifier_mismatch",
    });
    assert.deepEqual(
      await checkLegacyContextAdmission(db.client as never, B, { deploymentId: "dep-a" }),
      { admitted: false, reason: "no_number" },
    );
  });
});

describe("database failures fail closed", () => {
  for (const table of ["agent_configs", "organizations", "phone_numbers"])
    test(`${table} read error -> denied`, async () => {
      const db = world();
      const r = await checkInboundAdmission(failingReads(db.client, table) as never, {
        organizationId: A,
        agentConfigId: "agent_a",
      });
      assert.equal(r.admitted, false);
    });

  test("a thrown driver error -> denied (lookup_failed)", async () => {
    const db = world();
    const r = await checkInboundAdmission(throwingReads(db.client, "phone_numbers") as never, {
      organizationId: A,
      agentConfigId: "agent_a",
    });
    assert.deepEqual(r, { admitted: false, reason: "lookup_failed" });
    const legacy = await checkLegacyContextAdmission(
      throwingReads(db.client, "agent_configs") as never,
      A,
      { deploymentId: "dep-a" },
    );
    assert.deepEqual(legacy, { admitted: false, reason: "lookup_failed" });
  });
});

describe("call results from an unverified deployment block admission", () => {
  const now = new Date("2026-11-14T10:00:00Z");
  test("a known deployment (verified, or created moments ago) never blocks", async () => {
    const db = world([
      admitted({
        verified_deployment_id: null,
        verified_sarvam_app_id: null,
        verified_sarvam_app_version: null,
      }),
    ]);
    const r = await blockAdmissionOnUnknownDeployment(db.client as never, {
      appId: "App-a",
      deploymentId: "dep-a",
      now,
    });
    assert.equal(r.blocked, false);
  });

  test("an unknown deployment for this customer's agent blocks every one of its numbers", async () => {
    const db = world();
    const r = await blockAdmissionOnUnknownDeployment(db.client as never, {
      appId: "App-a",
      deploymentId: "dep-rogue",
      now,
    });
    assert.equal(r.blocked, true);
    assert.equal(db.tables["phone_numbers"]![0]!["admission_blocked_at"], now.toISOString());
    assert.match(String(db.tables["phone_numbers"]![0]!["admission_blocked_reason"]), /dep-rogue/);
    assert.deepEqual(await check(db), { admitted: false, reason: "blocked" });
  });

  test("an app id that is not a ClickAI customer agent changes nothing", async () => {
    const db = world();
    const r = await blockAdmissionOnUnknownDeployment(db.client as never, {
      appId: "Unknown-app",
      deploymentId: "dep-rogue",
      now,
    });
    assert.deepEqual(r, { blocked: false, agentConfigId: null });
    assert.equal(db.tables["phone_numbers"]![0]!["admission_blocked_at"], null);
  });

  test("another customer's numbers are never blocked by this customer's call", async () => {
    const db = world([
      admitted(),
      admitted({
        id: "num_b",
        organization_id: B,
        agent_config_id: "agent_b",
        provider_deployment_id: "dep-b",
        verified_deployment_id: "dep-b",
        verified_sarvam_app_id: "App-b",
        verified_sarvam_app_version: 1,
      }),
    ]);
    await blockAdmissionOnUnknownDeployment(db.client as never, {
      appId: "App-a",
      deploymentId: "dep-rogue",
      now,
    });
    assert.equal(db.tables["phone_numbers"]![1]!["admission_blocked_at"], null);
  });
});
