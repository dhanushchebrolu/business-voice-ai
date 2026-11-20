import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import {
  OUTBOUND_AGENT_TOOLS,
  OUTBOUND_FORBIDDEN_TOOLS,
  isAgentRole,
  roleAllowsAgentApi,
} from "./agent-roles.ts";
import {
  applySarvamAgentMapping,
  applySarvamOutboundAgentMapping,
} from "./sarvam-agent-registration.server.ts";
import {
  outboundChecklist,
  outboundRegistrationGate,
  type OutboundChecklistInput,
} from "./provisioning-view.ts";
import { buildOutboundAgentConfig, buildUniversalAgentConfig } from "./universal-agent-config.ts";
import { customerSetupSteps } from "./provisioning-status.ts";
import { AGENT_TOOLS } from "./sarvam-agent-api.server.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";

/**
 * Dual-agent provisioning (docs/dual-agent-provisioning-audit.md): every
 * customer has an inbound agent and a separate, restricted outbound agent.
 * The database enforces the same registration rules in
 * supabase/migrations/dual_agent_provisioning.pg.test.ts.
 */

describe("agent roles", () => {
  test("the outbound credential reaches only reads and the call outcome", () => {
    assert.equal(roleAllowsAgentApi("outbound", undefined), true, "on-start context");
    for (const t of ["get_business_info", "check_availability", "record_call_outcome"])
      assert.equal(roleAllowsAgentApi("outbound", t), true, t);
    for (const t of ["book_appointment", "request_callback", "send_reminder", "call_transfer", "x"])
      assert.equal(roleAllowsAgentApi("outbound", t), false, t);
    for (const t of [undefined, ...AGENT_TOOLS])
      assert.equal(roleAllowsAgentApi("inbound", t), true, String(t));
  });

  test("every ClickAI write endpoint is forbidden for outbound; the template and the gate agree", () => {
    const writes = AGENT_TOOLS.filter((t) => !roleAllowsAgentApi("outbound", t));
    assert.deepEqual([...writes].sort(), ["book_appointment", "request_callback"]);
    for (const t of OUTBOUND_FORBIDDEN_TOOLS)
      assert.ok(!(OUTBOUND_AGENT_TOOLS as readonly string[]).includes(t), t);
    for (const t of OUTBOUND_AGENT_TOOLS)
      if (t !== "clickai_business_context")
        assert.equal(roleAllowsAgentApi("outbound", t), true, t);
  });

  test("only inbound and outbound are roles", () => {
    assert.equal(isAgentRole("inbound"), true);
    assert.equal(isAgentRole("outbound"), true);
    for (const v of ["admin", "", null, undefined, "OUTBOUND"]) assert.equal(isAgentRole(v), false);
  });
});

function snapshot(caps: Record<string, boolean>, name = "Smile Dental"): AgentSnapshot {
  return {
    business: {
      name,
      business_type: "dental_clinic",
      description: "Clinic.",
      country: "IN",
      timezone: "Asia/Kolkata",
      currency: "INR",
    },
    hours: [{ day_of_week: 1, is_closed: false, intervals: [{ start: "09:00", end: "18:00" }] }],
    services: [{ name: "Cleaning", currency: "INR", is_active: true }],
    faqs: [],
    rules: [],
    knowledge: [],
    agent: {
      agent_name: "Aria",
      persona: "friendly",
      objectives: [],
      capabilities: caps,
      primary_language: "en-IN",
      extra_languages: [],
      multilingual: true,
      voice_id: "ritu",
      speaking_pace: 1,
      greetings: {},
      transfer_number: "+919800000000",
      after_hours_behavior: "take_message",
    },
  } as AgentSnapshot;
}
const VOICE = {
  default_language: "English",
  allowed_languages: ["English", "Hindi"],
  auto_language_switch: true,
  sarvam_voice_internal_id: "01a0cf17-12bd-7de3-9df0-f607db604d52",
};

