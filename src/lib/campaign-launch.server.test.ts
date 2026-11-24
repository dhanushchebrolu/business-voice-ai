import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchCampaignFor } from "./campaign-launch.server.ts";
import {
  evaluateCampaignLaunchReadiness,
  type ReadinessDeps,
} from "./campaign-launch-readiness.server.ts";
import { callerNumberIneligibility, isEligibleCallerNumber } from "./campaign-wizard.ts";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";

/**
 * Campaign launch, behaviourally: every readiness check runs server-side, any
 * failure leaves the campaign exactly as it was (and is audited), a ready
 * campaign moves to running once, and a repeat launch is not an error.
 * In-memory database, fake platform switches; nothing reaches a provider.
 */

type Row = Record<string, unknown>;
const ORG = "org_a";
const OTHER = "org_b";
const CAMPAIGN = "camp_1";
const REVIEWED_CONTEXT = {
  version: 1,
  objective: "Invite patients for a check-up",
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

function world(
  over: { campaign?: Row; org?: Row; number?: Row; agent?: Row; contacts?: Row[] } = {},
) {
  return memorySupabase({
    tables: {
      organizations: [
        { id: ORG, campaign_dispatch_enabled: true, ...over.org },
        { id: OTHER, campaign_dispatch_enabled: true },
      ],
      campaigns: [
        {
          id: CAMPAIGN,
          organization_id: ORG,
          status: "draft",
          dispatch_mode: "instant_outbound_fallback",
          agent_config_id: "agent_1",
          phone_number_id: "num_1",
          context: REVIEWED_CONTEXT,
          context_reviewed_at: "2026-11-24T00:00:00Z",
          max_attempts: 2,
          retry_after_minutes: 120,
          retry_statuses: ["no_answer", "busy", "failed"],
          budget_limit: null,
          ...over.campaign,
        },
      ],
      agent_configs: [
        {
          id: "agent_1",
          organization_id: ORG,
          sarvam_app_id: "inbound-app",
          sarvam_outbound_app_id: "outbound-app",
          sarvam_outbound_app_version: 2,
          sarvam_outbound_ready_app_id: "outbound-app",
          sarvam_outbound_ready_version: 2,
          sarvam_outbound_max_call_seconds: 300,
          ...over.agent,
        },
      ],
      phone_numbers: [
        {
          id: "num_1",
          e164: "+917900000061",
          organization_id: ORG,
          status: "active",
          provider: "sarvam",
          outbound_enabled: true,
          connection_id: "conn_1",
          ...over.number,
        },
      ],
      telephony_connections: [
        {
          id: "conn_1",
          organization_id: ORG,
          provider: "sarvam",
          provider_connection_id: "sv-conn",
        },
      ],
      contacts: (over.contacts ?? [
        { id: "k1", organization_id: ORG, phone: "+919800000001", opted_out: false },
        { id: "k2", organization_id: ORG, phone: "+919800000002", opted_out: false },
      ]) as Row[],
      campaign_contacts: (over.contacts ?? [{ id: "k1" }, { id: "k2" }]).map((k, i) => ({
        id: `cc_${i + 1}`,
        campaign_id: CAMPAIGN,
        organization_id: ORG,
        contact_id: k["id"],
        status: "pending",
      })),
      call_logs: [],
      audit_logs: [],
    },
  });
}

function deps(
  db: ReturnType<typeof world>,
  over: Partial<Omit<ReadinessDeps, "db">> = {},
): ReadinessDeps {
  return {
    db: db.client,
    killSwitchOn: () => false,
    dispatchEnabled: () => true,
    emergencyStopActive: async () => false,
    providerReady: () => ({ ok: true }),
    isAllowlisted: () => true,
    numberGate: async () => ({ allowed: true }),
    walletCanAfford: async () => true,
    ...over,
  };
}

const status = (db: ReturnType<typeof world>) => (db.tables["campaigns"]![0] as Row)["status"];
const audits = (db: ReturnType<typeof world>) =>
  (db.tables["audit_logs"] ?? []).map((a) => (a as Row)["action"]);

async function blockedBy(db: ReturnType<typeof world>, d: ReadinessDeps) {
  const r = await launchCampaignFor(d, ORG, "user_1", CAMPAIGN);
  assert.equal(r.ok, false, "launch must be refused");
  assert.equal(status(db), "draft", "a refused launch changes nothing");
  assert.deepEqual(audits(db), ["CAMPAIGN_LAUNCH_BLOCKED"]);
  return (r as { blockers: { key: string }[] }).blockers.map((b) => b.key);
}

describe("campaign launch: a ready campaign starts exactly once", () => {
  test("every check passes: running, launched_at set, audited", async () => {
    const db = world();
    const r = await launchCampaignFor(deps(db), ORG, "user_1", CAMPAIGN);
    assert.deepEqual(r, { ok: true, status: "running", alreadyRunning: false });
    assert.equal(status(db), "running");
    assert.ok((db.tables["campaigns"]![0] as Row)["launched_at"]);
    assert.deepEqual(audits(db), ["CAMPAIGN_LAUNCHED"]);
  });

  test("a repeated launch (double click, lost response) answers ok and changes nothing", async () => {
    const db = world();
    await launchCampaignFor(deps(db), ORG, "user_1", CAMPAIGN);
    const again = await launchCampaignFor(deps(db), ORG, "user_1", CAMPAIGN);
    assert.deepEqual(again, { ok: true, status: "running", alreadyRunning: true });
    assert.deepEqual(audits(db), ["CAMPAIGN_LAUNCHED"]);
  });

  test("paused campaigns resume through the same checks", async () => {
    const db = world({ campaign: { status: "paused" } });
    assert.equal((await launchCampaignFor(deps(db), ORG, "user_1", CAMPAIGN)).ok, true);
    assert.equal(status(db), "running");
  });

  test("another organization's campaign is not found (tenant isolation)", async () => {
    const db = world();
    await assert.rejects(
      launchCampaignFor(deps(db), OTHER, "user_1", CAMPAIGN),
      /Campaign not found/,
    );
    assert.equal(status(db), "draft");
  });
});

describe("campaign launch: every guard refuses before anything changes", () => {
  const cases: [
    string,
    (db: ReturnType<typeof world>) => ReadinessDeps,
    string,
    Parameters<typeof world>[0]?,
  ][] = [
    ["the global kill switch", (db) => deps(db, { killSwitchOn: () => true }), "kill_switch"],
    [
      "the emergency stop",
      (db) => deps(db, { emergencyStopActive: async () => true }),
      "emergency_stop",
    ],
    [
      "campaign dispatch switched off (CAMPAIGN_DISPATCH_ENABLED)",
      (db) => deps(db, { dispatchEnabled: () => false }),
      "dispatch_available",
    ],
    [
      "the provider not configured",
      (db) => deps(db, { providerReady: () => ({ ok: false, reason: "x" }) }),
      "provider",
    ],
    [
      "the workspace not authorized for campaigns",
      deps,
      "workspace_authorized",
      { org: { campaign_dispatch_enabled: false } },
    ],
    [
      "Sarvam-paced (cohort) mode",
      deps,
      "dispatch_mode",
      { campaign: { dispatch_mode: "sarvam_campaign" } },
    ],
    [
      "instructions saved only as a draft",
      deps,
      "instructions",
      { campaign: { context_reviewed_at: null } },
    ],
    [
      "unsafe retry settings",
      deps,
      "retry_settings",
      { campaign: { retry_statuses: ["completed"] } },
    ],
    ["no agent", deps, "agent", { campaign: { agent_config_id: null } }],
    [
      "the inbound agent as outbound",
      deps,
      "agent",
      { agent: { sarvam_outbound_app_id: "inbound-app" } },
    ],
    [
      "no maximum call length",
      deps,
      "agent",
      { agent: { sarvam_outbound_max_call_seconds: null } },
    ],
    ["another workspace's agent", deps, "agent", { agent: { organization_id: OTHER } }],
    ["no caller number", deps, "caller_number", { campaign: { phone_number_id: null } }],
    [
      "an inbound-only caller number",
      deps,
      "caller_number",
      { number: { outbound_enabled: false } },
    ],
    ["a non-Sarvam caller number", deps, "caller_number", { number: { provider: "vobiz" } }],
    ["a released caller number", deps, "caller_number", { number: { status: "released" } }],
    [
      "another workspace's caller number",
      deps,
      "caller_number",
      { number: { organization_id: OTHER } },
    ],
    ["a number without a connection", deps, "caller_number", { number: { connection_id: null } }],
    [
      "the number gate (entitlement / lifecycle)",
      (db) => deps(db, { numberGate: async () => ({ allowed: false, reason: "Locked" }) }),
      "caller_number",
    ],
    ["no contacts", deps, "contacts", { contacts: [] }],
    [
      "every contact opted out",
      deps,
      "contacts",
      { contacts: [{ id: "k1", organization_id: ORG, phone: "+919800000001", opted_out: true }] },
    ],
    [
      "a contact outside the pilot allowlist",
      (db) => deps(db, { isAllowlisted: (n) => n.endsWith("01") }),
      "pilot_allowlist",
    ],
    ["an empty wallet", (db) => deps(db, { walletCanAfford: async () => false }), "wallet"],
  ];
  for (const [name, makeDeps, key, over] of cases) {
    test(`${name} -> ${key}`, async () => {
      const db = world(over);
      const keys = await blockedBy(db, makeDeps(db));
      assert.ok(keys.includes(key), `expected ${key} in ${keys.join(",")}`);
    });
  }

  test("a spent campaign budget -> budget", async () => {
    const db = world({ campaign: { budget_limit: 1000 } });
    db.tables["call_logs"]!.push({
      campaign_id: CAMPAIGN,
      organization_id: ORG,
      status: "completed",
      customer_charge: 1000,
      billing_applied_at: "2026-11-24T00:00:00Z",
      billing_cap_minutes: 5,
      billing_rate_per_minute: 400,
      resolution_source: "provider",
    });
    assert.ok((await blockedBy(db, deps(db))).includes("budget"));
  });

  test("a cancelled campaign cannot be launched", async () => {
    const db = world({ campaign: { status: "cancelled" } });
    const r = await launchCampaignFor(deps(db), ORG, "user_1", CAMPAIGN);
    assert.equal(r.ok, false);
    assert.equal(status(db), "cancelled");
  });

  test("all failing checks are reported together, with an actionable detail each", async () => {
    const db = world({
      campaign: { phone_number_id: null },
      org: { campaign_dispatch_enabled: false },
    });
    const r = await evaluateCampaignLaunchReadiness(
      deps(db, { dispatchEnabled: () => false }),
      ORG,
      CAMPAIGN,
    );
    const failing = r!.checks.filter((c) => !c.ok);
    assert.deepEqual(failing.map((c) => c.key).sort(), [
      "caller_number",
      "dispatch_available",
      "workspace_authorized",
    ]);
    for (const c of failing)
      assert.ok(c.detail && c.detail.length > 10, `${c.key} explains itself`);
  });

  test("an organization row that cannot be read fails closed", async () => {
    const db = world({ org: { campaign_dispatch_enabled: undefined } });
    const r = await evaluateCampaignLaunchReadiness(deps(db), ORG, CAMPAIGN);
    assert.equal(r!.checks.find((c) => c.key === "workspace_authorized")!.ok, false);
  });
});

describe("caller-number eligibility (shared by the picker, the save and launch)", () => {
  test("only an active, outbound-enabled Sarvam number is eligible, each refusal explained", () => {
    assert.equal(
      callerNumberIneligibility({ status: "active", outbound_enabled: true, provider: "sarvam" }),
      null,
    );
    assert.match(
      callerNumberIneligibility({
        status: "suspended",
        outbound_enabled: true,
        provider: "sarvam",
      })!,
      /suspended/,
    );
    assert.match(
      callerNumberIneligibility({ status: "active", outbound_enabled: false, provider: "sarvam" })!,
      /inbound only/,
    );
    assert.match(
      callerNumberIneligibility({ status: "active", outbound_enabled: true, provider: "vobiz" })!,
      /Sarvam numbers/,
    );
    assert.equal(
      isEligibleCallerNumber({ status: "active", outbound_enabled: true, provider: "exotel" }),
      false,
    );
  });
});

// The wallet: the campaign page's checklist only reads the balance; launch
// re-checks with wallet_can_afford, which takes the organization lock that
// admissions and debits take; and the money is enforced per call at admission
// (campaign_context_engine.pg.test.ts proves the lock and the concurrency in SQL).
describe("campaign launch: the wallet is read on the page and enforced on launch", () => {
  const read = (f: string) =>
    readFileSync(new URL(f, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const fns = read("./campaigns.functions.ts");
  const readinessSrc = read("./campaign-launch-readiness.server.ts");
  const guard = read("./telephony-guard.server.ts");
  const fnBody = (src: string, name: string) => {
    const start = src.indexOf(`export async function ${name}(`);
    return src.slice(start, src.indexOf("\n}\n", start));
  };

  test("opening the campaign page uses the read-only wallet check, which takes no lock", () => {
    const view = fns.slice(fns.indexOf("export const getCampaignLaunchReadiness"));
    assert.match(view.slice(0, view.indexOf("});")), /defaultReadinessDeps\("view"\)/);
    assert.match(
      readinessSrc,
      /purpose === "launch" \? walletCanAffordOutbound\(orgId\) : walletBalanceCoversOutbound\(orgId\)/,
    );
    const reader = fnBody(guard, "walletBalanceCoversOutbound");
    assert.match(reader, /\.from\("wallet_balances"\)\s*\.select\("balance"\)/);
    assert.doesNotMatch(reader, /\.rpc\(|wallet_can_afford|FOR UPDATE/);
  });

  test("launching uses the authoritative check: wallet_can_afford, under the organization lock", () => {
    const launch = fns.slice(fns.indexOf("export const launchCampaign"));
    assert.match(launch.slice(0, launch.indexOf("});")), /defaultReadinessDeps\("launch"\)/);
    assert.match(fnBody(guard, "walletCanAffordOutbound"), /\.rpc\("wallet_can_afford"/);
  });

  test("insufficient balance on the launch check blocks launch, even when the page's read said it was fine", async () => {
    const db = world();
    let lockingChecks = 0;
    const launchDeps = deps(db, {
      walletCanAfford: async () => {
        lockingChecks++;
        return false; // spent between viewing the page and pressing Launch
      },
    });
    const keys = await blockedBy(db, launchDeps);
    assert.deepEqual(keys, ["wallet"]);
    assert.equal(lockingChecks, 1);
  });

  test("simultaneous launches of one campaign: one launch, the others answer already running", async () => {
    const db = world();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => launchCampaignFor(deps(db), ORG, "user_1", CAMPAIGN)),
    );
    assert.ok(results.every((r) => r.ok));
    assert.equal(
      results.filter((r) => r.ok && !r.alreadyRunning).length,
      1,
      "exactly one launch moves the campaign",
    );
    assert.deepEqual(audits(db), ["CAMPAIGN_LAUNCHED"]);
  });
});
