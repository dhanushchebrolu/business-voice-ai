import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dispatchDueCampaigns, type DispatchDeps } from "./campaign-dispatch.server.ts";
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
const UNRESOLVED = ["initiated", "outcome_unknown"];
const TERMINAL = ["completed", "failed", "busy", "no_answer", "cancelled"];

function setup(contactCount: number) {
  const contacts: Row[] = [];
  const campaignContacts: Row[] = [];
  for (let i = 1; i <= contactCount; i++) {
    contacts.push({
      id: `contact_${i}`,
      phone: `+9198765432${String(i).padStart(2, "0")}`,
      opted_out: false,
    });
    campaignContacts.push({
      id: `cc_${i}`,
      campaign_id: CAMPAIGN,
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
          sarvam_outbound_ready_app_id: "app_1",
          sarvam_outbound_ready_version: 2,
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
  const onWalletCheck: { fn?: () => void } = {};
  const failDial: { err?: Error | undefined } = {};
  const deps: DispatchDeps = {
    supabaseAdmin: db.client,
    checkTelephonyAccess: async () =>
      ({
        allowed: true,
        reason: null,
        phoneNumber: { provider: "sarvam", e164: "+911111111111", connection_id: "conn_1" },
      }) as never,
    walletCanAffordOutbound: async () => {
      onWalletCheck.fn?.();
      return true;
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
  const table = (name: string) => db.tables[name] ?? [];
  const advance = (ms: number) => {
    clock += ms;
  };
  return { db, deps, dialed, requests, table, onDial, onWalletCheck, failDial, advance };
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
    // The wallet check runs after the running-check and before the claim.
    t.onWalletCheck.fn = () => setCampaignStatus(t, "paused");
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
    t.onWalletCheck.fn = () => setCampaignStatus(t, "cancelled");
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

describe("campaign dispatch — the customer's one agent in outbound mode", () => {
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

  test("each call uses the same agent mapping, marks itself outbound and carries the campaign objective", async () => {
    const t = setup(1);
    t.table("campaigns")[0]!["objective"] = "Remind about the free dental camp";
    t.table("campaigns")[0]!["call_instructions"] = "Keep it under a minute.";
    // A contact column can never change the direction or the call id.
    t.table("campaign_contacts")[0]!["variables"] = {
      call_direction: "inbound",
      clickai_call_id: "x",
      first_name: "A",
    };
    await dispatchDueCampaigns({ deps: t.deps });
    const req = t.requests[0]!;
    assert.equal(req["appId"], "app_1");
    assert.equal(req["appVersion"], 2);
    const vars = req["agentVariables"] as Record<string, unknown>;
    assert.equal(vars["call_direction"], "outbound");
    assert.equal(vars["clickai_call_id"], t.table("call_logs")[0]!["id"]);
    assert.equal(vars["campaign_objective"], "Remind about the free dental camp");
    assert.equal(vars["campaign_instructions"], "Keep it under a minute.");
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
    assert.equal("campaign_objective" in vars, false);
    assert.equal("campaign_instructions" in vars, false);
    assert.equal(vars["city"], "Pune");
  });
});
