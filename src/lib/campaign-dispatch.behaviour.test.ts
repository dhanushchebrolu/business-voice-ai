import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchDueCampaigns,
  type CampaignAdmission,
  type CampaignAdmissionRequest,
  type DispatchDeps,
} from "./campaign-dispatch.server.ts";
import { TelephonyAdapterError } from "./telephony/adapter.ts";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";

/**
 * Behaviour of the campaign dispatcher against an in-memory database with the
 * production unique indexes, a fake Sarvam adapter and fixed gates. Nothing
 * here reaches Sarvam, Supabase or the network.
 */

type Row = Record<string, unknown>;
const ORG = "org_a";
const CAMPAIGN = "camp_1";
// The pilot allowlist fails closed: list exactly the numbers these tests dial.
process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"] = [
  ...Array.from({ length: 30 }, (_, i) => `+9198765432${String(i).padStart(2, "0")}`),
  "+919876543299",
].join(",");

const UNRESOLVED = ["initiated", "outcome_unknown"];
const TERMINAL = ["completed", "failed", "busy", "no_answer", "cancelled"];

const REVIEWED_CONTEXT = {
  version: 1,
  objective: "Invite past customers for a check-up",
  audience: "",
  talkingPoints: ["Mention the free consultation"],
  questions: [],
  servicesInScope: [],
  desiredOutcome: "",
  objectionHandling: "",
  callbackHandling: "",
  closing: "",
  tone: "",
  extraInstructions: "",
  successCriteria: "",
};

function setup(contactCount: number) {
  const contacts: Row[] = [];
  const campaignContacts: Row[] = [];
  for (let i = 1; i <= contactCount; i++) {
    contacts.push({
      id: `contact_${i}`,
      organization_id: ORG,
      phone: `+9198765432${String(i).padStart(2, "0")}`,
      opted_out: false,
    });
    campaignContacts.push({
      id: `cc_${i}`,
      campaign_id: CAMPAIGN,
      organization_id: ORG,
      contact_id: `contact_${i}`,
      status: "pending",
      attempts: 0,
      next_attempt_at: null,
      variables: {},
      created_at: `2026-11-17T10:00:0${i}Z`,
    });
  }
  const db = memorySupabase({
    tables: {
      // Campaign calling is enabled per workspace by ClickAI (20261129090000).
      organizations: [{ id: ORG, campaign_dispatch_enabled: true }],
      campaigns: [
        {
          id: CAMPAIGN,
          organization_id: ORG,
          status: "running",
          dispatch_mode: "instant_outbound_fallback",
          phone_number_id: "num_1",
          agent_config_id: "agent_1",
          objective: null,
          call_instructions: null,
          context: REVIEWED_CONTEXT,
          context_reviewed_at: "2026-11-16T09:00:00Z",
          budget_limit: null,
          schedule: {},
          max_attempts: 3,
          retry_after_minutes: 60,
          retry_statuses: [],
        },
      ],
      telephony_connections: [
        {
          id: "conn_1",
          organization_id: ORG,
          provider: "sarvam",
          provider_connection_id: "sv_conn",
        },
      ],
      agent_configs: [
        {
          id: "agent_1",
          organization_id: ORG,
          sarvam_app_id: "app_1",
          sarvam_app_version: 2,
          sarvam_outbound_app_id: "app_1-out",
          sarvam_outbound_app_version: 2,
          sarvam_outbound_ready_app_id: "app_1-out",
          sarvam_outbound_ready_version: 2,
          sarvam_outbound_max_call_seconds: 300,
        },
      ],
      contacts,
      campaign_contacts: campaignContacts,
      call_logs: [],
    },
    uniques: [
      // idx_call_logs_sarvam_outbound_number_reservation
      {
        table: "call_logs",
        key: (r) =>
          r["provider"] === "sarvam" &&
          r["direction"] === "outbound" &&
          UNRESOLVED.includes(String(r["status"]))
            ? `${r["organization_id"]}:${r["destination_number"]}`
            : null,
      },
      // idx_call_logs_campaign_contact_inflight
      {
        table: "call_logs",
        key: (r) =>
          r["campaign_contact_id"] && !TERMINAL.includes(String(r["status"]))
            ? String(r["campaign_contact_id"])
            : null,
      },
    ],
  });
  const dialed: string[] = [];
  const requests: Record<string, unknown>[] = [];
  let clock = Date.parse("2026-11-17T10:00:00Z");
  const onDial: { fn?: ((n: number) => void | Promise<void>) | undefined } = {};
  /** Runs once, between the running-check before the first claim and that claim. */
  const onBeforeClaim: { fn?: () => void } = {};
  const failDial: { err?: Error | undefined } = {};
  /** Admission requests seen, and a refusal to give instead of admitting. */
  const admission: { requests: CampaignAdmissionRequest[]; refuse?: string | undefined } = {
    requests: [],
  };
  const deps: DispatchDeps = {
    supabaseAdmin: db.client,
    checkTelephonyAccess: async () =>
      ({
        allowed: true,
        reason: null,
        phoneNumber: { provider: "sarvam", e164: "+911111111111", connection_id: "conn_1" },
      }) as never,
    // Mirrors admit_campaign_outbound_call: refuses unless the campaign is still
    // running, then writes the call row (the unique indexes above apply).
    admitCampaignCall: async (req): Promise<CampaignAdmission> => {
      admission.requests.push(req);
      const camp = (db.tables["campaigns"] ?? []).find((c) => c["id"] === req.campaignId);
      if (camp?.["status"] !== "running")
        return { result: "refused", reason: "campaign_not_running" };
      if (admission.refuse) return { result: "refused", reason: admission.refuse };
      if (camp["context_reviewed_at"] !== req.contextReviewedAt)
        return { result: "refused", reason: "context_changed" };
      const cc = (db.tables["campaign_contacts"] ?? []).find(
        (c) => c["id"] === req.campaignContactId,
      )!;
      const writer = db.client as unknown as {
        from: (t: string) => {
          insert: (r: unknown) => PromiseLike<{ error: { message: string; code?: string } | null }>;
        };
      };
      const { error } = await writer.from("call_logs").insert({
        id: req.callId,
        organization_id: ORG,
        campaign_id: req.campaignId,
        campaign_contact_id: req.campaignContactId,
        contact_id: cc["contact_id"],
        phone_number_id: "num_1",
        provider: "sarvam",
        direction: "outbound",
        caller_number: "+911111111111",
        destination_number: req.destination,
        status: "initiated",
        started_at: new Date(clock).toISOString(),
        retry_attempt: req.retryAttempt,
        billing_cap_minutes: 5,
        billing_rate_per_minute: 400,
        campaign_context_snapshot: {
          reviewed_at: req.contextReviewedAt,
          context: camp["context"],
          sent: {
            campaign_objective: req.sentObjective,
            campaign_instructions: req.sentInstructions,
          },
        },
      });
      if (error) {
        if (error.code === "23505") return { result: "refused", reason: "destination_busy" };
        throw new Error(error.message);
      }
      return {
        result: "admitted",
        call_id: req.callId,
        caller_number: "+911111111111",
        cap_minutes: 5,
        rate_per_minute: 400,
      };
    },
    adapter: {
      createInstantOutbound: async (input) => {
        dialed.push(input.toE164);
        requests.push(input as unknown as Record<string, unknown>);
        await onDial.fn?.(dialed.length);
        if (failDial.err) throw failDial.err;
        return { attemptId: `att_${dialed.length}`, interactionId: undefined, raw: {} };
      },
    },
    webhookUrl: {
      ok: true,
      url: "https://clickai.test/api/public/webhooks/telephony?provider=sarvam",
    },
    templateVariables: async () => ({}),
    finalize: async () => undefined,
    now: () => clock,
  };
  // The hook fires between the running-check before the first claim (the
  // second campaigns read) and that claim (the next campaign_contacts write).
  const client = db.client as unknown as { from: (table: string) => unknown };
  const realFrom = client.from.bind(client);
  let campaignReads = 0;
  let hookArmed = false;
  client.from = (table: string) => {
    if (table === "campaigns" && ++campaignReads === 2) hookArmed = true;
    else if (hookArmed && table === "campaign_contacts") {
      hookArmed = false;
      onBeforeClaim.fn?.();
    }
    return realFrom(table);
  };
  const table = (name: string) => db.tables[name] ?? [];
  const advance = (ms: number) => {
    clock += ms;
  };
  return {
    db,
    deps,
    dialed,
    requests,
    table,
    onDial,
    onBeforeClaim,
    failDial,
    advance,
    admission,
  };
}

