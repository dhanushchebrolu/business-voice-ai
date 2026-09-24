import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveAvailableTools, executeAiTool } from "./ai-tools.server.ts";

function makeFakeSupabase(script: { table: string; op: string; result: unknown }[]) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  let i = 0;
  function next(table: string, op: string, ...args: unknown[]) {
    calls.push({ table, op, args });
    const entry = script[i];
    i++;
    if (!entry) throw new Error(`test bug: no scripted response for call ${i} (${table}.${op})`);
    return entry.result;
  }
  function selectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      maybeSingle: () => Promise.resolve(next(table, "select.maybeSingle", filters)),
    };
    return chain;
  }
  const client = {
    from(table: string) {
      return { select: () => selectChain(table) };
    },
  };
  return { client: client as never, calls };
}

describe("resolveAvailableTools — default-deny capability resolution", () => {
  test("an agent with no capabilities granted gets an empty tool list, not every tool", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: { data: { organization_id: "org-1", capabilities: {} }, error: null },
      },
    ]);
    const tools = await resolveAvailableTools(client, "org-1", "biz-1");
    assert.deepEqual(tools, []);
  });

  test("only grants the tools whose exact capability key is true — a falsy/truthy-looking value never counts", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: {
          data: {
            organization_id: "org-1",
            capabilities: {
              calendar_read: true,
              booking_payment_required: "true",
              payment_request: 1,
            },
          },
          error: null,
        },
      },
    ]);
    const tools = await resolveAvailableTools(client, "org-1", "biz-1");
    assert.deepEqual(
      tools.map((t) => t.name),
      ["check_calendar_availability"],
    );
  });

  test("grants payment_request-gated tools together when that one capability is true", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: {
          data: { organization_id: "org-1", capabilities: { payment_request: true } },
          error: null,
        },
      },
    ]);
    const tools = await resolveAvailableTools(client, "org-1", "biz-1");
    assert.deepEqual(tools.map((t) => t.name).sort(), ["check_payment_status", "request_payment"]);
  });

  test("no agent configured for the business returns an empty list, not an error", async () => {
    const { client } = makeFakeSupabase([
      { table: "agent_configs", op: "select.maybeSingle", result: { data: null, error: null } },
    ]);
    const tools = await resolveAvailableTools(client, "org-1", "biz-1");
    assert.deepEqual(tools, []);
  });

  test("an agent belonging to a different organization never leaks its tools", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: {
          data: { organization_id: "org-OTHER", capabilities: { calendar_read: true } },
          error: null,
        },
      },
    ]);
    const tools = await resolveAvailableTools(client, "org-1", "biz-1");
    assert.deepEqual(tools, []);
  });
});

describe("executeAiTool — dispatch safety", () => {
  test("an unknown/hallucinated tool name returns an error tool result instead of throwing", async () => {
    const { client } = makeFakeSupabase([]);
    const result = await executeAiTool(
      client,
      { organizationId: "org-1", businessId: "biz-1", agentConfigId: null, source: "voice" },
      "delete_all_bookings",
      {},
    );
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content) as { error: { code: string } };
    assert.equal(parsed.error.code, "UNKNOWN_TOOL");
  });

  test("missing required input fields never reach the underlying tool implementation", async () => {
    const { client, calls } = makeFakeSupabase([]);
    const result = await executeAiTool(
      client,
      { organizationId: "org-1", businessId: "biz-1", agentConfigId: null, source: "voice" },
      "check_calendar_availability",
      { durationMinutes: 30 }, // missing dateIso
    );
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content) as { error: { code: string } };
    assert.equal(parsed.error.code, "INVALID_TOOL_INPUT");
    assert.equal(calls.length, 0, "must not query the database for an invalid tool call");
  });

  test("organizationId/businessId always come from ctx, never from the model's tool input, even if the model supplies its own", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "agent_configs",
        op: "select.maybeSingle",
        result: {
          data: { organization_id: "org-TRUSTED", capabilities: { calendar_read: true } },
          error: null,
        },
      },
      { table: "businesses", op: "select.maybeSingle", result: { data: null, error: null } },
    ]);
    await executeAiTool(
      client,
      {
        organizationId: "org-TRUSTED",
        businessId: "biz-TRUSTED",
        agentConfigId: null,
        source: "voice",
      },
      "check_calendar_availability",
      {
        dateIso: "2026-10-01",
        durationMinutes: 30,
        // A hostile/confused model supplying its own tenant ids must have
        // zero effect — the dispatcher never reads these fields at all.
        organizationId: "org-ATTACKER",
        businessId: "biz-ATTACKER",
      },
    );
    const agentLookup = calls.find((c) => c.table === "agent_configs");
    assert.ok(agentLookup);
    const filters = agentLookup!.args[0] as Record<string, unknown>;
    assert.equal(filters["business_id"], "biz-TRUSTED");
  });
});