describe("central templates", () => {
  const everything = {
    calendar_book: true,
    capture_lead: true,
    take_message: true,
    transfer_to_human: true,
  };

  test("the outbound template never gets a write tool, whatever the customer enables", () => {
    for (const caps of [{}, everything]) {
      const c = buildOutboundAgentConfig(snapshot(caps), VOICE);
      assert.deepEqual(c.tools.enable, [...OUTBOUND_AGENT_TOOLS]);
      for (const t of OUTBOUND_FORBIDDEN_TOOLS)
        assert.ok(!(c.tools.enable as string[]).includes(t), t);
      assert.equal(c.role, "outbound");
    }
    // The inbound agent still gets the customer's booking and callback tools.
    const inbound = buildUniversalAgentConfig(snapshot(everything), VOICE);
    for (const t of ["book_appointment", "request_callback", "call_transfer"] as const)
      assert.ok(inbound.tools.enable.includes(t), t);
  });

  test("voice, languages and business data blockers are injected into the outbound template", () => {
    const c = buildOutboundAgentConfig(snapshot({}), VOICE);
    assert.equal(c.voiceLanguage?.defaultLanguage, "English");
    assert.deepEqual(c.voiceLanguage?.allowedLanguages, ["English", "Hindi"]);
    assert.equal(c.voiceLanguageProblem, null);
    assert.equal(buildOutboundAgentConfig(snapshot({}), null).voiceLanguage, null);
    assert.match(
      buildOutboundAgentConfig(snapshot({}), null).voiceLanguageProblem ?? "",
      /not set/,
    );
    assert.deepEqual(buildOutboundAgentConfig(snapshot({}, " "), VOICE).blockers, [
      "Business name is missing.",
    ]);
  });

  test("fingerprints: stable, role-specific, and the inbound one is unchanged by dual agents", () => {
    const a = buildOutboundAgentConfig(snapshot({}), VOICE);
    assert.equal(a.fingerprint, buildOutboundAgentConfig(snapshot({}), VOICE).fingerprint);
    assert.match(a.fingerprint, /^o1-[0-9a-f]{8}$/);
    assert.match(buildUniversalAgentConfig(snapshot({}), VOICE).fingerprint, /^u1-[0-9a-f]{8}$/);
  });
});

function registry() {
  return memorySupabase({
    tables: {
      agent_configs: [
        {
          id: "agent_a",
          organization_id: "org_a",
          sarvam_app_id: "A-in-1",
          sarvam_app_version: 2,
          sarvam_outbound_app_id: null,
          sarvam_outbound_app_version: null,
          sarvam_outbound_ready_app_id: null,
          sarvam_outbound_ready_version: null,
        },
        {
          id: "agent_b",
          organization_id: "org_b",
          sarvam_app_id: "B-in-1",
          sarvam_app_version: 1,
          sarvam_outbound_app_id: "B-out-1",
          sarvam_outbound_app_version: 1,
        },
      ],
      sarvam_applications: [{ id: "shared_1", sarvam_app_id: "Shared-1" }],
      phone_numbers: [],
    },
  });
}
const reg = (over: Record<string, unknown> = {}) => ({
  agentConfigId: "agent_a",
  organizationId: "org_a",
  sarvamAppId: "A-out-1",
  sarvamAppVersion: 1,
  masterAgentAppIds: ["Master-in", "Master-out"],
  registeredBy: "admin_1",
  now: new Date("2026-11-20T10:00:00Z"),
  ...over,
});

describe("registering the outbound agent", () => {
  test("registers the customer's own outbound agent and records who and when", async () => {
    const db = registry();
    const r = await applySarvamOutboundAgentMapping(db.client, reg());
    assert.deepEqual(r.before, { sarvam_outbound_app_id: null, sarvam_outbound_app_version: null });
    const a = db.tables["agent_configs"]![0]!;
    assert.equal(a["sarvam_outbound_app_id"], "A-out-1");
    assert.equal(a["sarvam_outbound_app_version"], 1);
    assert.equal(a["sarvam_outbound_registered_by"], "admin_1");
    assert.equal(a["sarvam_app_id"], "A-in-1", "the inbound agent is untouched");
  });

  test("wrong agent ids are refused and nothing is written", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ sarvamAppId: "A-in-1" }, /inbound agent/],
      [{ sarvamAppId: "B-in-1" }, /already answers inbound calls/],
      [{ sarvamAppId: "Shared-1" }, /already answers inbound calls/],
      [{ sarvamAppId: "B-out-1" }, /another customer's outbound agent/],
      [{ sarvamAppId: "Master-out" }, /master template/],
      [{ sarvamAppId: "Master-in" }, /master template/],
      [{ sarvamAppId: "bad id!" }, /does not look like a Sarvam agent id/],
      [{ sarvamAppVersion: 0 }, /positive whole number/],
      [{ organizationId: "org_b" }, /does not belong to this customer/],
    ];
    for (const [over, err] of cases) {
      const db = registry();
      await assert.rejects(applySarvamOutboundAgentMapping(db.client, reg(over)), err);
      assert.equal(db.tables["agent_configs"]![0]!["sarvam_outbound_app_id"], null, String(err));
    }
  });

  test("re-registering the same agent and version is a no-op (safe retry)", async () => {
    const db = registry();
    await applySarvamOutboundAgentMapping(db.client, reg());
    const at = db.tables["agent_configs"]![0]!["sarvam_outbound_registered_at"];
    const r = await applySarvamOutboundAgentMapping(
      db.client,
      reg({ now: new Date("2026-11-21T10:00:00Z") }),
    );
    assert.equal(r.outboundConfirmationCleared, false);
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_outbound_registered_at"], at);
  });

  test("a new outbound version needs outbound calling to be confirmed again", async () => {
    const db = registry();
    Object.assign(db.tables["agent_configs"]![0]!, {
      sarvam_outbound_app_id: "A-out-1",
      sarvam_outbound_app_version: 1,
      sarvam_outbound_ready_app_id: "A-out-1",
      sarvam_outbound_ready_version: 1,
    });
    const r = await applySarvamOutboundAgentMapping(db.client, reg({ sarvamAppVersion: 2 }));
    assert.equal(r.outboundConfirmationCleared, true);
  });

  test("an outbound agent can never be mapped as anyone's inbound agent", async () => {
    const db = registry();
    await assert.rejects(
      applySarvamAgentMapping(db.client, {
        agentConfigId: "agent_a",
        organizationId: "org_a",
        sarvamAppId: "B-out-1",
        sarvamAppVersion: 1,
        masterAgentAppId: null,
      }),
      /registered as an outbound agent/,
    );
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], "A-in-1");
  });
});

