import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isOutboundReady,
  outboundCallVariables,
  outboundOpeningLine,
  OUTBOUND_TEXT_LIMITS,
  sanitizeOutboundText,
  setOutboundReady,
  checkSarvamCampaignStatusChange,
} from "./sarvam-outbound-mode.server.ts";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";

const mapped = (over: Record<string, unknown> = {}) => ({
  sarvam_app_id: "app_1",
  sarvam_app_version: 5,
  sarvam_outbound_ready_app_id: "app_1",
  sarvam_outbound_ready_version: 5,
  ...over,
});

describe("outbound readiness (one agent per customer)", () => {
  test("ready only when the confirmed outbound version is the agent's current mapping", () => {
    assert.equal(isOutboundReady(mapped()), true);
    assert.equal(isOutboundReady(mapped({ sarvam_app_version: 6 })), false, "remapped to v6");
    assert.equal(
      isOutboundReady(mapped({ sarvam_app_id: "app_2" })),
      false,
      "another agent, same version",
    );
    assert.equal(
      isOutboundReady(
        mapped({ sarvam_outbound_ready_app_id: null, sarvam_outbound_ready_version: null }),
      ),
      false,
      "never confirmed",
    );
    assert.equal(
      isOutboundReady(mapped({ sarvam_app_id: null, sarvam_outbound_ready_app_id: null })),
      false,
      "unmapped agent",
    );
  });
});

describe("outbound call variables", () => {
  test("always mark the call outbound and carry ClickAI's own call id", () => {
    assert.deepEqual(outboundCallVariables({ callId: "call_1" }), {
      call_direction: "outbound",
      clickai_call_id: "call_1",
    });
  });

  test("objective and instructions are cleaned and capped before they reach the agent", () => {
    const vars = outboundCallVariables({
      callId: "call_1",
      objective: "  Confirm\n\ttomorrow's\u0000 appointment  ",
      instructions: "x".repeat(OUTBOUND_TEXT_LIMITS.instructions + 50),
    });
    assert.equal(vars["campaign_objective"], "Confirm tomorrow's appointment");
    assert.equal(vars["campaign_instructions"]!.length, OUTBOUND_TEXT_LIMITS.instructions);
    assert.equal(sanitizeOutboundText("   ", 10), undefined);
    assert.equal(sanitizeOutboundText(42, 10), undefined);
    assert.ok(!("campaign_objective" in outboundCallVariables({ callId: "c", objective: "  " })));
  });

  test("the opening line names the business and asks for the moment, nothing more", () => {
    assert.equal(
      outboundOpeningLine("Smile Bright\nDental"),
      "Hello, this is the virtual assistant calling from Smile Bright Dental. Is this a good time to talk?",
    );
    assert.equal(
      outboundOpeningLine(null),
      "Hello, this is a virtual assistant calling. Is this a good time to talk?",
    );
  });
});

describe("marking a version outbound-ready", () => {
  const setup = (agents: Record<string, unknown>[]) =>
    memorySupabase({ tables: { agent_configs: agents } });

  test("records exactly the current app id and version; clearing removes both", async () => {
    const db = setup([
      { id: "a1", organization_id: "org_a", sarvam_app_id: "app_1", sarvam_app_version: 5 },
    ]);
    const r = await setOutboundReady(db.client, { organizationId: "org_a", ready: true });
    assert.deepEqual(r, { ok: true, ready: true, appId: "app_1", appVersion: 5 });
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_outbound_ready_version"], 5);
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_outbound_ready_app_id"], "app_1");
    await setOutboundReady(db.client, { organizationId: "org_a", ready: false });
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_outbound_ready_version"], null);
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_outbound_ready_app_id"], null);
  });

  test("refuses an unmapped agent, and never touches another customer's agent", async () => {
    const db = setup([
      { id: "a1", organization_id: "org_a", sarvam_app_id: null, sarvam_app_version: null },
      { id: "b1", organization_id: "org_b", sarvam_app_id: "app_b", sarvam_app_version: 2 },
    ]);
    const r = await setOutboundReady(db.client, { organizationId: "org_a", ready: true });
    assert.equal(r.ok, false);
    assert.equal(db.tables["agent_configs"]![1]!["sarvam_outbound_ready_version"], undefined);
  });

  test("a customer with no agent, or more than one, is refused", async () => {
    for (const agents of [
      [],
      [
        { id: "a1", organization_id: "org_a", sarvam_app_id: "x", sarvam_app_version: 1 },
        { id: "a2", organization_id: "org_a", sarvam_app_id: "y", sarvam_app_version: 1 },
      ],
    ]) {
      const r = await setOutboundReady(setup(agents).client, {
        organizationId: "org_a",
        ready: true,
      });
      assert.equal(r.ok, false);
    }
  });
});

describe("inbound is untouched and no second agent is created", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  test("the inbound deployment request never carries outbound variables or an opening-line override", () => {
    const deployment =
      read("./sarvam-inbound-deployment.server.ts") +
      read("./telephony/sarvam-api-client.server.ts").split("function toInstantOutboundBody")[0];
    assert.doesNotMatch(
      deployment,
      /call_direction|clickai_call_id|initial_bot_message|outboundCallVariables/,
    );
  });

  test("outbound code never creates or registers another agent", () => {
    for (const p of [
      "./sarvam-outbound-mode.server.ts",
      "./sarvam-outbound-call.server.ts",
      "./campaign-dispatch.server.ts",
    ]) {
      const src = read(p);
      assert.doesNotMatch(src, /from\("agent_configs"\)\s*\.insert\(/, p);
      assert.doesNotMatch(src, /applySarvamAgentMapping|registerCustomerSarvamAgent/, p);
    }
  });
});

