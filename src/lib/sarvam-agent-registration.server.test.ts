import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import { applySarvamAgentMapping } from "./sarvam-agent-registration.server.ts";

function world() {
  return memorySupabase({
    uniques: [
      // idx_agent_configs_sarvam_app_id
      {
        table: "agent_configs",
        key: (r) => (r["sarvam_app_id"] ? String(r["sarvam_app_id"]) : null),
      },
    ],
    tables: {
      agent_configs: [
        { id: "agent_a", organization_id: "org_a", sarvam_app_id: null, sarvam_app_version: null },
        {
          id: "agent_b",
          organization_id: "org_b",
          sarvam_app_id: "B-app-1",
          sarvam_app_version: 2,
        },
      ],
      phone_numbers: [
        { id: "num_a", organization_id: "org_a", agent_config_id: null, status: "provisioning" },
        { id: "num_a_old", organization_id: "org_a", agent_config_id: null, status: "released" },
        { id: "num_b", organization_id: "org_b", agent_config_id: null, status: "provisioning" },
      ],
    },
  });
}
const base = {
  agentConfigId: "agent_a",
  sarvamAppId: "A-app-1",
  sarvamAppVersion: 1,
  masterAgentAppId: "Master-agent",
};

describe("applySarvamAgentMapping", () => {
  test("maps the agent and links only this customer's unlinked, non-released numbers", async () => {
    const db = world();
    const r = await applySarvamAgentMapping(db.client, { ...base, organizationId: "org_a" });
    assert.equal(r.organizationId, "org_a");
    const a = db.tables["agent_configs"]![0]!;
    assert.equal(a["sarvam_app_id"], "A-app-1");
    assert.equal(a["sarvam_application_id"], null);
    const n = (id: string) => db.tables["phone_numbers"]!.find((x) => x["id"] === id)!;
    assert.equal(n("num_a")["agent_config_id"], "agent_a");
    assert.equal(n("num_a_old")["agent_config_id"], null, "released numbers are left alone");
    assert.equal(n("num_b")["agent_config_id"], null, "another customer's number is never linked");
  });

  test("rejects the universal master agent", async () => {
    const db = world();
    await assert.rejects(
      applySarvamAgentMapping(db.client, { ...base, sarvamAppId: "Master-agent" }),
      /universal master agent/,
    );
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], null);
  });

  test("rejects an agent that belongs to another customer", async () => {
    const db = world();
    await assert.rejects(
      applySarvamAgentMapping(db.client, {
        ...base,
        agentConfigId: "agent_b",
        organizationId: "org_a",
      }),
      /does not belong to this customer/,
    );
    assert.equal(db.tables["agent_configs"]![1]!["sarvam_app_id"], "B-app-1");
  });

  test("rejects a Sarvam app already mapped to another agent, with a clear message", async () => {
    const db = world();
    db.failNext("agent_configs", "update", {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    });
    await assert.rejects(
      applySarvamAgentMapping(db.client, { ...base, sarvamAppId: "B-app-1" }),
      /already mapped to a different agent/,
    );
  });

  test("validates the id and version before any write", async () => {
    const db = world();
    await assert.rejects(
      applySarvamAgentMapping(db.client, { ...base, sarvamAppId: "x" }),
      /does not look like/,
    );
    await assert.rejects(
      applySarvamAgentMapping(db.client, { ...base, sarvamAppVersion: 0 }),
      /positive whole number/,
    );
  });
});