const setCampaignStatus = (t: ReturnType<typeof setup>, status: string) => {
  t.table("campaigns")[0]!["status"] = status;
};

describe("campaign dispatch — duplicates and overlap", () => {
  test("two overlapping dispatch runs dial every due contact exactly once", async () => {
    const t = setup(5);
    await Promise.all([
      dispatchDueCampaigns({ deps: t.deps }),
      dispatchDueCampaigns({ deps: t.deps }),
    ]);
    assert.equal(t.dialed.length, 5);
    assert.equal(new Set(t.dialed).size, 5, "no number dialled twice");
    assert.equal(t.table("call_logs").length, 5);
    assert.ok(t.table("campaign_contacts").every((c) => c["attempts"] === 1));
  });
});

describe("campaign dispatch — the global outbound kill switch", () => {
  test("with OUTBOUND_CALLING_DISABLED=true nothing is claimed or dialled, by any trigger", async () => {
    const t = setup(3);
    const prior = process.env["OUTBOUND_CALLING_DISABLED"];
    process.env["OUTBOUND_CALLING_DISABLED"] = "true";
    try {
      const summary = await dispatchDueCampaigns({ deps: t.deps });
      assert.equal(t.dialed.length, 0);
      assert.equal(summary.campaignsConsidered, 0);
      assert.ok(t.table("campaign_contacts").every((c) => c["status"] === "pending"));
    } finally {
      if (prior === undefined) delete process.env["OUTBOUND_CALLING_DISABLED"];
      else process.env["OUTBOUND_CALLING_DISABLED"] = prior;
    }
    // Switched back on: the same campaign dials.
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 3);
  });
});

describe("campaign dispatch — only workspaces ClickAI enabled for campaigns", () => {
  test("a running campaign in a workspace without campaign calling is never claimed or dialled", async () => {
    const t = setup(3);
    (t.table("organizations")[0] as Record<string, unknown>)["campaign_dispatch_enabled"] = false;
    const summary = await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    assert.equal(summary.campaignsConsidered, 0);
    assert.ok(t.table("campaign_contacts").every((c) => c["status"] === "pending"));
    // Enabled by ClickAI: the same campaign dials.
    (t.table("organizations")[0] as Record<string, unknown>)["campaign_dispatch_enabled"] = true;
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 3);
  });

  test("a workspace whose authorization cannot be read is treated as not enabled", async () => {
    const t = setup(2);
    t.table("organizations").length = 0;
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
  });
});

describe("campaign dispatch — the pilot allowlist fails closed (GATE C4 H2)", () => {
  test("missing, empty, or without these numbers: nothing claimed, admitted, written or dialled", async () => {
    const prior = process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"];
    try {
      for (const value of [undefined, "", " , ", "+919999999999"]) {
        if (value === undefined) delete process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"];
        else process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"] = value;
        const t = setup(2);
        await dispatchDueCampaigns({ deps: t.deps });
        assert.equal(t.dialed.length, 0, String(value));
        assert.equal(t.admission.requests.length, 0, String(value));
        assert.equal(t.table("call_logs").length, 0, String(value));
        assert.ok(t.table("campaign_contacts").every((c) => c["status"] === "pending"));
      }
    } finally {
      if (prior === undefined) delete process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"];
      else process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"] = prior;
    }
  });

  test("only the listed number is dialled", async () => {
    const prior = process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"];
    process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"] = "+919876543201";
    try {
      const t = setup(3);
      await dispatchDueCampaigns({ deps: t.deps });
      assert.deepEqual(t.dialed, ["+919876543201"]);
    } finally {
      if (prior === undefined) delete process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"];
      else process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"] = prior;
    }
  });
});

