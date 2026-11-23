import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import { saveCampaignConfigurationFor } from "./campaign-config.server.ts";
import { wizardStateFromCampaign, type WizardState } from "./campaign-wizard.ts";

type Row = Record<string, unknown>;
const ORG = "org_a";
const OTHER = "org_b";
const NOW = new Date("2026-11-21T06:00:00Z");

const WIZARD: WizardState = {
  details: { name: "QA TEST - Check-ups", objective: "Remind patients", description: "QA only" },
  phoneNumberId: "",
  instructions: {
    agentConfigId: "agent_a",
    language: "",
    audience: "Patients due a check-up",
    talkingPoints: "Open on Saturdays",
    questions: "Would you like to book?",
    desiredOutcome: "They book",
    interestedHandling: "Offer free times",
    uninterestedHandling: "Thank them",
    callbackHandling: "",
    closing: "Goodbye",
    tone: "Warm",
    extraInstructions: "Mention parking",
  },
  schedule: {
    mode: "scheduled",
    startDate: "2026-12-01",
    endDate: "",
    timezone: "Asia/Kolkata",
    days: [1, 2, 3],
    windowStart: "10:00",
    windowEnd: "17:00",
  },
  controls: {
    maxAttempts: 2,
    retryAfterMinutes: 60,
    retryStatuses: ["no_answer"],
    budgetRupees: "500",
  },
};

function setup(campaigns: Row[] = []) {
  const db = memorySupabase({
    tables: {
      campaigns,
      businesses: [
        { id: "biz_a", organization_id: ORG },
        { id: "biz_b", organization_id: OTHER },
      ],
      agent_configs: [
        { id: "agent_a", organization_id: ORG },
        { id: "agent_b", organization_id: OTHER },
      ],
      phone_numbers: [
        { id: "num_a", organization_id: ORG, status: "active", outbound_enabled: true },
        { id: "num_a_off", organization_id: ORG, status: "active", outbound_enabled: false },
        { id: "num_b", organization_id: OTHER, status: "active", outbound_enabled: true },
      ],
    },
    // Mirrors idx_campaigns_org_idempotency_key (20261123090000): unique per organization,
    // NULL keys never conflict.
    uniques: [
      {
        table: "campaigns",
        name: "idx_campaigns_org_idempotency_key",
        key: (r) =>
          r["idempotency_key"]
            ? `${String(r["organization_id"])}|${String(r["idempotency_key"])}`
            : null,
      },
    ],
  });
  return { db, admin: db.client, campaigns: () => db.tables["campaigns"] ?? [] };
}

/** The version every fixture campaign starts at; edits send it unless a test says otherwise. */
const V0 = "2026-11-20T00:00:00.000000+00:00";

const save = (
  t: ReturnType<typeof setup>,
  input: {
    campaignId?: string;
    wizard: unknown;
    confirm: boolean;
    idempotencyKey?: string;
    expectedUpdatedAt?: string;
  },
  org = ORG,
) =>
  saveCampaignConfigurationFor(
    t.admin,
    org,
    "user_1",
    input.campaignId && !("expectedUpdatedAt" in input)
      ? { ...input, expectedUpdatedAt: V0 }
      : input,
    NOW,
  );

const existing = (over: Row = {}): Row => ({
  id: "camp_1",
  organization_id: ORG,
  status: "draft",
  name: "Old name",
  schedule: {},
  context: null,
  context_reviewed_at: null,
  updated_at: V0,
  ...over,
});

