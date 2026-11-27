import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { saveOnboarding, type OnboardingInput } from "./onboarding-save.ts";
import { businessSetupProblems } from "./provisioning-pipeline.server.ts";
import { getBusinessType } from "./business-types.ts";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";

/**
 * The setup wizard's save: every failed write stops it, and running it again finishes the same
 * business so the customer can submit it. A set-up customer is never overwritten.
 */

const ORG = "org_wizard";
const TYPE = "dental_clinic";

const input = (over: Partial<OnboardingInput> = {}): OnboardingInput => ({
  orgId: ORG,
  typeId: TYPE,
  info: {
    name: "Wizard Dental",
    description: "A family dental clinic that looks after patients of every age in town.",
    address: "1 Main Road",
    city: "Chennai",
    state: "",
    postal_code: "",
    primary_phone: "+91 90000 00000",
    email: "",
    website: "",
  },
  openDays: [1, 2, 3],
  openTime: "09:00",
  closeTime: "18:00",
  items: [
    { name: "Cleaning", price: "500" },
    { name: "  ", price: "" },
  ],
  agentName: "Aria",
  language: "en-IN",
  voiceId: "simran",
  greeting: "Hello.",
  ...over,
});

function setup(tables: Record<string, Record<string, unknown>[]> = {}) {
  const db = memorySupabase({
    uniques: [
      { table: "agent_configs", key: (r) => (r["business_id"] as string | null) ?? null },
      {
        table: "business_hours",
        key: (r) => `${r["business_id"] as string}:${r["day_of_week"] as number}`,
      },
    ],
    tables: { organizations: [{ id: ORG, onboarding_completed: false }], ...tables },
  });
  const rows = (t: string) => db.tables[t] ?? [];
  return {
    db,
    rows,
    save: (over?: Partial<OnboardingInput>) => saveOnboarding(db.client, input(over)),
  };
}

/** The finished setup: one of each, and nothing the submission would still ask for. */
async function assertComplete(c: ReturnType<typeof setup>) {
  const type = getBusinessType(TYPE);
  assert.equal(c.rows("businesses").length, 1);
  assert.equal(c.rows("business_hours").length, 7);
  assert.deepEqual(
    c.rows("services").map((s) => s["name"]),
    ["Cleaning"],
  );
  assert.equal(c.rows("faqs").length, type.suggestedFaqs.length);
  assert.equal(c.rows("business_rules").length, type.suggestedRules.length);
  assert.equal(c.rows("agent_configs").length, 1);
  assert.equal(c.rows("organizations")[0]!["onboarding_completed"], true);
  assert.deepEqual(await businessSetupProblems(c.db.client, ORG), []);
}

describe("a save that goes through", () => {
  test("writes the whole setup, ready to submit", async () => {
    const c = setup();
    assert.deepEqual(await c.save(), { alreadySetUp: false });
    await assertComplete(c);
    assert.equal(c.rows("businesses")[0]!["state"], null, "blank fields are stored empty");
    const closed = c.rows("business_hours").find((h) => h["day_of_week"] === 0)!;
    assert.deepEqual([closed["is_closed"], closed["intervals"]], [true, []]);
  });
});

