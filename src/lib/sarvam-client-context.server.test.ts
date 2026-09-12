import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveOrganizationForSarvamContext,
  buildSarvamClientContext,
} from "./sarvam-client-context.server.ts";

/**
 * Behavioral coverage for the Sarvam client-context endpoint's two core
 * functions. Both take their Supabase client as a parameter, so — unlike
 * createServerFn-wrapped handlers — their actual resolution/shaping logic
 * can be exercised directly against a scripted fake query builder.
 */

interface QueryResult {
  data: unknown;
  error: unknown;
}

function makeFakeSupabase(script: Record<string, QueryResult[]>) {
  const consumedIdx: Record<string, number> = {};
  const calls: { table: string; filters: Record<string, unknown> }[] = [];

  function makeBuilder(table: string) {
    const filters: Record<string, unknown> = {};
    const builder = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      not(col: string, op: string, val: unknown) {
        filters[`not:${col}:${op}`] = val;
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        return builder;
      },
      then(resolve: (r: QueryResult) => void, reject: (e: unknown) => void): Promise<void> {
        calls.push({ table, filters });
        const idx = (consumedIdx[table] ??= 0);
        consumedIdx[table] = idx + 1;
        const result = script[table]?.[idx];
        if (!result) throw new Error(`test bug: no scripted result #${idx} for table ${table}`);
        return Promise.resolve(result).then(resolve as never, reject);
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return makeBuilder(table);
    },
  };

  return { client: client as never, calls };
}

describe("resolveOrganizationForSarvamContext — tenant resolution, priority order", () => {
  test("resolves via deployment_id when supplied, without even querying connection/phone tables", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: [{ data: { organization_id: "org_1" }, error: null }],
    });
    const orgId = await resolveOrganizationForSarvamContext(client, { deploymentId: "dep_1" });
    assert.equal(orgId, "org_1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.table, "phone_numbers");
    assert.equal(calls[0]!.filters["provider_deployment_id"], "dep_1");
  });

  test("falls back to connection_id when deployment_id does not resolve", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: [{ data: null, error: null }],
      telephony_connections: [{ data: { organization_id: "org_2" }, error: null }],
    });
    const orgId = await resolveOrganizationForSarvamContext(client, {
      deploymentId: "dep_missing",
      connectionId: "conn_1",
    });
    assert.equal(orgId, "org_2");
  });

  test("falls back to phone_number, matching only an active sarvam number", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: [{ data: { organization_id: "org_3" }, error: null }],
    });
    const orgId = await resolveOrganizationForSarvamContext(client, {
      phoneNumber: "+911111111111",
    });
    assert.equal(orgId, "org_3");
    assert.equal(calls[0]!.filters["status"], "active");
    assert.equal(calls[0]!.filters["provider"], "sarvam");
  });

  test("returns null when nothing resolves — never guesses or falls back to any other organization", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: [{ data: null, error: null }],
    });
    const orgId = await resolveOrganizationForSarvamContext(client, {
      phoneNumber: "+910000000000",
    });
    assert.equal(orgId, null);
  });

  test("returns null when no identifier is supplied at all", async () => {
    const { client } = makeFakeSupabase({});
    const orgId = await resolveOrganizationForSarvamContext(client, {});
    assert.equal(orgId, null);
  });
});

const BUSINESS_ROW = {
  id: "biz_1",
  name: "Acme Dental",
  business_type: "clinic",
  description: "A dental clinic",
  address: "123 Main St",
  city: "Mumbai",
  state: "MH",
  country: "IN",
  postal_code: "400001",
  website: "https://acme.example",
  email: "hello@acme.example",
  primary_phone: "+911111111111",
  secondary_phone: null,
  whatsapp: null,
  timezone: "Asia/Kolkata",
  currency: "INR",
};

describe("buildSarvamClientContext — shapes the documented response, never invents content", () => {
  test("returns null when the organization has no business record yet", async () => {
    const { client } = makeFakeSupabase({ businesses: [{ data: null, error: null }] });
    const context = await buildSarvamClientContext(client, "org_1");
    assert.equal(context, null);
  });

  test("assembles business/hours/services/faqs/rules/knowledge/agent from the org's own tables only", async () => {
    const { client, calls } = makeFakeSupabase({
      businesses: [{ data: BUSINESS_ROW, error: null }],
      business_hours: [
        {
          data: [
            { day_of_week: 1, is_closed: false, intervals: [{ start: "09:00", end: "18:00" }] },
          ],
          error: null,
        },
      ],
      services: [
        {
          data: [
            {
              name: "Cleaning",
              description: null,
              category: "dental",
              price: 500,
              currency: "INR",
              duration_minutes: 30,
            },
          ],
          error: null,
        },
      ],
      faqs: [
        {
          data: [{ question: "Do you take insurance?", answer: "Yes", category: null }],
          error: null,
        },
      ],
      business_rules: [{ data: [{ rule: "No walk-ins after 6pm", priority: 1 }], error: null }],
      knowledge_documents: [
        {
          data: [
            { title: "Cancellation policy", content: "24 hours notice required" },
            { title: "Empty doc", content: null },
          ],
          error: null,
        },
      ],
      agent_configs: [
        {
          data: {
            agent_name: "Aria",
            persona: "professional",
            custom_personality: null,
            objectives: ["answer_questions"],
            primary_language: "en-IN",
            extra_languages: [],
            multilingual: false,
            voice_id: "ritu",
            speaking_pace: 1,
            greetings: { default: "Hello!" },
            transfer_number: null,
            after_hours_behavior: "take_message",
          },
          error: null,
        },
      ],
    });

    const context = await buildSarvamClientContext(client, "org_1");
    assert.ok(context);
    assert.equal(context!.business.name, "Acme Dental");
    assert.equal(context!.hours.length, 1);
    assert.equal(context!.services[0]!.name, "Cleaning");
    assert.equal(context!.faqs[0]!.question, "Do you take insurance?");
    assert.equal(context!.rules[0]!.rule, "No walk-ins after 6pm");
    // A knowledge_documents row with null content is filtered out, never
    // surfaced as an empty/placeholder entry.
    assert.equal(context!.knowledge.length, 1);
    assert.equal(context!.knowledge[0]!.title, "Cancellation policy");
    assert.equal(context!.agent?.name, "Aria");

    // Every follow-up query is scoped to the resolved business's own id —
    // never the raw organization_id or any other business's id.
    const scopedTables = [
      "business_hours",
      "services",
      "faqs",
      "business_rules",
      "knowledge_documents",
      "agent_configs",
    ];
    for (const table of scopedTables) {
      const call = calls.find((c) => c.table === table);
      assert.ok(call, `expected a query against ${table}`);
      assert.equal(call!.filters["business_id"], "biz_1");
    }
  });

  test("agent is null (not a placeholder object) when the business has no agent_configs row", async () => {
    const { client } = makeFakeSupabase({
      businesses: [{ data: BUSINESS_ROW, error: null }],
      business_hours: [{ data: [], error: null }],
      services: [{ data: [], error: null }],
      faqs: [{ data: [], error: null }],
      business_rules: [{ data: [], error: null }],
      knowledge_documents: [{ data: [], error: null }],
      agent_configs: [{ data: null, error: null }],
    });
    const context = await buildSarvamClientContext(client, "org_1");
    assert.equal(context?.agent, null);
  });
});