describe("Save as draft keeps everything entered", () => {
  test("instructions are stored (unconfirmed), with every other setting", async () => {
    const t = setup();
    const r = await save(t, { wizard: WIZARD, confirm: false });
    assert.equal(r.created, true);
    const row = t.campaigns()[0]!;
    assert.equal(row["organization_id"], ORG);
    assert.equal(row["business_id"], "biz_a");
    assert.equal(row["created_by"], "user_1");
    assert.equal(row["context_reviewed_at"], null, "a draft's instructions are not confirmed");
    const ctx = row["context"] as Record<string, unknown>;
    assert.equal(ctx["desiredOutcome"], "They book");
    assert.equal(ctx["objectionHandling"], "Thank them");
    assert.match(String(ctx["extraInstructions"]), /If they are interested: Offer free times/);
    assert.equal(row["agent_config_id"], "agent_a");
    assert.deepEqual(row["schedule"], {
      startDate: "2026-12-01",
      windowStart: "10:00",
      windowEnd: "17:00",
      days: [1, 2, 3],
      timezone: "Asia/Kolkata",
    });
    assert.equal(row["max_attempts"], 2);
    assert.equal(row["retry_after_minutes"], 60);
    assert.deepEqual(row["retry_statuses"], ["no_answer"]);
    assert.equal(row["budget_limit"], 50000);
    assert.equal(row["status"] ?? "draft", "draft");
    // Everything entered comes back on the edit page.
    assert.deepEqual(wizardStateFromCampaign(row as never), WIZARD);
  });

  test("a draft may leave the agent and caller number unchosen", async () => {
    const t = setup();
    await save(t, {
      wizard: { ...WIZARD, instructions: { ...WIZARD.instructions, agentConfigId: "" } },
      confirm: false,
    });
    assert.equal(t.campaigns()[0]!["agent_config_id"], null);
    assert.equal(t.campaigns()[0]!["phone_number_id"], null);
  });

  test("Save campaign stores the same values and confirms the instructions; it needs an agent", async () => {
    const t = setup();
    await save(t, { wizard: WIZARD, confirm: true });
    const row = t.campaigns()[0]!;
    assert.equal(row["context_reviewed_at"], NOW.toISOString());
    assert.equal(row["context_reviewed_by"], "user_1");
    assert.deepEqual(wizardStateFromCampaign(row as never), WIZARD);
    await assert.rejects(
      save(t, {
        wizard: { ...WIZARD, instructions: { ...WIZARD.instructions, agentConfigId: "" } },
        confirm: true,
      }),
      /Choose the AI agent/,
    );
  });
});

describe("editing updates the same campaign", () => {
  test("an edit rewrites the existing row; no second campaign is created", async () => {
    const t = setup([existing()]);
    const r = await save(t, { campaignId: "camp_1", wizard: WIZARD, confirm: false });
    assert.equal(r.campaignId, "camp_1");
    assert.equal(r.created, false);
    assert.equal(r.outcome, "updated");
    assert.notEqual(r.updatedAt, V0, "the version moved");
    assert.equal(t.campaigns().length, 1);
    assert.equal(t.campaigns()[0]!["name"], "QA TEST - Check-ups");
  });

  test("a caller number can be added to an existing draft", async () => {
    const t = setup([existing()]);
    await save(t, {
      campaignId: "camp_1",
      wizard: { ...WIZARD, phoneNumberId: "num_a" },
      confirm: false,
    });
    assert.equal(t.campaigns()[0]!["phone_number_id"], "num_a");
    assert.equal(t.campaigns()[0]!["status"], "draft", "choosing a number starts nothing");
  });

  test("a number that is not enabled for outbound calls, or is another workspace's, is refused", async () => {
    const t = setup([existing()]);
    await assert.rejects(
      save(t, {
        campaignId: "camp_1",
        wizard: { ...WIZARD, phoneNumberId: "num_a_off" },
        confirm: false,
      }),
      /not enabled for outbound/,
    );
    await assert.rejects(
      save(t, {
        campaignId: "camp_1",
        wizard: { ...WIZARD, phoneNumberId: "num_b" },
        confirm: false,
      }),
      /does not belong to this workspace/,
    );
    assert.equal(t.campaigns()[0]!["phone_number_id"], undefined, "nothing was written");
  });

  test("another workspace's agent is refused", async () => {
    const t = setup();
    await assert.rejects(
      save(t, {
        wizard: { ...WIZARD, instructions: { ...WIZARD.instructions, agentConfigId: "agent_b" } },
        confirm: false,
      }),
      /does not belong to this workspace/,
    );
    assert.equal(t.campaigns().length, 0);
  });

  test("a campaign of another organization cannot be edited, even by id", async () => {
    const t = setup([existing({ organization_id: OTHER })]);
    await assert.rejects(
      save(t, { campaignId: "camp_1", wizard: WIZARD, confirm: false }),
      /Campaign not found/,
    );
    assert.equal(t.campaigns()[0]!["name"], "Old name");
  });

  test("running campaigns cannot be changed underneath the dispatcher; finished ones not at all", async () => {
    for (const status of ["running", "queued", "completed", "cancelled", "failed"]) {
      const t = setup([existing({ status })]);
      await assert.rejects(save(t, { campaignId: "camp_1", wizard: WIZARD, confirm: false }));
      assert.equal(t.campaigns()[0]!["name"], "Old name", `${status} unchanged`);
    }
  });

  test("scheduled and paused campaigns can be edited; status is never changed", async () => {
    for (const status of ["scheduled", "paused"]) {
      const t = setup([existing({ status })]);
      await save(t, { campaignId: "camp_1", wizard: WIZARD, confirm: true });
      assert.equal(t.campaigns()[0]!["status"], status);
      assert.equal(t.campaigns()[0]!["launched_at"], undefined);
    }
  });

  test("invalid values are refused before anything is written", async () => {
    const t = setup([existing()]);
    await assert.rejects(
      save(t, {
        campaignId: "camp_1",
        wizard: { ...WIZARD, controls: { ...WIZARD.controls, maxAttempts: 50 } },
        confirm: false,
      }),
      /Please fix/,
    );
    assert.equal(t.campaigns()[0]!["name"], "Old name");
  });
});