describe("a failed save never strands the customer", () => {
  for (const [table, op] of [
    ["businesses", "insert"],
    ["business_hours", "upsert"],
    ["services", "insert"],
    ["faqs", "insert"],
    ["business_rules", "insert"],
    ["agent_configs", "insert"],
    ["organizations", "update"],
  ] as const)
    test(`${table} ${op} fails: the save stops, and saving again finishes it`, async () => {
      const c = setup();
      c.db.failNext(table, op, { message: `${table} is unavailable` });
      await assert.rejects(c.save(), /unavailable/);
      // Without a receptionist the dashboard sends the customer back to the wizard.
      if (table !== "organizations") assert.equal(c.rows("agent_configs").length, 0);
      await c.save();
      await assertComplete(c);
    });

  for (const table of ["businesses", "agent_configs", "services"])
    test(`reading ${table} fails: reported, never treated as empty`, async () => {
      const c = setup();
      if (table === "services") {
        c.db.failNext("agent_configs", "insert", { message: "first attempt" });
        await assert.rejects(c.save());
      }
      c.db.failNext(table, "select", { message: "read failed" });
      await assert.rejects(c.save(), /read failed/);
      if (table !== "services") assert.equal(c.rows("businesses").length, 0, "nothing written");
      assert.equal(c.rows("agent_configs").length, 0);
      await c.save();
      await assertComplete(c);
    });

  test("saving again keeps earlier optional details left blank, and takes the new answers", async () => {
    const c = setup();
    c.db.failNext("agent_configs", "insert", { message: "down" });
    await assert.rejects(c.save());
    const blank = { ...input().info, name: "Renamed Dental", address: "", primary_phone: "" };
    await c.save({
      info: blank,
      openDays: [5],
      items: [
        { name: "Cleaning", price: "500" },
        { name: "Braces", price: "" },
      ],
    });
    const [business] = c.rows("businesses");
    assert.deepEqual(
      [business!["name"], business!["address"], business!["primary_phone"]],
      ["Renamed Dental", "1 Main Road", "+91 90000 00000"],
    );
    assert.deepEqual(
      c
        .rows("business_hours")
        .filter((h) => !h["is_closed"])
        .map((h) => h["day_of_week"]),
      [5],
    );
    assert.deepEqual(
      c.rows("services").map((s) => s["name"]),
      ["Cleaning", "Braces"],
    );
  });

  test("a receptionist saved by another tab at the same moment counts as saved", async () => {
    const c = setup();
    c.db.failNext("agent_configs", "insert", { code: "23505", message: "duplicate key" });
    assert.deepEqual(await c.save(), { alreadySetUp: false });
  });
});

describe("a set-up customer is never overwritten", () => {
  test("running the wizard again changes nothing of theirs", async () => {
    const c = setup();
    await c.save();
    const before = JSON.stringify({ ...c.db.tables, organizations: [] });
    const again = await c.save({ info: { ...input().info, name: "Other name" }, openDays: [] });
    assert.deepEqual(again, { alreadySetUp: true });
    assert.equal(JSON.stringify({ ...c.db.tables, organizations: [] }), before);
  });

  test("older duplicate businesses with the receptionist on the second: no second receptionist", async () => {
    const c = setup({
      businesses: [
        { id: "biz_1", organization_id: ORG, name: "First", created_at: "2026-01-01" },
        { id: "biz_2", organization_id: ORG, name: "Second", created_at: "2026-01-02" },
      ],
      agent_configs: [{ id: "agent_1", organization_id: ORG, business_id: "biz_2" }],
    });
    assert.deepEqual(await c.save(), { alreadySetUp: true });
    assert.equal(c.rows("agent_configs").length, 1);
    assert.equal(c.rows("businesses")[0]!["name"], "First");
    assert.equal(c.rows("business_hours").length, 0);
  });

  test("another customer's business and receptionist are left alone", async () => {
    const other = { id: "biz_other", organization_id: "org_other", name: "Other" };
    const c = setup({
      businesses: [{ ...other }],
      agent_configs: [{ id: "a_o", organization_id: "org_other", business_id: "biz_other" }],
    });
    await c.save();
    assert.deepEqual(c.rows("businesses")[0], other);
    assert.equal(c.rows("agent_configs").filter((a) => a["organization_id"] === ORG).length, 1);
  });
});

describe("the dashboard", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  test("sends a customer with an unfinished setup back to the wizard", () => {
    const app = read("../routes/app.tsx");
    assert.match(app, /ws\.setupIncomplete &&\s*pathname !== "\/app\/onboarding"/);
    const workspace = read("./workspace.ts");
    assert.match(workspace, /if \(businessRes\.error\) throw businessRes\.error;/);
    assert.match(workspace, /if \(agentError\) throw agentError;/);
    assert.match(workspace, /if \(anyError\) throw anyError;/);
    assert.match(workspace, /setupIncomplete = !data\?\.length;/);
  });
});