describe("campaign dispatch — pause and cancel stop the batch", () => {
  test("a pause during the batch stops further claims; untouched contacts stay pending", async () => {
    const t = setup(5);
    t.onDial.fn = (n) => {
      if (n === 1) setCampaignStatus(t, "paused");
    };
    const summary = await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 1);
    assert.equal(summary.contactsDialed, 1);
    const rest = t.table("campaign_contacts").filter((c) => c["id"] !== "cc_1");
    assert.ok(rest.every((c) => c["status"] === "pending" && c["attempts"] === 0));
    // Resuming carries on from the next contact.
    setCampaignStatus(t, "running");
    t.onDial.fn = undefined;
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 5);
  });

  test("a cancel during the batch stops further claims", async () => {
    const t = setup(4);
    t.onDial.fn = (n) => {
      if (n === 2) setCampaignStatus(t, "cancelled");
    };
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 2);
    assert.equal(t.table("call_logs").length, 2);
  });

  test("a pause landing between the check and the claim gives the contact back undialled", async () => {
    const t = setup(3);
    t.onBeforeClaim.fn = () => setCampaignStatus(t, "paused");
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    assert.equal(t.table("call_logs").length, 0);
    const first = t.table("campaign_contacts").find((c) => c["id"] === "cc_1")!;
    assert.equal(first["status"], "pending");
    assert.equal(first["attempts"], 0);
    assert.equal(first["current_call_id"], null);
  });

  test("a cancel landing between the check and the claim cancels that contact, undialled", async () => {
    const t = setup(2);
    t.onBeforeClaim.fn = () => setCampaignStatus(t, "cancelled");
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    const first = t.table("campaign_contacts").find((c) => c["id"] === "cc_1")!;
    assert.equal(first["status"], "cancelled");
    assert.equal(first["attempts"], 0);
  });

  test("a failed status read right after a claim gives the contact back, never stranded in calling", async () => {
    const t = setup(1);
    const client = t.db.client as unknown as { from: (table: string) => unknown };
    const realFrom = client.from;
    let campaignReads = 0;
    // Read 1 lists running campaigns, 2 is the check before the claim, 3 the one after.
    client.from = (table: string) => {
      if (table === "campaigns" && ++campaignReads === 3) throw new Error("connection reset");
      return realFrom(table);
    };
    const original = console.error;
    console.error = () => {};
    try {
      await dispatchDueCampaigns({ deps: t.deps });
    } finally {
      console.error = original;
      client.from = realFrom;
    }
    assert.equal(t.dialed.length, 0);
    const contact = t.table("campaign_contacts")[0]!;
    assert.equal(contact["status"], "pending");
    assert.equal(contact["attempts"], 0);
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 1, "dialled on the next run");
  });

  test("no new contact is claimed after the deadline; the next run continues", async () => {
    const t = setup(4);
    const deadline = t.deps.now() + 1_000;
    t.onDial.fn = () => t.advance(800);
    await dispatchDueCampaigns({ deps: t.deps, deadline });
    assert.equal(t.dialed.length, 2, "claims stop once the deadline has passed");
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 4);
  });
});

describe("campaign dispatch — start results", () => {
  test("an ambiguous Sarvam error still holds call and contact in outcome_unknown, never redialled", async () => {
    const t = setup(1);
    t.failDial.err = new TelephonyAdapterError("Sarvam did not respond in time.", 503, true);
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.table("call_logs")[0]!["status"], "outcome_unknown");
    assert.equal(t.table("campaign_contacts")[0]!["status"], "outcome_unknown");
    t.failDial.err = undefined;
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 1, "not dialled again");
  });

  test("an account-level rejection (402 out of credits) ends the run: contact given back, attempt not used, campaign paused", async () => {
    for (const status of [401, 402, 403]) {
      const t = setup(3);
      t.table("campaigns")[0]!["retry_statuses"] = ["failed"];
      t.deps.finalize = async (callId) => {
        const cc = t.table("campaign_contacts").find((c) => c["current_call_id"] === callId);
        if (cc) Object.assign(cc, { status: "retry_scheduled" });
      };
      t.failDial.err = new TelephonyAdapterError("Sarvam account refused.", status, false);
      await dispatchDueCampaigns({ deps: t.deps });
      assert.equal(t.dialed.length, 1, `${status}: only one request reaches Sarvam`);
      assert.equal(t.table("call_logs")[0]!["status"], "failed");
      assert.equal(t.table("call_logs")[0]!["resolution_source"], "start_failure");
      for (const cc of t.table("campaign_contacts")) {
        assert.equal(cc["status"], "pending", `${status}: every contact untouched`);
        assert.equal(cc["attempts"], 0);
      }
      assert.equal(t.table("campaigns")[0]!["status"], "paused");
    }
  });

  test("a failed attempt_id write is retried; the placed call is never marked failed", async () => {
    const t = setup(1);
    t.db.failNext("call_logs", "update", { code: "57014", message: "statement timeout" });
    const summary = await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(summary.contactsDialed, 1);
    const call = t.table("call_logs")[0]!;
    assert.equal(call["status"], "initiated");
    assert.equal(call["provider_call_id"], "att_1", "saved on the retry");
    assert.equal(t.table("campaign_contacts")[0]!["status"], "calling");
  });
});