describe("source: saving configuration cannot dial or change dispatch", () => {
  const code = readFileSync(new URL("./campaign-config.server.ts", import.meta.url), "utf8")
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  test("no outbound, dispatch or provider code is reachable from the configuration save", () => {
    assert.doesNotMatch(
      code,
      /dispatch|createInstantOutbound|sarvam|vobiz|launchCampaign|status:\s*"|launched_at/i,
    );
  });

  const fns = readFileSync(new URL("./campaigns.functions.ts", import.meta.url), "utf8");
  const handler = fns.slice(fns.indexOf("export const saveCampaignConfiguration"));
  const body = handler.slice(0, handler.indexOf("export const CAMPAIGN_LAUNCH_UNAVAILABLE"));
  test("the server function authorizes the organization itself (owner or admin), never from the UI", () => {
    assert.match(body, /\.middleware\(\[requireSupabaseAuth\]\)/);
    assert.match(body, /campaignOrgId\(context, data\.campaignId, true\)/);
    assert.match(
      body,
      /requireRole\(\s*\{[^}]*\},\s*context\.userId,\s*data\.organizationId!,\s*true,/,
    );
  });

  test("the server function passes the creation key through; the organization never comes from it", () => {
    assert.match(body, /idempotencyKey: data\.idempotencyKey,/);
  });
});

/**
 * Retry-safe creation. The in-memory database enforces a named unique index the
 * way Postgres does (organization + key, NULLs never conflict); the real index
 * is proven in supabase/migrations/campaign_creation_idempotency.pg.test.ts and
 * on the local QA database.
 */
describe("campaign creation is idempotent per creation key", () => {
  const KEY = "cmp_0123456789abcdef0123456789abcdef";

  test("the first request creates the campaign and stores the key", async () => {
    const t = setup();
    const r = await save(t, { wizard: WIZARD, confirm: false, idempotencyKey: KEY });
    assert.equal(r.created, true);
    assert.equal(r.outcome, "created");
    assert.equal(t.campaigns().length, 1);
    assert.equal(t.campaigns()[0]!["idempotency_key"], KEY);
  });

  test("the same key again (retry, lost response, resubmission) returns the same campaign", async () => {
    const t = setup();
    const first = await save(t, { wizard: WIZARD, confirm: false, idempotencyKey: KEY });
    const again = await save(t, { wizard: WIZARD, confirm: false, idempotencyKey: KEY });
    assert.equal(again.campaignId, first.campaignId);
    assert.equal(again.outcome, "existing");
    assert.equal(again.created, false);
    assert.equal(t.campaigns().length, 1);
  });

  test("a replay never changes the campaign that already exists", async () => {
    const t = setup();
    await save(t, { wizard: WIZARD, confirm: false, idempotencyKey: KEY });
    const before = JSON.stringify(t.campaigns()[0]);
    const changed = { ...WIZARD, details: { ...WIZARD.details, name: "Different name" } };
    await save(t, { wizard: changed, confirm: true, idempotencyKey: KEY });
    assert.equal(JSON.stringify(t.campaigns()[0]), before);
  });

  test("the same key in another organization is a different campaign and reveals nothing", async () => {
    const t = setup();
    const mine = await save(t, { wizard: WIZARD, confirm: false, idempotencyKey: KEY });
    const theirs = await save(
      t,
      {
        wizard: { ...WIZARD, instructions: { ...WIZARD.instructions, agentConfigId: "agent_b" } },
        confirm: false,
        idempotencyKey: KEY,
      },
      OTHER,
    );
    assert.equal(theirs.outcome, "created");
    assert.notEqual(theirs.campaignId, mine.campaignId);
    assert.equal(t.campaigns().length, 2);
  });

  test("different keys create different campaigns (names may repeat)", async () => {
    const t = setup();
    const a = await save(t, { wizard: WIZARD, confirm: false, idempotencyKey: KEY });
    const b = await save(t, {
      wizard: WIZARD,
      confirm: false,
      idempotencyKey: "cmp_ffffffffffffffffffffffffffffffff",
    });
    assert.notEqual(a.campaignId, b.campaignId);
    assert.equal(t.campaigns().length, 2);
  });

  test("creating without a key (legacy path) still works; NULL keys never conflict", async () => {
    const t = setup([existing({ id: "legacy_1", idempotency_key: null })]);
    await save(t, { wizard: WIZARD, confirm: false });
    await save(t, { wizard: WIZARD, confirm: false });
    assert.equal(t.campaigns().length, 3);
    assert.equal(t.campaigns()[1]!["idempotency_key"], undefined);
  });

  test("an edit never writes or uses a creation key, and never creates a campaign", async () => {
    const t = setup([existing()]);
    const r = await save(t, {
      campaignId: "camp_1",
      wizard: WIZARD,
      confirm: false,
      idempotencyKey: KEY,
    });
    assert.equal(r.outcome, "updated");
    assert.equal(t.campaigns().length, 1);
    assert.equal(t.campaigns()[0]!["idempotency_key"], undefined);
  });

  test("concurrent requests with the same key end with one campaign (in-memory simulation)", async () => {
    const t = setup();
    const results = await Promise.all([
      save(t, { wizard: WIZARD, confirm: false, idempotencyKey: KEY }),
      save(t, { wizard: WIZARD, confirm: false, idempotencyKey: KEY }),
    ]);
    assert.equal(t.campaigns().length, 1);
    assert.equal(results[0]!.campaignId, results[1]!.campaignId);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ["created", "existing"]);
  });

  test("other database errors are reported, not mistaken for a replay", async () => {
    const t = setup();
    t.db.failNext("campaigns", "insert", {
      code: "23505",
      message: 'duplicate key value violates unique constraint "campaigns_pkey"',
    });
    await assert.rejects(
      save(t, { wizard: WIZARD, confirm: false, idempotencyKey: KEY }),
      (e: { message?: string }) => /campaigns_pkey/.test(e.message ?? ""),
    );
    t.db.failNext("campaigns", "insert", {
      code: "57014",
      message: "canceling statement due to statement timeout",
    });
    await assert.rejects(
      save(t, { wizard: WIZARD, confirm: false, idempotencyKey: KEY }),
      (e: { message?: string }) => /statement timeout/.test(e.message ?? ""),
    );
    assert.equal(t.campaigns().length, 0);
  });

  test("an invalid key is refused before anything is written", async () => {
    const t = setup();
    await assert.rejects(
      save(t, { wizard: WIZARD, confirm: false, idempotencyKey: "short" }),
      /invalid request id/,
    );
    assert.equal(t.campaigns().length, 0);
  });

  test("status is never written: a created or replayed campaign stays a draft", async () => {
    const t = setup();
    await save(t, { wizard: WIZARD, confirm: true, idempotencyKey: KEY });
    await save(t, { wizard: WIZARD, confirm: true, idempotencyKey: KEY });
    const row = t.campaigns()[0]!;
    assert.equal(row["status"] ?? "draft", "draft");
    assert.equal(row["launched_at"], undefined);
  });
});