const gateInput = (over: Partial<OutboundChecklistInput> = {}): OutboundChecklistInput => ({
  inboundAppId: "A-in-1",
  credential: { status: "active", expiresAt: null },
  appId: null,
  appVersion: null,
  readyAppId: null,
  readyVersion: null,
  masterAgentAppIds: ["Master-in", "Master-out"],
  blockers: [],
  voiceLanguageProblem: null,
  now: new Date("2026-11-20T10:00:00Z"),
  ...over,
});

describe("admin outbound checklist and registration gate", () => {
  const status = (i: OutboundChecklistInput) => outboundChecklist(i).map((c) => c.status);

  test("steps 11-13 move from todo to done; confirmation is a separate, later step", () => {
    assert.deepEqual(status(gateInput({ credential: null })), ["todo", "todo", "todo"]);
    assert.deepEqual(status(gateInput()), ["done", "todo", "todo"]);
    assert.deepEqual(status(gateInput({ appId: "A-out-1", appVersion: 1 })), [
      "done",
      "done",
      "todo",
    ]);
    assert.deepEqual(
      status(
        gateInput({ appId: "A-out-1", appVersion: 1, readyAppId: "A-out-1", readyVersion: 1 }),
      ),
      ["done", "done", "done"],
    );
    assert.deepEqual(
      outboundChecklist(gateInput()).map((c) => c.step),
      [11, 12, 13],
    );
  });

  test("failure states: inbound agent or master registered as outbound, expired credential", () => {
    assert.equal(status(gateInput({ appId: "A-in-1", appVersion: 2 }))[1], "failed");
    assert.equal(status(gateInput({ appId: "Master-out", appVersion: 1 }))[1], "failed");
    assert.equal(
      status(gateInput({ credential: { status: "active", expiresAt: "2026-11-01T00:00:00Z" } }))[0],
      "todo",
    );
    assert.match(
      outboundChecklist(gateInput({ appId: "A-in-1", appVersion: 2 }))[1]!.detail,
      /inbound agent or a master template/,
    );
  });

  test("the gate names every reason registration is refused", () => {
    assert.equal(outboundRegistrationGate(gateInput(), "A-out-1").allowed, true);
    const g = outboundRegistrationGate(
      gateInput({
        credential: null,
        blockers: ["Business name is missing."],
        voiceLanguageProblem: "not set",
      }),
      "A-in-1",
    );
    assert.equal(g.allowed, false);
    assert.equal(g.reasons.length, 4);
    assert.match(g.reasons.join(" "), /outbound credential/);
    assert.match(g.reasons.join(" "), /inbound agent/);
    assert.match(outboundRegistrationGate(gateInput(), " Master-in ").reasons.join(" "), /master/);
  });
});

