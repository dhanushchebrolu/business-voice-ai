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
import {
  buildOutboundAgentConfig,
  buildUniversalAgentConfig,
  outboundVoicemailMessage,
} from "./universal-agent-config.ts";
import { OUTBOUND_MAX_CALL_SECONDS_CAP } from "./agent-roles.ts";
import { OUTBOUND_MAX_CALL_SECONDS } from "./sarvam-outbound-mode.server.ts";
import { OUTBOUND_RETAINED_VARIABLES } from "./call-variables.ts";
import { sarvamToolConfiguration } from "./sarvam-agent-api.server.ts";
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
  test("the outbound credential reaches reads, booking and the call outcome; nothing else", () => {
    assert.equal(roleAllowsAgentApi("outbound", undefined), true, "on-start context");
    for (const t of [
      "get_business_info",
      "check_availability",
      "book_appointment",
      "record_call_outcome",
    ])
      assert.equal(roleAllowsAgentApi("outbound", t), true, t);
    for (const t of ["request_callback", "send_reminder", "call_transfer", "x"])
      assert.equal(roleAllowsAgentApi("outbound", t), false, t);
    for (const t of [undefined, ...AGENT_TOOLS])
      assert.equal(roleAllowsAgentApi("inbound", t), true, String(t));
  });

  test("only the callback endpoint is forbidden for outbound; the template and the gate agree", () => {
    const writes = AGENT_TOOLS.filter((t) => !roleAllowsAgentApi("outbound", t));
    assert.deepEqual([...writes].sort(), ["request_callback"]);
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

  test("the outbound template books only with the booking capability, and never gets a callback, message or transfer tool", () => {
    for (const caps of [{}, everything]) {
      const c = buildOutboundAgentConfig(snapshot(caps), VOICE);
      // Booking only with the customer's booking capability; the rest always.
      assert.deepEqual(
        c.tools.enable,
        OUTBOUND_AGENT_TOOLS.filter((t) => t !== "book_appointment" || caps === everything),
      );
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
    assert.match(
      a.fingerprint,
      /^o5-[0-9a-f]{8}$/,
      "outbound template version 5 (shared prompt and booking reply template)",
    );
    assert.match(buildUniversalAgentConfig(snapshot({}), VOICE).fingerprint, /^u1-[0-9a-f]{8}$/);
  });

  test("tenant isolation: the prompt follows capabilities and category, never a customer's own data", () => {
    const salon = (caps: Record<string, boolean>) =>
      buildOutboundAgentConfig(
        {
          ...snapshot(caps, "Sunrise Salon"),
          business: { ...snapshot({}).business, name: "Sunrise Salon", business_type: "salon" },
        },
        VOICE,
      );
    const dental = buildOutboundAgentConfig(snapshot({ calendar_book: true }), VOICE);
    const salonBooking = salon({ calendar_book: true });
    // Same capabilities and category -> the same prompt for any customer.
    assert.equal(
      buildOutboundAgentConfig(snapshot({ calendar_book: true }, "Other Dental"), VOICE)
        .systemPrompt,
      dental.systemPrompt,
    );
    assert.equal(salonBooking.systemPrompt, salon({ calendar_book: true }).systemPrompt);
    assert.deepEqual(dental.tools, salonBooking.tools);
    assert.deepEqual(dental.callVariables, salonBooking.callVariables);
    // Customer data never enters the prompt; it stays in the customer's own settings.
    for (const cfg of [dental, salonBooking])
      for (const own of ["Smile Dental", "Sunrise Salon", "+919800000000", "Cleaning", "Aria"])
        assert.ok(!cfg.systemPrompt.includes(own), own);
    assert.match(salonBooking.callHandling.voicemailMessage, /Sunrise Salon/);
    assert.doesNotMatch(salonBooking.callHandling.voicemailMessage, /Smile Dental/);
    assert.notEqual(dental.fingerprint, salonBooking.fingerprint);
  });

  test("outbound booking follows the customer's own booking capability", () => {
    const withBooking = buildOutboundAgentConfig(snapshot({ calendar_book: true }), VOICE);
    const without = buildOutboundAgentConfig(snapshot({}), VOICE);
    assert.ok(withBooking.tools.enable.includes("book_appointment"));
    assert.ok(!without.tools.enable.includes("book_appointment"));
    assert.ok(without.tools.enable.includes("check_availability"), "availability stays");
    assert.match(withBooking.systemPrompt, /tool:book_appointment/);
    assert.doesNotMatch(without.systemPrompt, /book_appointment/);
    assert.match(without.systemPrompt, /This call cannot book/);
    // Same rule as the inbound agent's capability mapping.
    for (const caps of [{}, { calendar_book: true }, { book_appointment: true }])
      assert.equal(
        buildOutboundAgentConfig(snapshot(caps), VOICE).tools.enable.includes("book_appointment"),
        buildUniversalAgentConfig(snapshot(caps), VOICE).tools.enable.includes("book_appointment"),
        JSON.stringify(caps),
      );
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

  test("no Sarvam cohort is uploaded at all: campaigns dial only through the outbound-agent dispatcher", () => {
    assert.doesNotMatch(read("./campaigns.functions.ts"), /uploadCohort\(/);
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

describe("outbound template (v2 call settings, v3 booking): post-call variables and call settings", () => {
  const outbound = sarvamToolConfiguration("https://clickai.in", "outbound");
  const outputs = new Map(outbound.outputVariables.map((v) => [v.name, v]));

  test("declares every post-call variable outbound finalization reads (G1)", () => {
    // do_not_call is an alias ClickAI also honours; opted_out is the one the agent sets.
    for (const name of OUTBOUND_RETAINED_VARIABLES.filter((n) => n !== "do_not_call"))
      assert.ok(outputs.has(name), name);
  });

  test("outbound_result offers exactly the values finalization understands", () => {
    const type = outputs.get("outbound_result")!.type;
    for (const v of [
      "interested",
      "not_interested",
      "callback_requested",
      "opted_out",
      "wrong_person",
      "voicemail",
      "no_conversation",
    ])
      assert.match(type, new RegExp(`\\b${v}\\b`), v);
    assert.doesNotMatch(type, /\bbooked\b/, "an outbound agent can never book");
    assert.match(outputs.get("wrong_number")!.type, /yes, no/);
    assert.match(outputs.get("interest_level")!.type, /high, medium, low, none/);
  });

  test("the inbound template is not given the outbound-only variables", () => {
    const inbound = new Set(
      sarvamToolConfiguration("https://clickai.in").outputVariables.map((v) => v.name),
    );
    for (const name of ["wrong_number", "interest_level", "outbound_result"])
      assert.ok(!inbound.has(name), name);
  });

  test("call settings: 300 s hard maximum, voicemail detection with a fixed message, no transfer", () => {
    const c = buildOutboundAgentConfig(snapshot({}), VOICE);
    assert.equal(c.templateVersion, 5);
    assert.deepEqual(c.callHandling, {
      maxCallSeconds: 300,
      voicemailDetection: true,
      voicemailMessage:
        "This is the virtual assistant from Smile Dental. Sorry we missed you. Thank you.",
      callTransfer: false,
    });
    assert.equal(OUTBOUND_MAX_CALL_SECONDS_CAP, 300);
    assert.equal(OUTBOUND_MAX_CALL_SECONDS.max, 300, "confirmation refuses anything longer");
  });

  test("the voicemail message carries the business name only, never variables or personal details", () => {
    assert.equal(
      outboundVoicemailMessage("  Smile\n Dental  "),
      "This is the virtual assistant from Smile Dental. Sorry we missed you. Thank you.",
    );
    assert.equal(
      outboundVoicemailMessage(""),
      "This is a virtual assistant. Sorry we missed you. Thank you.",
    );
    assert.doesNotMatch(outboundVoicemailMessage("Smile Dental"), /\{\{|@|\d{6,}/);
    assert.ok(outboundVoicemailMessage("x".repeat(500)).length < 200);
  });
});