describe("campaign dispatch — only the customer's outbound agent", () => {
  test("a version not confirmed for outbound dials nothing and claims nothing", async () => {
    const t = setup(3);
    t.table("agent_configs")[0]!["sarvam_outbound_ready_version"] = 1; // remapped to v2 since
    const original = console.error;
    console.error = () => {};
    try {
      await dispatchDueCampaigns({ deps: t.deps });
    } finally {
      console.error = original;
    }
    assert.equal(t.dialed.length, 0);
    assert.ok(
      t.table("campaign_contacts").every((c) => c["status"] === "pending" && c["attempts"] === 0),
    );
  });

  test("never falls back to the inbound agent: inbound-only or misregistered agents dial nothing", async () => {
    for (const over of [
      // The old one-agent model: the inbound agent confirmed, no outbound agent.
      {
        sarvam_outbound_app_id: null,
        sarvam_outbound_app_version: null,
        sarvam_outbound_ready_app_id: "app_1",
        sarvam_outbound_ready_version: 2,
      },
      // An outbound registration that is the inbound agent itself.
      { sarvam_outbound_app_id: "app_1", sarvam_outbound_ready_app_id: "app_1" },
    ]) {
      const t = setup(2);
      Object.assign(t.table("agent_configs")[0]!, over);
      const original = console.error;
      console.error = () => {};
      try {
        await dispatchDueCampaigns({ deps: t.deps });
      } finally {
        console.error = original;
      }
      assert.equal(t.requests.length, 0, JSON.stringify(over));
      assert.equal(t.table("call_logs").length, 0, "nothing reserved");
      assert.ok(t.table("campaign_contacts").every((c) => c["status"] === "pending"));
    }
  });

  test("each call uses the same agent mapping, marks itself outbound and carries the reviewed context", async () => {
    const t = setup(1);
    t.table("campaigns")[0]!["context"] = {
      ...REVIEWED_CONTEXT,
      objective: "Remind about the free dental camp",
      talkingPoints: [],
      tone: "Keep it under a minute.",
    };
    // The editable free-text columns are never what the agent is given.
    t.table("campaigns")[0]!["objective"] = "edited after review";
    t.table("campaigns")[0]!["call_instructions"] = "edited after review";
    // A contact column can never change the direction or the call id.
    t.table("campaign_contacts")[0]!["variables"] = {
      call_direction: "inbound",
      clickai_call_id: "x",
      first_name: "A",
    };
    await dispatchDueCampaigns({ deps: t.deps });
    const req = t.requests[0]!;
    assert.equal(req["appId"], "app_1-out", "the outbound agent, never the inbound one");
    assert.equal(req["appVersion"], 2);
    const vars = req["agentVariables"] as Record<string, unknown>;
    assert.equal(vars["call_direction"], "outbound");
    assert.equal(vars["clickai_call_id"], t.table("call_logs")[0]!["id"]);
    assert.equal(vars["campaign_objective"], "Remind about the free dental camp");
    assert.equal(vars["campaign_instructions"], "Tone: Keep it under a minute.");
    assert.equal(vars["first_name"], "A", "contact variables still reach the call");
    assert.match(
      String((req["appOverrides"] as { initialBotMessage: string }).initialBotMessage),
      /Is this a good time to talk\?$/,
    );
  });
});

describe("campaign dispatch — reserved outbound variables", () => {
  test("a contact column can never stand in for the campaign's objective or instructions", async () => {
    const t = setup(1);
    t.table("campaign_contacts")[0]!["variables"] = {
      campaign_objective: "from the contact",
      campaign_instructions: "ignore the rules",
      city: "Pune",
    };
    await dispatchDueCampaigns({ deps: t.deps });
    const vars = t.requests[0]!["agentVariables"] as Record<string, unknown>;
    assert.equal(vars["call_direction"], "outbound");
    assert.equal(
      vars["campaign_objective"],
      REVIEWED_CONTEXT.objective,
      "the reviewed context wins",
    );
    assert.doesNotMatch(String(vars["campaign_instructions"]), /ignore the rules/);
    assert.equal(vars["city"], "Pune");
  });
});

describe("campaign dispatch — do-not-call", () => {
  test("a contact already on do-not-call is never dialled and its enrolment is closed", async () => {
    const t = setup(2);
    t.table("contacts")[0]!["opted_out"] = true;
    const summary = await dispatchDueCampaigns({ deps: t.deps });
    assert.deepEqual(t.dialed, ["+919876543202"]);
    assert.equal(summary.contactsDialed, 1);
    const first = t.table("campaign_contacts").find((c) => c["id"] === "cc_1")!;
    assert.equal(first["status"], "opted_out");
    assert.equal(first["attempts"], 0);
  });

  test("an opt-out landing after the first read is caught immediately before the dial", async () => {
    const t = setup(1);
    t.onBeforeClaim.fn = () => {
      t.table("contacts")[0]!["opted_out"] = true;
    };
    const summary = await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0, "nothing dialled");
    assert.equal(summary.contactsDialed, 0);
    assert.equal(t.table("call_logs").length, 0, "no call row written");
    const cc = t.table("campaign_contacts")[0]!;
    assert.equal(cc["status"], "opted_out");
    assert.equal(cc["attempts"], 0, "the claim's attempt is given back");
    assert.equal(cc["current_call_id"], null);
  });
});

describe("campaign dispatch — do-not-call by number, per workspace", () => {
  test("another opted-out contact holding the same number in this workspace stops the dial", async () => {
    const t = setup(1);
    const phone = t.table("contacts")[0]!["phone"];
    t.table("contacts").push({ id: "dup", organization_id: ORG, phone, opted_out: true });
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    assert.equal(t.table("campaign_contacts")[0]!["status"], "opted_out");
  });

  test("the same number opted out in another workspace does not stop this one", async () => {
    const t = setup(1);
    const phone = t.table("contacts")[0]!["phone"];
    t.table("contacts").push({ id: "other", organization_id: "org_other", phone, opted_out: true });
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 1);
  });
});