describe("launch and admin wiring", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  test("a campaign cannot launch on an agent version not confirmed for outbound", () => {
    const src = read("./campaigns.functions.ts");
    const launch = src.slice(
      src.indexOf("export const launchCampaign"),
      src.indexOf("function simpleTransition"),
    );
    assert.match(
      launch,
      /if \(!isOutboundReady\(agentConfig\)\) throw new Error\(OUTBOUND_NOT_READY_MESSAGE\)/,
    );
  });

  test("confirming a version is platform-admin only (agents.write) and always audited", () => {
    const src = read("./provisioning-admin.functions.ts");
    const fn = src.slice(src.indexOf("export const setSarvamOutboundReady"));
    const body = fn.slice(0, fn.indexOf("\n  });") + 5);
    assert.match(
      body,
      /assertPlatformAdmin\(context\.supabase, context\.userId, "agents\.write"\)/,
    );
    assert.match(
      body,
      /if \(!input\.reason\?\.trim\(\)\) throw new Error\("A reason is required"\)/,
    );
    assert.match(body, /SARVAM_OUTBOUND_READY_SET/);
    assert.match(body, /await writeAudit\(admin,/);
  });
});

describe("admin Sarvam campaign status changes", () => {
  const db = (campaigns: Record<string, unknown>[], agents: Record<string, unknown>[]) =>
    memorySupabase({ tables: { campaigns, agent_configs: agents } }).client;
  const readyAgent = {
    id: "agent_a",
    organization_id: "org_a",
    sarvam_app_id: "app_a",
    sarvam_app_version: 3,
    sarvam_outbound_ready_app_id: "app_a",
    sarvam_outbound_ready_version: 3,
  };
  const mapped = [
    {
      id: "c1",
      organization_id: "org_a",
      agent_config_id: "agent_a",
      provider_campaign_id: "sv_1",
    },
  ];

  test("stopping and name-only changes always pass, even for an unknown campaign", async () => {
    for (const status of [undefined, "", "paused", "Cancelled", "stopped"]) {
      const r = await checkSarvamCampaignStatusChange(db([], []), {
        providerCampaignId: "sv_x",
        status,
      });
      assert.equal(r.ok, true, String(status));
    }
  });

  test("starting or resuming needs a mapped campaign whose agent version is outbound-ready", async () => {
    const ok = await checkSarvamCampaignStatusChange(db(mapped, [readyAgent]), {
      providerCampaignId: "sv_1",
      status: "active",
    });
    assert.deepEqual(ok, { ok: true, organizationId: "org_a" });

    const notReady = await checkSarvamCampaignStatusChange(
      db(mapped, [{ ...readyAgent, sarvam_app_version: 4 }]),
      { providerCampaignId: "sv_1", status: "resumed" },
    );
    assert.equal(notReady.ok, false);
    assert.match((notReady as { reason: string }).reason, /not been confirmed for outbound/);
  });

  test("fails closed: unknown, ambiguous or cross-tenant mappings are refused", async () => {
    const unknown = await checkSarvamCampaignStatusChange(db([], [readyAgent]), {
      providerCampaignId: "sv_1",
      status: "active",
    });
    assert.equal(unknown.ok, false);
    const twice = await checkSarvamCampaignStatusChange(
      db([...mapped, { ...mapped[0]!, id: "c2" }], [readyAgent]),
      { providerCampaignId: "sv_1", status: "active" },
    );
    assert.equal(twice.ok, false);
    const otherOrg = await checkSarvamCampaignStatusChange(
      db(mapped, [{ ...readyAgent, organization_id: "org_b" }]),
      { providerCampaignId: "sv_1", status: "active" },
    );
    assert.equal(otherOrg.ok, false);
  });

  test("the admin action checks before calling Sarvam, needs numbers.write and audits every outcome", () => {
    const src = readFileSync(new URL("./sarvam-admin.functions.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export const updateSarvamCampaign"));
    const body = fn.slice(0, fn.indexOf("\n  });") + 5);
    assert.match(
      body,
      /assertPlatformAdmin\(context\.supabase, context\.userId, "numbers\.write"\)/,
    );
    const check = body.indexOf("checkSarvamCampaignStatusChange(");
    const call = body.indexOf("adapter.updateCampaign(");
    assert.ok(check > -1 && call > check, "readiness is checked before any Sarvam request");
    for (const outcome of [
      "refused_not_outbound_ready",
      "refused_sarvam_not_connected",
      '"error"',
      '"updated"',
    ])
      assert.ok(body.includes(outcome), outcome);
    assert.match(body, /SARVAM_CAMPAIGN_UPDATE_REFUSED/);
  });

  test("sarvam_campaign mode stays off by default and its cohort rows always come from buildOutboundCohortRows", () => {
    const src = readFileSync(new URL("./campaigns.functions.ts", import.meta.url), "utf8");
    assert.match(src, /process\.env\["KLYRO_DISPATCH_MODE"\] === "sarvam_campaign"/);
    const launch = src.slice(src.indexOf("async function launchViaSarvamCampaign"));
    assert.match(launch, /buildOutboundCohortRows\(/);
    assert.ok(launch.indexOf("buildOutboundCohortRows(") < launch.indexOf("buildCohortPayload("));
  });
});