/** Optimistic concurrency (in-memory; proven on real PostgreSQL on the local QA database). */
describe("two editors cannot silently overwrite each other", () => {
  const renamed = (name: string) => ({ ...WIZARD, details: { ...WIZARD.details, name } });

  test("the second save from the same loaded version is refused; the first one stands", async () => {
    const t = setup([existing()]);
    const first = await save(t, { campaignId: "camp_1", wizard: renamed("Tab A"), confirm: false });
    assert.equal(first.outcome, "updated");
    await assert.rejects(
      save(t, { campaignId: "camp_1", wizard: renamed("Tab B"), confirm: false }),
      /changed elsewhere/,
    );
    assert.equal(t.campaigns()[0]!["name"], "Tab A");
  });

  test("saving again with the version the last save returned works", async () => {
    const t = setup([existing()]);
    const first = await save(t, { campaignId: "camp_1", wizard: renamed("One"), confirm: false });
    const second = await save(t, {
      campaignId: "camp_1",
      wizard: renamed("Two"),
      confirm: false,
      expectedUpdatedAt: first.updatedAt,
    });
    assert.equal(second.outcome, "updated");
    assert.equal(t.campaigns()[0]!["name"], "Two");
  });

  test("an edit without a version is refused before anything is written", async () => {
    const t = setup([existing()]);
    await assert.rejects(
      saveCampaignConfigurationFor(
        t.admin,
        ORG,
        "user_1",
        { campaignId: "camp_1", wizard: WIZARD, confirm: false },
        NOW,
      ),
      /no campaign version/,
    );
    assert.equal(t.campaigns()[0]!["name"], "Old name");
  });

  test("a campaign that started running meanwhile reports its status, not a version conflict", async () => {
    const t = setup([existing()]);
    t.campaigns()[0]!["status"] = "running";
    t.campaigns()[0]!["updated_at"] = "2026-11-21T00:00:00.000000+00:00";
    await assert.rejects(
      save(t, { campaignId: "camp_1", wizard: renamed("Late"), confirm: false }),
      /Pause it/,
    );
  });
});