describe("campaign dispatch — read failure is not an opt-out", () => {
  /** Makes the n-th read of `contacts` (1-based) fail like a dropped connection. */
  function failContactsRead(t: ReturnType<typeof setup>, nth: number) {
    const client = t.db.client as unknown as { from: (table: string) => unknown };
    const realFrom = client.from;
    let reads = 0;
    const failing: Record<string, unknown> = {
      select: () => failing,
      eq: () => failing,
      limit: () => failing,
      maybeSingle: () => failing,
      then: (resolve: (v: unknown) => void) =>
        Promise.resolve({ data: null, error: { message: "connection reset" } }).then(resolve),
    };
    client.from = (table: string) =>
      table === "contacts" && ++reads === nth ? failing : realFrom(table);
    return () => {
      client.from = realFrom;
    };
  }
  const quiet = async (fn: () => Promise<unknown>) => {
    const original = console.error;
    console.error = () => {};
    try {
      await fn();
    } finally {
      console.error = original;
    }
  };

  test("a failed first contact read skips the contact for now and marks nothing", async () => {
    const t = setup(1);
    const restore = failContactsRead(t, 1);
    try {
      await quiet(() => dispatchDueCampaigns({ deps: t.deps }));
    } finally {
      restore();
    }
    assert.equal(t.dialed.length, 0);
    const cc = t.table("campaign_contacts")[0]!;
    assert.equal(cc["status"], "pending", "still due, not opted out");
    assert.equal(cc["attempts"], 0);
    assert.equal(t.table("contacts")[0]!["opted_out"], false);
    // The next run, with the database back, dials it.
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 1);
  });

  test("a failed re-check after the claim gives the claim back and marks nothing", async () => {
    const t = setup(1);
    // Read 1: the first contact read; read 2: the re-check's contact read.
    const restore = failContactsRead(t, 2);
    try {
      await quiet(() => dispatchDueCampaigns({ deps: t.deps }));
    } finally {
      restore();
    }
    assert.equal(t.dialed.length, 0);
    assert.equal(t.table("call_logs").length, 0, "no call row written");
    const cc = t.table("campaign_contacts")[0]!;
    assert.equal(cc["status"], "pending");
    assert.equal(cc["attempts"], 0);
    assert.equal(cc["current_call_id"], null);
    assert.equal(t.table("contacts")[0]!["opted_out"], false);
  });

  test("a confirmed opt-out closes this enrolment and the contact's other pending enrolments", async () => {
    const t = setup(1);
    t.table("contacts")[0]!["opted_out"] = true;
    t.table("campaign_contacts").push({
      id: "cc_other",
      campaign_id: "camp_other",
      organization_id: ORG,
      contact_id: "contact_1",
      status: "pending",
      attempts: 0,
    });
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    assert.equal(
      t.table("campaign_contacts").find((c) => c["id"] === "cc_1")!["status"],
      "opted_out",
    );
    assert.equal(
      t.table("campaign_contacts").find((c) => c["id"] === "cc_other")!["status"],
      "opted_out",
    );
    assert.equal(t.table("contacts")[0]!["opted_out"], true);
  });
});

describe("campaign dispatch — the hard maximum call length", () => {
  const quiet = async (fn: () => Promise<unknown>) => {
    const original = console.error;
    console.error = () => {};
    try {
      await fn();
    } finally {
      console.error = original;
    }
  };

  test("every call goes through admission with the 3-call in-flight limit and its own call id", async () => {
    const t = setup(2);
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.requests.length, 2);
    assert.equal(t.admission.requests.length, 2);
    for (const req of t.admission.requests) {
      assert.equal(req.maxInFlight, 3);
      assert.equal(req.retryAttempt, 0);
      const cc = t.table("campaign_contacts").find((c) => c["id"] === req.campaignContactId)!;
      assert.equal(cc["current_call_id"], req.callId, "admitted for exactly the claimed call");
    }
  });

  test("no recorded maximum, or one above the 300 s hard maximum: nothing is claimed or dialled", async () => {
    for (const max of [null, 0, 59, 301, 3600]) {
      const t = setup(2);
      t.table("agent_configs")[0]!["sarvam_outbound_max_call_seconds"] = max;
      await quiet(() => dispatchDueCampaigns({ deps: t.deps }));
      assert.equal(t.requests.length, 0, String(max));
      assert.equal(t.table("call_logs").length, 0);
      assert.ok(t.table("campaign_contacts").every((c) => c["status"] === "pending"));
    }
  });

  test("refused for wallet or in-flight limit: nothing dialled, every contact given back, batch stops", async () => {
    for (const reason of ["insufficient_balance", "in_flight_limit"]) {
      const t = setup(3);
      t.admission.refuse = reason;
      await dispatchDueCampaigns({ deps: t.deps });
      assert.equal(t.requests.length, 0, reason);
      assert.equal(t.table("call_logs").length, 0);
      assert.equal(t.admission.requests.length, 1, "the batch stops at the first refusal");
      for (const cc of t.table("campaign_contacts")) {
        assert.equal(cc["status"], "pending");
        assert.equal(cc["attempts"], 0);
      }
      assert.equal(t.table("campaigns")[0]!["status"], "running");
    }
  });

  test("the campaign budget is spent: nothing dialled and the campaign pauses for the customer", async () => {
    const t = setup(2);
    t.admission.refuse = "budget_exhausted";
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.requests.length, 0);
    assert.equal(t.table("campaigns")[0]!["status"], "paused");
    assert.ok(t.table("campaign_contacts").every((c) => c["status"] === "pending"));
  });

  test("an admission error is not a dial: the contact is given back and the run continues safely", async () => {
    const t = setup(1);
    t.deps.admitCampaignCall = async () => {
      throw new Error("connection reset");
    };
    const original = console.error;
    console.error = () => {};
    try {
      await dispatchDueCampaigns({ deps: t.deps });
    } finally {
      console.error = original;
    }
    assert.equal(t.requests.length, 0);
    assert.equal(t.table("campaign_contacts")[0]!["status"], "pending");
  });
});

