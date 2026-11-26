import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isOutboundReady,
  outboundAgentTarget,
  sarvamCampaignUsesAgent,
  outboundCallVariables,
  outboundOpeningLine,
  OUTBOUND_TEXT_LIMITS,
  sanitizeOutboundText,
  setOutboundReady,
  checkSarvamCampaignStatusChange,
} from "./sarvam-outbound-mode.server.ts";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";

const mapped = (over: Record<string, unknown> = {}) =>
  ({
    sarvam_app_id: "app_1",
    sarvam_outbound_app_id: "app_1-out",
    sarvam_outbound_app_version: 5,
    sarvam_outbound_ready_app_id: "app_1-out",
    sarvam_outbound_ready_version: 5,
    ...over,
  }) as Parameters<typeof isOutboundReady>[0];

describe("outbound readiness (a separate outbound agent per customer)", () => {
  test("ready only when the registered outbound agent's version is the confirmed one", () => {
    assert.equal(isOutboundReady(mapped()), true);
    assert.deepEqual(outboundAgentTarget(mapped()), { appId: "app_1-out", appVersion: 5 });
    assert.equal(
      isOutboundReady(mapped({ sarvam_outbound_app_version: 6 })),
      false,
      "re-registered as v6",
    );
    assert.equal(
      isOutboundReady(mapped({ sarvam_outbound_app_id: "app_2-out" })),
      false,
      "another outbound agent, same version",
    );
    assert.equal(
      isOutboundReady(
        mapped({ sarvam_outbound_ready_app_id: null, sarvam_outbound_ready_version: null }),
      ),
      false,
      "never confirmed",
    );
    assert.equal(
      isOutboundReady(
        mapped({
          sarvam_outbound_app_id: null,
          sarvam_outbound_app_version: null,
          sarvam_outbound_ready_app_id: null,
        }),
      ),
      false,
      "no outbound agent registered",
    );
  });

  test("never falls back to the inbound agent", () => {
    // The old one-agent model: the inbound agent confirmed for outbound, no outbound agent.
    assert.equal(
      outboundAgentTarget(
        mapped({
          sarvam_outbound_app_id: null,
          sarvam_outbound_app_version: null,
          sarvam_outbound_ready_app_id: "app_1",
          sarvam_outbound_ready_version: 5,
        }),
      ),
      null,
    );
    // An outbound registration that is the inbound agent is refused too.
    assert.equal(
      outboundAgentTarget(
        mapped({ sarvam_outbound_app_id: "app_1", sarvam_outbound_ready_app_id: "app_1" }),
      ),
      null,
    );
    // The inbound agent changing version does not matter to outbound.
    assert.equal(isOutboundReady(mapped({ sarvam_app_id: "app_9" })), true);
  });

  test("a Sarvam campaign must run exactly the confirmed outbound agent and version", () => {
    const target = { appId: "app_1-out", appVersion: 5 };
    assert.equal(sarvamCampaignUsesAgent({ app_id: "app_1-out", app_version: 5 }, target), true);
    assert.equal(sarvamCampaignUsesAgent({ app_id: "app_1-out", app_version: "5" }, target), true);
    assert.equal(sarvamCampaignUsesAgent({ app_id: "app_1", app_version: 5 }, target), false);
    assert.equal(sarvamCampaignUsesAgent({ app_id: "app_1-out", app_version: 4 }, target), false);
    assert.equal(sarvamCampaignUsesAgent({}, target), false, "missing fields fail closed");
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
  /** Each registered outbound agent version has its tool credentials confirmed, unless told otherwise. */
  const setup = (agents: Record<string, unknown>[], confirmed = true) =>
    memorySupabase({
      tables: {
        agent_configs: agents,
        provisioning_run_events: agents
          .filter((a) => confirmed && a["sarvam_outbound_app_id"])
          .map((a) => ({
            organization_id: a["organization_id"],
            event: "tool_auth_confirmed",
            detail: {
              role: "outbound",
              appId: a["sarvam_outbound_app_id"],
              version: a["sarvam_outbound_app_version"],
            },
          })),
      },
    });

  const withOutbound = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    organization_id: "org_a",
    sarvam_app_id: "app_1",
    sarvam_app_version: 5,
    sarvam_outbound_app_id: "app_1-out",
    sarvam_outbound_app_version: 3,
    ...over,
  });

  test("a version whose tool credentials are not confirmed cannot be made ready", async () => {
    const db = setup([withOutbound()], false);
    const confirm = () =>
      setOutboundReady(db.client, { organizationId: "org_a", ready: true, maxCallSeconds: 300 });
    const refused = await confirm();
    assert.equal(refused.ok, false);
    assert.match((refused as { reason: string }).reason, /not confirmed for this version/);
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_outbound_ready_app_id"] ?? null, null);
    // An INBOUND confirmation, another version or another customer's does not count.
    for (const [org, detail] of [
      ["org_a", { appId: "app_1-out", version: 3 }],
      ["org_a", { role: "outbound", appId: "app_1-out", version: 2 }],
      ["org_b", { role: "outbound", appId: "app_1-out", version: 3 }],
    ] as const)
      (db.tables["provisioning_run_events"] ??= []).push({
        organization_id: org,
        event: "tool_auth_confirmed",
        detail,
      });
    assert.equal((await confirm()).ok, false);
  });

  test("an agent already confirmed for calling can be re-confirmed (existing customers)", async () => {
    const db = setup(
      [
        withOutbound({
          sarvam_outbound_ready_app_id: "app_1-out",
          sarvam_outbound_ready_version: 3,
        }),
      ],
      false,
    );
    const r = await setOutboundReady(db.client, {
      organizationId: "org_a",
      ready: true,
      maxCallSeconds: 240,
    });
    assert.equal(r.ok, true);
  });

  test("records exactly the registered outbound agent and version; clearing removes both", async () => {
    const db = setup([withOutbound()]);
    const r = await setOutboundReady(db.client, {
      organizationId: "org_a",
      ready: true,
      maxCallSeconds: 300,
    });
    assert.deepEqual(r, {
      ok: true,
      ready: true,
      appId: "app_1-out",
      appVersion: 3,
      maxCallSeconds: 300,
    });
    const agent = db.tables["agent_configs"]![0]!;
    assert.equal(agent["sarvam_outbound_ready_version"], 3);
    assert.equal(agent["sarvam_outbound_ready_app_id"], "app_1-out");
    assert.equal(agent["sarvam_outbound_max_call_seconds"], 300);
    await setOutboundReady(db.client, { organizationId: "org_a", ready: false });
    assert.equal(agent["sarvam_outbound_ready_version"], null);
    assert.equal(agent["sarvam_outbound_ready_app_id"], null);
    assert.equal(agent["sarvam_outbound_max_call_seconds"], null);
  });

  test("confirming needs the agent's maximum call length, 1 minute up to the 300 s hard maximum", async () => {
    for (const maxCallSeconds of [undefined, 59, 301, 900, 3600, 3601, 90.5, Number.NaN]) {
      const db = setup([withOutbound()]);
      const r = await setOutboundReady(db.client, {
        organizationId: "org_a",
        ready: true,
        maxCallSeconds,
      });
      assert.equal(r.ok, false, String(maxCallSeconds));
      assert.match((r as { reason: string }).reason, /maximum call length/);
      assert.equal(db.tables["agent_configs"]![0]!["sarvam_outbound_ready_version"], undefined);
    }
    for (const maxCallSeconds of [60, 300]) {
      const db = setup([withOutbound()]);
      const r = await setOutboundReady(db.client, {
        organizationId: "org_a",
        ready: true,
        maxCallSeconds,
      });
      assert.equal(r.ok, true, String(maxCallSeconds));
    }
  });

  test("refuses without a registered outbound agent: the inbound agent is never confirmed", async () => {
    for (const row of [
      withOutbound({ sarvam_outbound_app_id: null, sarvam_outbound_app_version: null }),
      withOutbound({ sarvam_outbound_app_id: "app_1" }),
    ]) {
      const db = setup([row]);
      const r = await setOutboundReady(db.client, {
        organizationId: "org_a",
        ready: true,
        maxCallSeconds: 300,
      });
      assert.equal(r.ok, false);
      assert.equal(db.tables["agent_configs"]![0]!["sarvam_outbound_ready_app_id"], undefined);
    }
  });

  test("refuses an unmapped agent, and never touches another customer's agent", async () => {
    const db = setup([
      { id: "a1", organization_id: "org_a", sarvam_app_id: null, sarvam_app_version: null },
      withOutbound({ id: "b1", organization_id: "org_b", sarvam_app_id: "app_b" }),
    ]);
    const r = await setOutboundReady(db.client, {
      organizationId: "org_a",
      ready: true,
      maxCallSeconds: 300,
    });
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
        maxCallSeconds: 300,
      });
      assert.equal(r.ok, false);
    }
  });
});

