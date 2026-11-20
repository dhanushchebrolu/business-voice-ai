import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import {
  campaignEligibilityFor,
  prepareCampaignContextFor,
  saveCampaignContextFor,
} from "./campaign-context.server.ts";
import type { CampaignContext } from "./campaign-context.ts";

type Row = Record<string, unknown>;
const ORG = "org_a";
const OTHER = "org_b";

const CONTEXT: CampaignContext = {
  version: 1,
  objective: "Invite past customers for a check-up",
  audience: "",
  talkingPoints: ["Open on Saturdays"],
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

function setup(status = "draft") {
  const db = memorySupabase({
    tables: {
      campaigns: [
        {
          id: "camp_1",
          organization_id: ORG,
          business_id: "biz_1",
          status,
          description: "Call our patients. Offer a check-up.",
          context: null,
          context_reviewed_at: null,
          objective: null,
          call_instructions: null,
        },
      ],
      businesses: [{ id: "biz_1", organization_id: ORG, name: "Smile Dental" }],
      services: [{ id: "s1", business_id: "biz_1", name: "Dental Check-up" }],
      campaign_contacts: [] as Row[],
    },
  });
  return { db, admin: db.client, table: (n: string) => db.tables[n] ?? [] };
}

describe("preparing a context (nothing saved)", () => {
  test("uses the LLM's validated draft, sending the description and the business's services as data", async () => {
    const t = setup();
    let seen: { system: string; user: string } | null = null;
    const r = await prepareCampaignContextFor(t.admin, ORG, "camp_1", "", async (req) => {
      seen = req;
      return JSON.stringify({ ...CONTEXT, objective: "Drafted by the model" });
    });
    assert.equal(r.source, "llm");
    assert.equal(r.context.objective, "Drafted by the model");
    const user = JSON.parse(seen!.user) as Record<string, unknown>;
    assert.equal(
      user["description"],
      "Call our patients. Offer a check-up.",
      "the stored description is used",
    );
    assert.deepEqual(user["services"], ["Dental Check-up"]);
    assert.equal(t.table("campaigns")[0]!["context"], null, "nothing is saved by preparing");
  });

  test("an LLM failure or an invalid answer falls back to the deterministic draft", async () => {
    const t = setup();
    const original = console.error;
    console.error = () => {};
    try {
      const failed = await prepareCampaignContextFor(t.admin, ORG, "camp_1", "", async () => {
        throw new Error("timeout");
      });
      assert.equal(failed.source, "rules");
      assert.equal(failed.context.objective, "Call our patients.");
    } finally {
      console.error = original;
    }
    const invalid = await prepareCampaignContextFor(
      t.admin,
      ORG,
      "camp_1",
      "",
      async () => "I cannot help",
    );
    assert.equal(invalid.source, "rules");
    const none = await prepareCampaignContextFor(
      t.admin,
      ORG,
      "camp_1",
      "Remind members. Bring a towel.",
      null,
    );
    assert.equal(none.context.objective, "Remind members.");
  });

  test("another customer's campaign is not found", async () => {
    const t = setup();
    await assert.rejects(
      prepareCampaignContextFor(t.admin, OTHER, "camp_1", "x", null),
      /Campaign not found/,
    );
  });
});

describe("saving the reviewed context", () => {
  test("stores the validated context, who reviewed it, and the compiled text the calls receive", async () => {
    const t = setup();
    const r = await saveCampaignContextFor(t.admin, ORG, "camp_1", "user_1", {
      context: CONTEXT,
      description: "Edited description",
    });
    const row = t.table("campaigns")[0]!;
    assert.deepEqual(row["context"], CONTEXT);
    assert.equal(row["context_version"], 1);
    assert.equal(row["context_reviewed_by"], "user_1");
    assert.ok(row["context_reviewed_at"]);
    assert.equal(row["objective"], CONTEXT.objective);
    assert.equal(row["call_instructions"], r.compiled.instructions);
    assert.equal(row["description"], "Edited description");
  });

  test("an invalid context is refused and nothing changes", async () => {
    const t = setup();
    await assert.rejects(
      saveCampaignContextFor(t.admin, ORG, "camp_1", "user_1", {
        context: { ...CONTEXT, objective: "" },
      }),
      /objective/,
    );
    assert.equal(t.table("campaigns")[0]!["context_reviewed_at"], null);
  });

  test("a running, completed or cancelled campaign's context cannot be changed", async () => {
    for (const status of ["running", "completed", "cancelled"]) {
      const t = setup(status);
      await assert.rejects(
        saveCampaignContextFor(t.admin, ORG, "camp_1", "user_1", { context: CONTEXT }),
        new RegExp(`campaign is ${status}`),
      );
      assert.equal(t.table("campaigns")[0]!["context"], null);
    }
  });

  test("another customer cannot save into this campaign", async () => {
    const t = setup();
    await assert.rejects(
      saveCampaignContextFor(t.admin, OTHER, "camp_1", "user_x", { context: CONTEXT }),
      /Campaign not found/,
    );
    assert.equal(t.table("campaigns")[0]!["context"], null);
  });
});

describe("eligibility preview", () => {
  test("counts who would be called and why others would not; finished contacts are separate", async () => {
    const t = setup();
    const cc = (id: string, status: string, phone: string, opted_out = false, org = ORG): Row => ({
      id,
      campaign_id: "camp_1",
      organization_id: org,
      status,
      created_at: `2026-11-20T10:00:0${id.slice(-1)}Z`,
      contacts: { phone, opted_out },
    });
    t.table("campaign_contacts").push(
      cc("c1", "pending", "+919800000001"),
      cc("c2", "pending", "+919800000002", true),
      cc("c3", "pending", "+14155550100"),
      cc("c4", "retry_scheduled", "+919800000004"),
      cc("c5", "completed", "+919800000005"),
      cc("c6", "pending", "+919800000006", false, OTHER),
    );
    const p = await campaignEligibilityFor(t.admin, ORG, "camp_1", (e) => e.startsWith("+91"));
    assert.deepEqual(p, {
      total: 4,
      eligible: 2,
      excluded: { opted_out: 1, country_not_allowed: 1 },
      alreadyHandled: 1,
    });
  });
});