describe("campaign dispatch — platform rules and the reviewed context", () => {
  test("outside 09:00-21:00 India time nothing is read, claimed or dialled", async () => {
    const t = setup(2);
    t.advance(Date.parse("2026-11-17T16:00:00Z") - Date.parse("2026-11-17T10:00:00Z")); // 21:30 IST
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.requests.length, 0);
    assert.ok(t.table("campaign_contacts").every((c) => c["status"] === "pending"));
  });

  test("a campaign whose own schedule allows the night is still held to the platform hours", async () => {
    const t = setup(1);
    t.table("campaigns")[0]!["schedule"] = {
      windowStart: "00:00",
      windowEnd: "23:59",
      timezone: "Asia/Kolkata",
    };
    t.advance(Date.parse("2026-11-17T17:00:00Z") - Date.parse("2026-11-17T10:00:00Z")); // 22:30 IST
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.requests.length, 0);
  });

  test("a number outside +91 is excluded with its reason, never dialled or retried", async () => {
    const t = setup(2);
    t.table("contacts")[0]!["phone"] = "+14155550100";
    await dispatchDueCampaigns({ deps: t.deps });
    assert.deepEqual(t.dialed, ["+919876543202"]);
    const excluded = t.table("campaign_contacts").find((c) => c["id"] === "cc_1")!;
    assert.equal(excluded["status"], "excluded");
    assert.equal(excluded["excluded_reason"], "country_not_allowed");
    assert.equal(excluded["next_attempt_at"], null);
  });

  test("no reviewed context, or one that no longer validates: nothing is claimed or dialled", async () => {
    for (const patch of [
      { context_reviewed_at: null },
      { context: null },
      { context: { ...REVIEWED_CONTEXT, objective: "" } },
    ]) {
      const t = setup(1);
      Object.assign(t.table("campaigns")[0]!, patch);
      const original = console.error;
      console.error = () => {};
      try {
        await dispatchDueCampaigns({ deps: t.deps });
      } finally {
        console.error = original;
      }
      assert.equal(t.requests.length, 0, JSON.stringify(patch));
      assert.equal(t.table("campaign_contacts")[0]!["status"], "pending");
    }
  });

  test("two campaigns each carry only their own context", async () => {
    const t = setup(1);
    t.table("campaigns").push({
      ...t.table("campaigns")[0]!,
      id: "camp_2",
      context: {
        ...REVIEWED_CONTEXT,
        objective: "Second campaign reason",
        talkingPoints: ["Only for camp 2"],
      },
    });
    t.table("contacts").push({
      id: "contact_x",
      organization_id: ORG,
      phone: "+919876543299",
      opted_out: false,
    });
    t.table("campaign_contacts").push({
      id: "cc_x",
      campaign_id: "camp_2",
      organization_id: ORG,
      contact_id: "contact_x",
      status: "pending",
      attempts: 0,
      next_attempt_at: null,
      variables: {},
      created_at: "2026-11-17T10:00:09Z",
    });
    await dispatchDueCampaigns({ deps: t.deps });
    const byNumber = new Map(
      t.requests.map((r) => [r["toE164"], r["agentVariables"] as Record<string, string>]),
    );
    assert.equal(byNumber.get("+919876543201")!["campaign_objective"], REVIEWED_CONTEXT.objective);
    assert.match(byNumber.get("+919876543201")!["campaign_instructions"]!, /free consultation/);
    assert.equal(byNumber.get("+919876543299")!["campaign_objective"], "Second campaign reason");
    assert.match(byNumber.get("+919876543299")!["campaign_instructions"]!, /Only for camp 2/);
    assert.doesNotMatch(
      byNumber.get("+919876543299")!["campaign_instructions"]!,
      /free consultation/,
    );
  });
});

describe("campaign dispatch — stops that land after admission", () => {
  test("a pause right after admission: the call is recorded as never started and nothing is dialled", async () => {
    const t = setup(2);
    const admit = t.deps.admitCampaignCall;
    t.deps.admitCampaignCall = async (req) => {
      const r = await admit(req);
      setCampaignStatus(t, "paused");
      return r;
    };
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    const call = t.table("call_logs")[0]!;
    assert.equal(call["status"], "failed");
    assert.equal(
      call["resolution_source"],
      "start_failure",
      "costs nothing and counts against no budget",
    );
    assert.equal(t.table("call_logs").length, 1, "the batch stops");
  });

  test("a stop after admission never marks the undialled contact failed or uses up its attempt", async () => {
    // Finalization as apply_call_campaign_outcome applies it: only while the
    // contact still points at this exact call.
    const cases: [string, (t: ReturnType<typeof setup>) => void, string][] = [
      ["pause", (t) => setCampaignStatus(t, "paused"), "pending"],
      ["cancel", (t) => setCampaignStatus(t, "cancelled"), "cancelled"],
      ["calling hours end", (t) => t.advance(12 * 3600_000), "pending"],
    ];
    for (const [name, stop, expected] of cases) {
      const t = setup(1);
      t.table("campaigns")[0]!["retry_statuses"] = ["failed"];
      t.deps.finalize = async (callId) => {
        const cc = t.table("campaign_contacts")[0]!;
        if (cc["current_call_id"] === callId)
          Object.assign(cc, { status: "retry_scheduled", next_attempt_at: "2026-11-17T11:00:00Z" });
      };
      const admit = t.deps.admitCampaignCall;
      t.deps.admitCampaignCall = async (req) => {
        const r = await admit(req);
        stop(t);
        return r;
      };
      await dispatchDueCampaigns({ deps: t.deps });
      assert.equal(t.dialed.length, 0, name);
      assert.equal(t.table("call_logs")[0]!["resolution_source"], "start_failure", name);
      const cc = t.table("campaign_contacts")[0]!;
      assert.equal(cc["status"], expected, name);
      assert.equal(cc["attempts"], 0, `${name}: no attempt used`);
      assert.equal(cc["next_attempt_at"], null, `${name}: no retry scheduled`);
      assert.equal(cc["current_call_id"], null, name);
    }
  });

  test("the kill switch turned on mid-run stops the next contact", async () => {
    const t = setup(3);
    const prior = process.env["OUTBOUND_CALLING_DISABLED"];
    t.onDial.fn = () => {
      process.env["OUTBOUND_CALLING_DISABLED"] = "true";
    };
    try {
      await dispatchDueCampaigns({ deps: t.deps });
    } finally {
      if (prior === undefined) delete process.env["OUTBOUND_CALLING_DISABLED"];
      else process.env["OUTBOUND_CALLING_DISABLED"] = prior;
    }
    assert.equal(t.dialed.length, 1);
    assert.equal(t.table("campaign_contacts").filter((c) => c["status"] === "pending").length, 2);
  });
});