describe("inbound is untouched and outbound code never creates or maps an agent", () => {
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
    // Launch checks live in campaign-launch-readiness.server.ts; launchCampaign runs them all
    // (behaviour, including this refusal: campaign-launch.server.test.ts).
    assert.match(
      read("./campaign-launch-readiness.server.ts"),
      /else if \(!isOutboundReady\(agent\)\)\s*agentProblem\s*=/,
    );
    assert.match(
      read("./campaigns.functions.ts"),
      /launchCampaignFor\(\s*await defaultReadinessDeps\("launch"\)/,
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
    sarvam_outbound_app_id: "app_a-out",
    sarvam_outbound_app_version: 3,
    sarvam_outbound_ready_app_id: "app_a-out",
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

  test("the global kill switch refuses starting or resuming, but never stopping", async () => {
    const prior = process.env["OUTBOUND_CALLING_DISABLED"];
    process.env["OUTBOUND_CALLING_DISABLED"] = "true";
    try {
      const start = await checkSarvamCampaignStatusChange(db(mapped, [readyAgent]), {
        providerCampaignId: "sv_1",
        status: "active",
      });
      assert.equal(start.ok, false);
      assert.match((start as { reason: string }).reason, /paused/);
      const stop = await checkSarvamCampaignStatusChange(db(mapped, [readyAgent]), {
        providerCampaignId: "sv_1",
        status: "paused",
      });
      assert.equal(stop.ok, true);
    } finally {
      if (prior === undefined) delete process.env["OUTBOUND_CALLING_DISABLED"];
      else process.env["OUTBOUND_CALLING_DISABLED"] = prior;
    }
  });

  test("starting or resuming needs a mapped campaign whose agent version is outbound-ready", async () => {
    const ok = await checkSarvamCampaignStatusChange(db(mapped, [readyAgent]), {
      providerCampaignId: "sv_1",
      status: "active",
    });
    assert.deepEqual(ok, { ok: true, organizationId: "org_a" });

    const notReady = await checkSarvamCampaignStatusChange(
      db(mapped, [{ ...readyAgent, sarvam_outbound_app_version: 4 }]),
      { providerCampaignId: "sv_1", status: "resumed" },
    );
    assert.equal(notReady.ok, false);
    assert.match((notReady as { reason: string }).reason, /confirmed for outbound/);
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

  test("sarvam_campaign mode is refused at launch; no cohort is ever uploaded", () => {
    const src = readFileSync(new URL("./campaigns.functions.ts", import.meta.url), "utf8");
    const readiness = readFileSync(
      new URL("./campaign-launch-readiness.server.ts", import.meta.url),
      "utf8",
    );
    assert.match(readiness, /campaign\.dispatch_mode === "sarvam_campaign"/);
    assert.doesNotMatch(src, /uploadCohort\(/);
  });
});
