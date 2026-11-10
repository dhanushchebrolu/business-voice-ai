import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildAgentInstructions, type AgentSnapshot } from "./agent-instructions.ts";
import { BUSINESS_TYPES, EMPLOYEE_TYPES, getEmployeeType } from "./business-types.ts";
import { templateCallVariables } from "./sarvam-tenant-variables.server.ts";

const snapshot = (business_type: string, employee_type?: string): AgentSnapshot => ({
  business: {
    name: "Harbour Homes",
    business_type,
    description: "Apartments and villas in Kochi.",
    timezone: "Asia/Kolkata",
    currency: "INR",
  },
  hours: [],
  services: [],
  faqs: [],
  rules: [],
  knowledge: [],
  agent: {
    agent_name: "Aria",
    persona: "friendly",
    objectives: ["answer_questions"],
    capabilities: {},
    primary_language: "en-IN",
    extra_languages: [],
    multilingual: false,
    voice_id: "ritu",
    speaking_pace: 1,
    greetings: { "en-IN": "Hello" },
    after_hours_behavior: "take_message",
    ...(employee_type ? { employee_type } : {}),
  },
});

const NOW = new Date("2026-11-10T06:00:00Z");

describe("AI employee types in the shared prompt", () => {
  test("an agent with no employee type is the receptionist, with no extra ROLE section", () => {
    const out = buildAgentInstructions(snapshot("real_estate"), NOW);
    assert.match(out, /You are Aria, the phone receptionist for Harbour Homes\./);
    assert.doesNotMatch(out, /# ROLE/);
  });

  test("sales and customer care agents get their own role title and ROLE section", () => {
    const sales = buildAgentInstructions(snapshot("real_estate", "sales_executive"), NOW);
    assert.match(sales, /the sales executive for Harbour Homes/);
    assert.match(sales, /# ROLE\n[\s\S]*Never pressure anyone/);
    const care = buildAgentInstructions(snapshot("ecommerce", "customer_care_executive"), NOW);
    assert.match(care, /the customer care executive for Harbour Homes/);
    assert.match(care, /Never promise refunds/);
  });

  test("an unknown employee type falls back to the receptionist", () => {
    assert.equal(getEmployeeType("doctor").id, "receptionist");
    assert.equal(EMPLOYEE_TYPES.length, 3);
  });

  test("no business type gets doctor, patient or hospital wording from the shared prompt", () => {
    // The two clinic types legitimately name themselves in "Type:".
    for (const type of BUSINESS_TYPES.filter((t) => !t.id.endsWith("_clinic"))) {
      for (const role of EMPLOYEE_TYPES) {
        const out = buildAgentInstructions(snapshot(type.id, role.id), NOW);
        assert.doesNotMatch(out, /\b(doctor|patient|hospital|clinic)\b/i, `${type.id}/${role.id}`);
      }
    }
  });
});

/** Minimal supabaseAdmin stand-in: each table returns one fixed row. */
function fakeAdmin(rows: Record<string, unknown>) {
  return {
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      };
      return q;
    },
  } as never;
}

describe("templateCallVariables", () => {
  const agent = {
    organization_id: "org-1",
    business_id: "biz-1",
    sarvam_application_id: "tpl-1",
    employee_type: "sales_executive",
    agent_name: "Aria",
  };
  const business = {
    organization_id: "org-1",
    name: "Harbour Homes",
    business_type: "real_estate",
    description: "x".repeat(800),
    primary_phone: "+914840000000",
    timezone: "Asia/Kolkata",
  };

  test("a directly mapped agent gets no extra variables", async () => {
    const vars = await templateCallVariables(
      fakeAdmin({}),
      { ...agent, sarvam_application_id: null },
      "org-1",
    );
    assert.deepEqual(vars, {});
  });

  test("a template-mapped agent carries its own business identity, description capped", async () => {
    const vars = await templateCallVariables(fakeAdmin({ businesses: business }), agent, "org-1");
    assert.equal(vars["business_name"], "Harbour Homes");
    assert.equal(vars["business_type"], "Real Estate");
    assert.equal(vars["employee_role"], "AI Sales Executive");
    assert.equal(vars["business_description"]!.length, 500);
  });

  test("another organization's agent or business is refused", async () => {
    await assert.rejects(
      templateCallVariables(fakeAdmin({ businesses: business }), agent, "org-2"),
      /does not belong/,
    );
    await assert.rejects(
      templateCallVariables(
        fakeAdmin({ businesses: { ...business, organization_id: "org-2" } }),
        agent,
        "org-1",
      ),
      /business profile is missing/,
    );
  });
});