describe("campaign dispatch — M4: the context each call was admitted with", () => {
  test("admission records exactly the text the call sends, and the reviewed version it came from", async () => {
    const t = setup(2);
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.requests.length, 2);
    for (const [i, req] of t.admission.requests.entries()) {
      const vars = t.requests[i]!["agentVariables"] as Record<string, string>;
      assert.equal(req.sentObjective, vars["campaign_objective"]);
      assert.equal(req.sentInstructions, vars["campaign_instructions"]);
      assert.equal(req.contextReviewedAt, t.table("campaigns")[0]!["context_reviewed_at"]);
    }
  });

  test("a retry after the context was edited and re-reviewed uses the new version; the first call keeps its own", async () => {
    const t = setup(1);
    await dispatchDueCampaigns({ deps: t.deps });
    const first = t.table("call_logs")[0]!;
    const firstSnapshot = structuredClone(first["campaign_context_snapshot"]);
    // The call ended with no answer and is due again; the customer edited and re-reviewed meanwhile.
    first["status"] = "no_answer";
    Object.assign(t.table("campaign_contacts")[0]!, {
      status: "retry_scheduled",
      next_attempt_at: null,
    });
    Object.assign(t.table("campaigns")[0]!, {
      context: { ...REVIEWED_CONTEXT, objective: "Edited objective" },
      context_reviewed_at: "2026-11-17T09:30:00Z",
    });
    await dispatchDueCampaigns({ deps: t.deps });
    const calls = t.table("call_logs");
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls[0]!["campaign_context_snapshot"],
      firstSnapshot,
      "history is not rewritten",
    );
    const retry = calls[1]!["campaign_context_snapshot"] as {
      reviewed_at: string;
      sent: Record<string, string>;
    };
    assert.equal(retry.reviewed_at, "2026-11-17T09:30:00Z");
    assert.equal(retry.sent["campaign_objective"], "Edited objective");
    assert.equal(
      (t.requests[1]!["agentVariables"] as Record<string, string>)["campaign_objective"],
      "Edited objective",
    );
  });

  test("a context edit between the dispatcher's read and admission: refused, nothing dialled, contact given back", async () => {
    const t = setup(1);
    const admit = t.deps.admitCampaignCall;
    t.deps.admitCampaignCall = async (req) => {
      t.table("campaigns")[0]!["context_reviewed_at"] = "2026-11-17T09:59:00Z";
      return admit(req);
    };
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    assert.equal(t.table("call_logs").length, 0);
    assert.equal(t.table("campaign_contacts")[0]!["status"], "pending");
  });
});

describe("campaign dispatch — M5: the 21:00 India-time cutoff around admission", () => {
  // 15:29:59Z = 20:59:59 IST
  const atCutoff = Date.parse("2026-11-17T15:29:59Z") - Date.parse("2026-11-17T10:00:00Z");

  test("dispatched before the cutoff, admitted after it (admission refuses): nothing dialled, contact given back", async () => {
    const t = setup(2);
    t.advance(atCutoff);
    t.admission.refuse = "outside_calling_hours";
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    assert.equal(t.table("call_logs").length, 0);
    assert.ok(
      t.table("campaign_contacts").every((c) => c["status"] === "pending" && c["attempts"] === 0),
    );
  });

  test("admitted before the cutoff, about to dial after it: recorded as never started, nothing dialled", async () => {
    const t = setup(2);
    t.advance(atCutoff);
    const admit = t.deps.admitCampaignCall;
    t.deps.admitCampaignCall = async (req) => {
      const r = await admit(req);
      t.advance(2_000); // 21:00:01 IST before the dial
      return r;
    };
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    const call = t.table("call_logs")[0]!;
    assert.equal(call["status"], "failed");
    assert.equal(call["resolution_source"], "start_failure");
  });

  test("08:59 and 21:00 India time: nothing is read or dialled; 09:00 and 20:59 dial", async () => {
    const cases: [string, number][] = [
      ["2026-11-17T03:29:00Z", 0], // 08:59
      ["2026-11-17T03:30:00Z", 1], // 09:00
      ["2026-11-17T15:29:00Z", 1], // 20:59
      ["2026-11-17T15:30:00Z", 0], // 21:00
    ];
    for (const [iso, expected] of cases) {
      const t = setup(1);
      t.advance(Date.parse(iso) - Date.parse("2026-11-17T10:00:00Z"));
      await dispatchDueCampaigns({ deps: t.deps });
      assert.equal(t.dialed.length, expected, iso);
    }
  });
});