describe("customer setup steps (no internal details)", () => {
  const base = {
    agentExists: true,
    inboundAgentReady: false,
    outboundAgentReady: false,
    hasNumber: false,
    numberActive: false,
    inboundEnabled: false,
    needsAttention: false,
  };

  test("steps follow the pipeline order: number, inbound agent, phone line, outbound agent", () => {
    const s = customerSetupSteps(base);
    assert.deepEqual(
      s.map((x) => x.label),
      [
        "Business information received",
        "Assigning your phone number",
        "Creating your inbound AI agent",
        "Connecting your phone line",
        "Creating your outbound AI agent",
        "Ready",
      ],
    );
    assert.deepEqual(
      s.map((x) => x.status),
      ["done", "in_progress", "pending", "pending", "pending", "pending"],
    );
    const ready = customerSetupSteps({
      ...base,
      inboundAgentReady: true,
      outboundAgentReady: true,
      hasNumber: true,
      numberActive: true,
      inboundEnabled: true,
    });
    assert.ok(ready.every((x) => x.status === "done"));
  });

  test("an inbound line that is live while the outbound agent is pending is not Ready", () => {
    const s = customerSetupSteps({
      ...base,
      inboundAgentReady: true,
      hasNumber: true,
      numberActive: true,
      inboundEnabled: true,
    });
    assert.equal(s[4]!.status, "in_progress", "the outbound agent is the pending step");
    assert.equal(s[5]!.status, "pending");
  });

  test("while the deployment is verified, the phone line (not the outbound agent) is in progress", () => {
    // Found in the browser harness: the outbound agent was shown as the
    // current step while the pipeline was still connecting the phone line.
    const verifying = customerSetupSteps({ ...base, inboundAgentReady: true, hasNumber: true });
    assert.equal(verifying[3]!.label, "Connecting your phone line");
    assert.equal(verifying[3]!.status, "in_progress");
    assert.equal(verifying[4]!.status, "pending");
    const failed = customerSetupSteps({
      ...base,
      inboundAgentReady: true,
      hasNumber: true,
      needsAttention: true,
    });
    assert.equal(failed[3]!.status, "attention");
    assert.equal(failed[4]!.status, "pending");
  });

  test("a step needing the ClickAI team shows attention, never an error message or id", () => {
    const s = customerSetupSteps({ ...base, hasNumber: true, needsAttention: true });
    assert.equal(s[2]!.label, "Creating your inbound AI agent");
    assert.equal(s[2]!.status, "attention");
    assert.doesNotMatch(JSON.stringify(s), /sarvam|app_id|Error|[0-9a-f]{8}-/i);
  });
});

describe("wiring (source checks)", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  test("every outbound dial path picks the agent through outboundAgentTarget, never sarvam_app_id", () => {
    for (const p of ["./sarvam-outbound-call.server.ts", "./campaign-dispatch.server.ts"]) {
      const src = read(p);
      const dial = src.slice(src.indexOf("createInstantOutbound({"));
      const args = dial.slice(0, dial.indexOf("});"));
      assert.match(args, /appId: target\.appId/, p);
      assert.match(args, /appVersion: target\.appVersion/, p);
      assert.doesNotMatch(args, /sarvam_app_id|sarvam_app_version/, p);
      assert.match(src, /const target = outboundAgentTarget\(agentConfig\)/, p);
    }
  });

  test("a Sarvam campaign is checked to run the outbound agent before any cohort upload", () => {
    const src = read("./campaigns.functions.ts");
    const fn = src.slice(src.indexOf("async function launchViaSarvamCampaign"));
    const check = fn.indexOf("sarvamCampaignUsesAgent(sarvamCampaign.raw, target)");
    const upload = fn.indexOf("adapter.uploadCohort(");
    assert.ok(check > -1 && check < upload);
  });

  test("outbound registration and credentials are platform-admin only and audited", () => {
    const admin = read("./provisioning-admin.functions.ts");
    const fn = admin.slice(admin.indexOf("export const registerCustomerSarvamOutboundAgent"));
    const body = fn.slice(0, fn.indexOf("\n  });") + 5);
    assert.match(
      body,
      /assertPlatformAdmin\(context\.supabase, context\.userId, "agents\.write"\)/,
    );
    assert.match(body, /outboundRegistrationGate\(/);
    assert.match(body, /SARVAM_OUTBOUND_AGENT_REGISTERED/);
    const integ = read("./sarvam-integration.functions.ts");
    assert.match(integ, /\.eq\("role", role\)\s*\.eq\("status", "active"\)/);
    assert.match(integ, /role,\n\s*\}\)/, "the new credential is stored with its role");
  });

  test("the inbound credential checks pin role inbound", () => {
    for (const p of [
      "./provisioning-pipeline.server.ts",
      "./call-outcome-reconciliation.server.ts",
    ]) {
      const src = read(p);
      assert.match(src, /\.eq\("role", "inbound"\)/, p);
    }
  });
});