describe("campaign dispatch — the database emergency stop (GATE C4 H3)", () => {
  const STOP = "outbound.calling_paused";
  const setStop = (t: ReturnType<typeof setup>, enabled: unknown) => {
    const rows = (t.db.tables["platform_settings"] ??= []);
    const row = rows.find((r) => r["key"] === STOP);
    if (row) row["value"] = { enabled };
    else rows.push({ key: STOP, value: { enabled } });
  };
  /**
   * Finalization as apply_call_campaign_outcome applies it: the call's outcome
   * (here: a retry) reaches the contact only while the contact still points at
   * that exact call. Records what the contact looked like when it ran.
   */
  const guardedFinalize = (t: ReturnType<typeof setup>) => {
    const seen: { callId: string; contactCallId: unknown }[] = [];
    t.deps.finalize = async (callId) => {
      const call = t.table("call_logs").find((c) => c["id"] === callId)!;
      const cc = t.table("campaign_contacts").find((c) => c["id"] === call["campaign_contact_id"])!;
      seen.push({ callId, contactCallId: cc["current_call_id"] });
      if (
        cc["current_call_id"] === callId &&
        ["calling", "outcome_unknown"].includes(String(cc["status"]))
      )
        Object.assign(cc, { status: "retry_scheduled", next_attempt_at: "2026-11-17T11:00:00Z" });
    };
    return seen;
  };
  /** Pulls the stop right after the first admission writes its call row. */
  const stopAfterFirstAdmission = (t: ReturnType<typeof setup>) => {
    const admit = t.deps.admitCampaignCall;
    let armed = true;
    t.deps.admitCampaignCall = async (req) => {
      const r = await admit(req);
      if (armed) setStop(t, true);
      armed = false;
      return r;
    };
  };

  test("active before the run: nothing is claimed, admitted, written or dialled", async () => {
    const t = setup(3);
    setStop(t, true);
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    assert.equal(t.admission.requests.length, 0);
    assert.equal(t.table("call_logs").length, 0);
    for (const cc of t.table("campaign_contacts")) {
      assert.equal(cc["status"], "pending");
      assert.equal(cc["attempts"], 0);
    }
  });

  test("inactive ({enabled: false}) or no row: the normal path dials", async () => {
    const off = setup(2);
    setStop(off, false);
    await dispatchDueCampaigns({ deps: off.deps });
    assert.equal(off.dialed.length, 2);
    const none = setup(2);
    await dispatchDueCampaigns({ deps: none.deps });
    assert.equal(none.dialed.length, 2);
  });

  test("a failed read of the stop counts as stopped (fails closed)", async () => {
    const t = setup(1);
    const client = t.deps.supabaseAdmin as unknown as { from: (table: string) => unknown };
    const from = client.from.bind(client);
    client.from = (table: string) =>
      table === "platform_settings"
        ? {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: { message: "timeout" } }),
              }),
            }),
          }
        : from(table);
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    assert.equal(t.table("call_logs").length, 0);
  });

  test("set after admission, before the dial: no provider request, no charge, no retry, contact not stuck", async () => {
    const t = setup(3);
    const finalized = guardedFinalize(t);
    stopAfterFirstAdmission(t);
    await dispatchDueCampaigns({ deps: t.deps });

    assert.equal(t.dialed.length, 0, "no provider request");
    assert.equal(t.table("call_logs").length, 1, "the batch stops at the first contact");
    const call = t.table("call_logs")[0]!;
    assert.equal(call["status"], "failed");
    assert.equal(call["resolution_source"], "start_failure", "never started: no charge, no budget");
    assert.match(String(call["failure_reason"]), /emergency_stop/);
    assert.ok(call["ended_at"]);

    const cc = t.table("campaign_contacts").find((c) => c["id"] === call["campaign_contact_id"])!;
    assert.equal(cc["status"], "pending", "back exactly as it was, not calling");
    assert.equal(cc["attempts"], 0, "the attempt is not consumed");
    assert.equal(cc["current_call_id"], null);
    assert.equal(cc["next_attempt_at"], null, "no retry scheduled");

    // Finalized once, after the contact was given back: its "failed" outcome
    // cannot reach the contact.
    assert.deepEqual(finalized, [{ callId: call["id"], contactCallId: null }]);
    assert.equal(t.table("campaign_contacts").filter((c) => c["status"] === "calling").length, 0);
  });

  test("the stop also ends the run for every other campaign", async () => {
    const t = setup(1);
    t.table("campaigns").push({ ...t.table("campaigns")[0]!, id: "camp_2" });
    t.table("contacts").push({
      id: "contact_x",
      organization_id: ORG,
      phone: "+919876543299",
      opted_out: false,
    });
    t.table("campaign_contacts").push({
      id: "cc_x",
      campaign_id: "camp_2",
      organization_id: ORG,
      contact_id: "contact_x",
      status: "pending",
      attempts: 0,
      next_attempt_at: null,
      variables: {},
      created_at: "2026-11-17T10:00:09Z",
    });
    stopAfterFirstAdmission(t);
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    assert.equal(t.admission.requests.length, 1, "camp_2 is never admitted");
    assert.equal(
      t.table("campaign_contacts").find((c) => c["id"] === "cc_x")!["status"],
      "pending",
    );
  });

  test("while it stays on, later runs dial nothing; once lifted, the contact is dialled exactly once", async () => {
    const t = setup(1);
    stopAfterFirstAdmission(t);
    await dispatchDueCampaigns({ deps: t.deps });
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    assert.equal(t.admission.requests.length, 1, "nothing admitted while stopped");

    setStop(t, false);
    await dispatchDueCampaigns({ deps: t.deps });
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 1, "one call, no duplicate");
    const cc = t.table("campaign_contacts")[0]!;
    assert.equal(cc["attempts"], 1, "only the call that was placed counts");
    assert.equal(cc["status"], "calling");
  });

  test("admission refusing with outbound_paused gives the contact back and ends the run", async () => {
    const t = setup(3);
    t.admission.refuse = "outbound_paused";
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(t.dialed.length, 0);
    assert.equal(t.admission.requests.length, 1);
    for (const cc of t.table("campaign_contacts")) {
      assert.equal(cc["status"], "pending");
      assert.equal(cc["attempts"], 0);
      assert.equal(cc["current_call_id"] ?? null, null);
    }
  });

  test("the stop is the last database read before the provider request", async () => {
    const t = setup(1);
    const order: string[] = [];
    const client = t.deps.supabaseAdmin as unknown as { from: (table: string) => unknown };
    const from = client.from.bind(client);
    client.from = (table: string) => {
      order.push(table);
      return from(table);
    };
    const dial = t.deps.adapter!.createInstantOutbound;
    t.deps.adapter = {
      createInstantOutbound: async (input) => {
        order.push("DIAL");
        return dial(input);
      },
    };
    await dispatchDueCampaigns({ deps: t.deps });
    assert.equal(order[order.indexOf("DIAL") - 1], "platform_settings");
  });
});
