import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_TOOLS,
  callFacts,
  matchService,
  requestedTimeAnswer,
  generateIntegrationToken,
  handleSarvamAgentRequest,
  sarvamToolConfiguration,
  type AgentApiDeps,
} from "./sarvam-agent-api.server.ts";
import type { ToolExecutionContext } from "./ai-tools.server.ts";

/**
 * Multi-tenant tests of the Sarvam agent API with Sarvam-shaped HTTP
 * requests (POST, `Authorization: Bearer <secret>`, JSON body built from
 * Sarvam's @-variables) against an in-memory database holding two
 * customers, Smile Dental and ABC Dental.
 */

type Row = Record<string, unknown>;

/** Minimal Supabase query-builder fake over in-memory tables. */
class FakeDb {
  tables: Record<string, Row[]> = {};
  failOn: string | null = null;
  delayMs = 0;

  from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op:
      { kind: "select" } | { kind: "update"; payload: Row } | { kind: "insert"; rows: Row[] } = {
      kind: "select",
    };
    const rows = () => (this.tables[table] ??= []);
    const run = async (): Promise<{ data: unknown; error: unknown }> => {
      if (this.delayMs) await new Promise((r) => setTimeout(r, Math.random() * this.delayMs));
      if (this.failOn === table) throw new Error(`simulated failure reading ${table}`);
      if (op.kind === "insert") {
        const inserted: Row[] = [];
        for (const r of op.rows) {
          if (
            table === "sarvam_agent_events" &&
            r["kind"] === "call_outcome" &&
            r["interaction_id"] &&
            rows().some(
              (e) =>
                e["kind"] === "call_outcome" &&
                e["integration_id"] === r["integration_id"] &&
                e["interaction_id"] === r["interaction_id"],
            )
          )
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          // Primary key, as in PostgreSQL.
          if (r["id"] && rows().some((e) => e["id"] === r["id"]))
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          const row = { id: crypto.randomUUID(), ...r };
          rows().push(row);
          inserted.push({ ...row });
        }
        return { data: inserted, error: null };
      }
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (op.kind === "update") {
        for (const r of matched) Object.assign(r, (op as { payload: Row }).payload);
      }
      return { data: matched.map((r) => ({ ...r })), error: null };
    };
    // A `json->>key` column reads a key of a JSON column, as in PostgREST.
    const field = (r: Row, col: string) => {
      const [base, key] = col.split("->>");
      const v = r[base!];
      return key === undefined ? v : v && typeof v === "object" ? (v as Row)[key] : undefined;
    };
    const builder = {
      select: () => builder,
      eq: (col: string, val: unknown) => (filters.push((r) => field(r, col) === val), builder),
      neq: (col: string, val: unknown) => (filters.push((r) => field(r, col) !== val), builder),
      in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), builder),
      not: (col: string, _o: string, _v: unknown) => (
        filters.push((r) => r[col] !== null && r[col] !== undefined),
        builder
      ),
      order: () => builder,
      limit: () => builder,
      update: (payload: Row) => ((op = { kind: "update", payload }), builder),
      insert: (r: Row | Row[]) => (
        (op = { kind: "insert", rows: Array.isArray(r) ? r : [r] }),
        builder
      ),
      maybeSingle: async () => {
        const res = await run();
        return {
          data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data,
          error: res.error,
        };
      },
      single: async () => {
        const res = await run();
        return { data: Array.isArray(res.data) ? res.data[0] : res.data, error: res.error };
      },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        run().then(resolve, reject),
    };
    return builder;
  };
}

const ORG_SMILE = "org-smile";
const ORG_ABC = "org-abc";
// 2026-11-11 is a Wednesday; 10:00 IST.
const NOW = new Date("2026-11-11T04:30:00Z");

let db: FakeDb;
let tokens: Record<string, string>;
let toolCalls: { ctx: ToolExecutionContext; name: string; input: Record<string, unknown> }[];

async function seed() {
  db = new FakeDb();
  tokens = {};
  toolCalls = [];
  const tenant = async (org: string, name: string, close: string, fee: number, doctor: string) => {
    const biz = `biz-${org}`;
    const agent = `agent-${org}`;
    const { token, hash, prefix } = await generateIntegrationToken();
    tokens[org] = token;
    (db.tables["businesses"] ??= []).push({
      id: biz,
      organization_id: org,
      name,
      business_type: "dental_clinic",
      description: `${name} family dentistry`,
      address: `1 ${name} Road`,
      city: "Hyderabad",
      state: null,
      country: "IN",
      postal_code: null,
      website: null,
      email: null,
      primary_phone: "+914000000000",
      secondary_phone: null,
      whatsapp: null,
      timezone: "Asia/Kolkata",
      currency: "INR",
      default_appointment_duration_minutes: 30,
    });
    (db.tables["business_hours"] ??= []).push(
      ...[0, 1, 2, 3, 4, 5, 6].map((d) => ({
        business_id: biz,
        day_of_week: d,
        is_closed: d === 0,
        intervals: d === 0 ? [] : [{ start: "09:00", end: close }],
      })),
    );
    (db.tables["services"] ??= []).push({
      id: `svc-${org}`,
      business_id: biz,
      is_active: true,
      name: "Consultation",
      description: null,
      category: null,
      price: fee,
      currency: "INR",
      duration_minutes: 20,
      attributes: { doctor, specialty: "General dentistry" },
    });
    (db.tables["faqs"] ??= []).push({
      business_id: biz,
      is_active: true,
      question: "Parking?",
      answer: `${name} has parking.`,
      category: null,
    });
    (db.tables["agent_configs"] ??= []).push({
      id: agent,
      organization_id: org,
      business_id: biz,
      agent_name: "Aria",
      persona: "friendly",
      custom_personality: null,
      objectives: [],
      primary_language: "en-IN",
      extra_languages: [],
      multilingual: true,
      voice_id: "ritu",
      speaking_pace: 1,
      greetings: {},
      transfer_number: null,
      after_hours_behavior: "take_message",
      capabilities: { answer_faqs: true, calendar_book: true, capture_lead: true },
      sarvam_app_id: `App-${org}`,
      sarvam_app_version: 3,
    });
    (db.tables["organizations"] ??= []).push({ id: org, lifecycle_status: "active" });
    // An ACTIVE number with a verified deployment mapping: the admission gate's precondition.
    (db.tables["phone_numbers"] ??= []).push({
      id: `num-${org}`,
      e164: org === ORG_SMILE ? "+917900000001" : "+917900000002",
      status: "active",
      provider: "sarvam",
      organization_id: org,
      agent_config_id: agent,
      inbound_enabled: true,
      provider_deployment_id: `dep-${org}`,
      verified_deployment_id: `dep-${org}`,
      verified_sarvam_app_id: `App-${org}`,
      verified_sarvam_app_version: 3,
      admission_blocked_at: null,
    });
    (db.tables["sarvam_agent_integrations"] ??= []).push({
      id: `int-${org}`,
      organization_id: org,
      agent_config_id: agent,
      token_hash: hash,
      token_prefix: prefix,
      status: "active",
      expires_at: null,
      role: "inbound",
    });
  };
  await tenant(ORG_SMILE, "Smile Dental", "20:00", 500, "Dr. Meera Rao");
  await tenant(ORG_ABC, "ABC Dental", "18:00", 700, "Dr. Anil Kumar");
}

const deps = (): AgentApiDeps => ({
  supabaseAdmin: db as never,
  now: () => NOW,
  executeTool: async (ctx, name, input) => {
    toolCalls.push({ ctx, name, input });
    return { content: JSON.stringify({ success: true, data: { tenant: ctx.organizationId } }) };
  },
});

/** What Sarvam sends for an HTTP API tool: POST, bearer secret, JSON body from @-variables. */
function sarvamRequest(
  path: string,
  token: string | null,
  body: unknown = {},
  authorization?: string,
) {
  return new Request(`https://clickai.example/api/public/sarvam/agent/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization !== undefined
        ? { authorization }
        : token
          ? { authorization: `Bearer ${token}` }
          : {}),
    },
    body: JSON.stringify(body),
  });
}
const call = async (
  path: string,
  token: string | null,
  body: unknown = {},
  authorization?: string,
) => {
  const tool = path === "context" ? undefined : path.replace(/^tools\//, "");
  const res = await handleSarvamAgentRequest(
    sarvamRequest(path, token, body, authorization),
    tool,
    deps(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(seed);

describe("each customer's agent reads its own live data", () => {
  test("1. Smile Dental retrieves its own business data", async () => {
    const r = await call("context", tokens[ORG_SMILE]!, {
      interaction_id: "20261111/a",
      caller_number: "+919000000001",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body["business_name"], "Smile Dental");
    assert.equal(r.body["hours_today"], "09:00-20:00");
    assert.match(String(r.body["services_and_prices"]), /Consultation: ₹500 \(20 min\)/);
    assert.match(String(r.body["staff"]), /Dr\. Meera Rao \(General dentistry\): Consultation/);
    assert.equal(r.body["context_status"], "ok");
  });

  test("2. ABC Dental retrieves its own business data", async () => {
    const r = await call("context", tokens[ORG_ABC]!);
    assert.equal(r.body["business_name"], "ABC Dental");
    assert.equal(r.body["hours_today"], "09:00-18:00");
    assert.match(String(r.body["services_and_prices"]), /₹700/);
  });

  test("3. Smile Dental's credential can never read ABC Dental's data, whatever the body says", async () => {
    for (const body of [
      { organization_id: ORG_ABC },
      { customer_id: ORG_ABC, business_id: `biz-${ORG_ABC}` },
    ]) {
      const r = await call("tools/get_business_info", tokens[ORG_SMILE]!, body);
      assert.equal(r.body["business_name"], "Smile Dental");
      assert.doesNotMatch(JSON.stringify(r.body), /ABC Dental|₹700|Anil/);
    }
  });

  test("4. Changing the closing time in ClickAI changes the very next response", async () => {
    assert.equal((await call("context", tokens[ORG_SMILE]!)).body["hours_today"], "09:00-20:00");
    const wed = db.tables["business_hours"]!.find(
      (h) => h["business_id"] === `biz-${ORG_SMILE}` && h["day_of_week"] === 3,
    )!;
    wed["intervals"] = [{ start: "09:00", end: "21:00" }];
    const next = await call("tools/get_business_info", tokens[ORG_SMILE]!);
    assert.equal(next.body["hours_today"], "09:00-21:00");
    assert.match(String(next.body["opening_hours"]), /Wednesday: 09:00-21:00/);
  });
});

describe("credentials", () => {
  test("5. invalid, malformed or missing credentials are rejected", async () => {
    const forged = `${tokens[ORG_SMILE]!.slice(0, -4)}AAAA`;
    for (const auth of [
      undefined,
      "",
      "Bearer",
      "Basic abc",
      `Bearer ${forged}`,
      "Bearer cai_sv_short",
      `Token ${tokens[ORG_SMILE]}`,
    ]) {
      const r = await call("context", null, {}, auth);
      assert.equal(r.status, 401, String(auth));
      assert.deepEqual(r.body, { error: "unauthorized" });
    }
  });

  test("6. rotated, expired and disconnected credentials are rejected", async () => {
    const old = tokens[ORG_SMILE]!;
    const fresh = await generateIntegrationToken();
    const integ = db.tables["sarvam_agent_integrations"]!.find(
      (i) => i["organization_id"] === ORG_SMILE,
    )!;
    Object.assign(integ, { token_hash: fresh.hash });
    assert.equal((await call("context", old)).status, 401, "rotated");
    assert.equal((await call("context", fresh.token)).status, 200);
    Object.assign(integ, { expires_at: new Date(NOW.getTime() - 1000).toISOString() });
    assert.equal((await call("context", fresh.token)).status, 401, "expired");
    Object.assign(integ, { expires_at: null, status: "disabled" });
    assert.equal((await call("context", fresh.token)).status, 401, "disabled");
  });

  test("an agent moved to another organization invalidates the credential", async () => {
    db.tables["agent_configs"]!.find((a) => a["organization_id"] === ORG_SMILE)![
      "organization_id"
    ] = ORG_ABC;
    assert.equal((await call("context", tokens[ORG_SMILE]!)).status, 401);
  });
});

describe("tools act only for the authenticated customer", () => {
  test("7. availability and booking run with the token's tenant, never one from the body", async () => {
    await call("tools/check_availability", tokens[ORG_ABC]!, {
      date: "2026-11-12",
      service_name: "consultation",
      organization_id: ORG_SMILE,
    });
    const avail = toolCalls[0]!;
    assert.equal(avail.name, "check_calendar_availability");
    assert.equal(avail.ctx.organizationId, ORG_ABC);
    assert.equal(avail.ctx.businessId, `biz-${ORG_ABC}`);
    assert.deepEqual(avail.input, { dateIso: "2026-11-12", durationMinutes: 20 });

    await call("tools/book_appointment", tokens[ORG_SMILE]!, {
      interaction_id: "20261111/xyz",
      date: "2026-11-12",
      time: "16:30",
      service_name: "Consultation",
      customer_name: "Ravi",
      customer_phone: "+919000000001",
      business_id: `biz-${ORG_ABC}`,
    });
    const book = toolCalls[1]!;
    assert.equal(book.ctx.organizationId, ORG_SMILE);
    assert.equal(book.ctx.callId, "sarvam-20261111/xyz", "idempotency is per Sarvam call");
    assert.equal(book.input["startIso"], "2026-11-12T11:00:00.000Z", "16:30 IST");
    assert.equal(book.input["endIso"], "2026-11-12T11:20:00.000Z", "service duration");
  });

  test("8. concurrent calls for both customers never leak context", async () => {
    db.delayMs = 5;
    const runs = Array.from({ length: 40 }, (_, i) => (i % 2 ? ORG_SMILE : ORG_ABC));
    const results = await Promise.all(
      runs.map((org) =>
        call(
          org === ORG_SMILE && Math.random() > 0.5 ? "context" : "tools/get_business_info",
          tokens[org]!,
        ),
      ),
    );
    results.forEach((r, i) => {
      const expected = runs[i] === ORG_SMILE ? "Smile Dental" : "ABC Dental";
      assert.equal(r.body["business_name"], expected);
      assert.doesNotMatch(
        JSON.stringify(r.body),
        runs[i] === ORG_SMILE ? /ABC Dental/ : /Smile Dental/,
      );
    });
  });
});

describe("never invents business facts", () => {
  test("9. missing business data is reported as missing, not filled in", async () => {
    db.tables["business_hours"] = db.tables["business_hours"]!.filter(
      (h) => h["business_id"] !== `biz-${ORG_SMILE}`,
    );
    db.tables["services"] = db.tables["services"]!.filter(
      (s) => s["business_id"] !== `biz-${ORG_SMILE}`,
    );
    const r = await call("context", tokens[ORG_SMILE]!);
    assert.equal(r.body["context_status"], "incomplete");
    assert.equal(r.body["hours_today"], "");
    assert.equal(r.body["opening_hours"], "");
    assert.equal(r.body["services_and_prices"], "");
    assert.match(String(r.body["missing"]), /opening hours.*services and prices/);
    assert.match(String(r.body["guidance"]), /do not guess/);
  });

  test("10. a failure while loading context answers 'unavailable' with no business facts", async () => {
    db.failOn = "business_hours";
    const r = await call("context", tokens[ORG_SMILE]!);
    assert.equal(r.status, 200);
    assert.equal(r.body["context_status"], "unavailable");
    assert.equal(r.body["business_name"], undefined);
    assert.match(String(r.body["guidance"]), /do not guess/);
    // If on-start fails outright, the variable's Sarvam default keeps the agent in safe mode.
    const cfg = sarvamToolConfiguration("https://x");
    assert.deepEqual(
      cfg.inputVariables.find((v) => v.name === "context_status"),
      { name: "context_status", defaultValue: "unavailable" },
    );
    assert.match(cfg.promptGuard, /never guess/);
  });

  test("a customer without a business profile gets 'unavailable', not someone else's data", async () => {
    db.tables["businesses"] = db.tables["businesses"]!.filter(
      (b) => b["organization_id"] !== ORG_SMILE,
    );
    const r = await call("context", tokens[ORG_SMILE]!);
    assert.equal(r.body["context_status"], "unavailable");
    assert.doesNotMatch(JSON.stringify(r.body), /ABC/);
  });
});

describe("check_availability returns local wall-clock times", () => {
  /** Availability as ClickAI's calendar tool returns it (UTC slots), for the token's business. */
  const availability = async (
    timezone: string,
    toolResult: unknown,
    org: string = ORG_SMILE,
  ): Promise<Record<string, unknown>> => {
    db.tables["businesses"]!.find((b) => b["organization_id"] === org)!["timezone"] = timezone;
    const res = await handleSarvamAgentRequest(
      sarvamRequest("tools/check_availability", tokens[org]!, { date: "2026-11-12" }),
      "check_availability",
      { ...deps(), executeTool: async () => ({ content: JSON.stringify(toolResult) }) },
    );
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  };
  const slotsOf = (body: Record<string, unknown>) =>
    (body["result"] as { data: { slots: Record<string, string>[] } }).data.slots;

  test("keeps the UTC slots and adds start_local/end_local in the business timezone", async () => {
    const body = await availability("Asia/Kolkata", {
      success: true,
      data: {
        slots: [
          { start: "2026-11-12T04:30:00.000Z", end: "2026-11-12T05:00:00.000Z" },
          { start: "2026-11-12T18:30:00.000Z", end: "2026-11-12T19:00:00.000Z" },
        ],
      },
    });
    assert.equal(body["timezone"], "Asia/Kolkata");
    assert.equal(body["ok"], true);
    assert.deepEqual(slotsOf(body), [
      {
        start: "2026-11-12T04:30:00.000Z",
        end: "2026-11-12T05:00:00.000Z",
        start_local: "10:00",
        end_local: "10:30",
      },
      // Midnight is 00:00, never 24:00.
      {
        start: "2026-11-12T18:30:00.000Z",
        end: "2026-11-12T19:00:00.000Z",
        start_local: "00:00",
        end_local: "00:30",
      },
    ]);
  });

  test("no free slots: an empty list and the timezone, nothing invented", async () => {
    const body = await availability("Asia/Kolkata", { success: true, data: { slots: [] } });
    assert.deepEqual(slotsOf(body), []);
    assert.equal(body["timezone"], "Asia/Kolkata");
  });

  test("uses each business's own timezone, including daylight-saving changes", async () => {
    const local = async (timezone: string, startIso: string) =>
      slotsOf(
        await availability(timezone, {
          success: true,
          data: { slots: [{ start: startIso, end: startIso }] },
        }),
      )[0]!["start_local"];
    // New York: 10:00 is 15:00 UTC in winter (EST) and 14:00 UTC after the
    // 2026-03-08 switch to EDT, and again 15:00 UTC after 2026-11-01.
    assert.equal(await local("America/New_York", "2026-03-07T15:00:00.000Z"), "10:00");
    assert.equal(await local("America/New_York", "2026-03-09T14:00:00.000Z"), "10:00");
    assert.equal(await local("America/New_York", "2026-11-02T15:00:00.000Z"), "10:00");
    // London: BST in summer, GMT in winter.
    assert.equal(await local("Europe/London", "2026-07-01T09:00:00.000Z"), "10:00");
    assert.equal(await local("Europe/London", "2026-12-01T10:00:00.000Z"), "10:00");
    // Sydney: daylight saving in the southern summer (AEDT, UTC+11), not in June (AEST, UTC+10).
    assert.equal(await local("Australia/Sydney", "2026-01-15T23:00:00.000Z"), "10:00");
    assert.equal(await local("Australia/Sydney", "2026-06-15T00:00:00.000Z"), "10:00");
    // Two customers in different zones get their own wall clock for the same instant.
    const abc = await availability(
      "Asia/Dubai",
      {
        success: true,
        data: { slots: [{ start: "2026-11-12T06:00:00.000Z", end: "2026-11-12T06:30:00.000Z" }] },
      },
      ORG_ABC,
    );
    assert.equal(abc["timezone"], "Asia/Dubai");
    assert.equal(slotsOf(abc)[0]!["start_local"], "10:00");
  });

  test("a failed availability check is passed through unchanged, with the timezone", async () => {
    const failure = {
      success: false,
      error: { code: "TOOL_NOT_PERMITTED", message: "not permitted" },
    };
    const body = await availability("Asia/Kolkata", failure);
    assert.deepEqual(body["result"], failure);
    assert.equal(body["timezone"], "Asia/Kolkata");
  });
});

describe("call outcome, validation and audit", () => {
  test("the on-end outcome is recorded once per call and creates one lead", async () => {
    const body = {
      interaction_id: "20261111/out1",
      caller_number: "+919000000002",
      outcome: "callback_requested",
      summary: "Wants a cleaning next week",
      customer_name: "Asha",
    };
    const first = await call("tools/record_call_outcome", tokens[ORG_SMILE]!, body);
    const retry = await call("tools/record_call_outcome", tokens[ORG_SMILE]!, body);
    assert.deepEqual(first.body, { ok: true, duplicate: false });
    assert.deepEqual(retry.body, { ok: true, duplicate: true });
    const leads = db.tables["leads"] ?? [];
    assert.equal(leads.length, 1);
    assert.equal(leads[0]!["organization_id"], ORG_SMILE);
    assert.equal(leads[0]!["phone"], "+919000000002");
    assert.equal(
      leads[0]!["source"],
      "phone",
      "same source as other call leads (leads.source default)",
    );
  });

  test("only callback requests and named enquiries become leads; every outcome is still logged", async () => {
    const cases: [Record<string, string>, boolean][] = [
      [{ outcome: "callback_requested" }, true],
      [{ outcome: "enquiry_answered", interest: "root canal" }, true],
      [{ outcome: "enquiry_answered", customer_name: "Ravi" }, true],
      [{ outcome: "enquiry_answered" }, false],
      [{ outcome: "booked", customer_name: "Ravi" }, false],
      [{ outcome: "not_interested", customer_name: "Ravi" }, false],
      [{ outcome: "other", interest: "reminder" }, false],
      [{ outcome: "callback_requested", caller_number: "someone@example.com" }, false],
      // An opt-out is never a lead, whatever the outcome; "no" or absent keeps today's behaviour.
      [{ outcome: "callback_requested", opted_out: "yes" }, false],
      [{ outcome: "callback_requested", opted_out: "TRUE" }, false],
      [{ outcome: "enquiry_answered", customer_name: "Ravi", opted_out: "yes" }, false],
      [{ outcome: "callback_requested", opted_out: "no" }, true],
      [{ outcome: "enquiry_answered", interest: "root canal", opted_out: "" }, true],
    ];
    for (const [i, [extra, expectLead]] of cases.entries()) {
      const leadsBefore = (db.tables["leads"] ?? []).length;
      const eventsBefore = (db.tables["sarvam_agent_events"] ?? []).length;
      const res = await call("tools/record_call_outcome", tokens[ORG_SMILE]!, {
        interaction_id: `20261112/lead${i}`,
        caller_number: "+919000000003",
        summary: "Caller spoke to the agent",
        ...extra,
      });
      assert.deepEqual(res.body, { ok: true, duplicate: false });
      assert.equal(
        (db.tables["leads"] ?? []).length - leadsBefore,
        expectLead ? 1 : 0,
        JSON.stringify(extra),
      );
      assert.ok((db.tables["sarvam_agent_events"] ?? []).length > eventsBefore, "outcome logged");
    }
  });

  test("bad input is rejected; every request is audited under its own tenant", async () => {
    assert.equal(
      (await call("tools/check_availability", tokens[ORG_SMILE]!, { date: "tomorrow" })).status,
      400,
    );
    assert.equal(
      (
        await call("tools/book_appointment", tokens[ORG_SMILE]!, {
          date: "2026-11-12",
          time: "4pm",
        })
      ).status,
      400,
    );
    assert.equal((await call("tools/delete_everything", tokens[ORG_SMILE]!)).status, 404);
    const noCallId = await call("tools/book_appointment", tokens[ORG_SMILE]!, {
      date: "2026-11-12",
      time: "16:30",
    });
    assert.equal(noCallId.status, 400, "a booking needs interaction_id for idempotency");
    const res = await handleSarvamAgentRequest(
      new Request("https://x/api/public/sarvam/agent/context", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens[ORG_SMILE]}` },
        body: "x".repeat(20_000),
      }),
      undefined,
      deps(),
    );
    assert.equal(res.status, 400, "oversized body");
    await call("context", tokens[ORG_ABC]!, { interaction_id: "20261111/b" });
    const events = db.tables["sarvam_agent_events"] ?? [];
    assert.ok(events.some((e) => e["organization_id"] === ORG_ABC && e["kind"] === "context"));
    assert.ok(
      events.every(
        (e) =>
          e["organization_id"] ===
          (e["integration_id"] === `int-${ORG_SMILE}` ? ORG_SMILE : ORG_ABC),
      ),
    );
  });

  test("a rate-limited credential gets 429 without touching data", async () => {
    const res = await handleSarvamAgentRequest(
      sarvamRequest("context", tokens[ORG_SMILE]!),
      undefined,
      {
        ...deps(),
        rateLimit: async () => ({ allowed: false, retryAfterSeconds: 60 }),
      },
    );
    assert.equal(res.status, 429);
  });
});

describe("test callers never create bookings or leads", () => {
  const TEST_PHONE = "+919000000009";
  const markTestCaller = () => {
    const row = db.tables["sarvam_agent_integrations"]!.find(
      (r) => r["organization_id"] === ORG_SMILE,
    )!;
    row["test_caller_numbers"] = [TEST_PHONE];
  };
  const bookWith = (phone: string) => {
    const calls: string[] = [];
    return handleSarvamAgentRequest(
      sarvamRequest("tools/book_appointment", tokens[ORG_SMILE]!, {
        interaction_id: "20261113/test-1",
        date: "2026-11-14",
        time: "13:00",
        customer_name: "Tester",
        customer_phone: phone,
      }),
      "book_appointment",
      {
        ...deps(),
        executeTool: async (_ctx, name) => {
          calls.push(name);
          return {
            content: JSON.stringify(
              name === "check_calendar_availability"
                ? {
                    success: true,
                    data: { slots: [{ start: "2026-11-14T07:30:00.000Z", end: "x" }] },
                  }
                : { success: true, bookingOutcome: "confirmed" },
            ),
          };
        },
      },
    ).then(async (res) => ({ body: (await res.json()) as Record<string, unknown>, calls }));
  };

  test("a booking from a test number checks the slot but never books, and the reply is not CONFIRMED", async () => {
    markTestCaller();
    const { body, calls } = await bookWith(TEST_PHONE);
    assert.deepEqual(calls, ["check_calendar_availability"], "the booking tool is never called");
    const result = body["result"] as {
      success: boolean;
      bookingOutcome?: string;
      error: { code: string; message: string };
    };
    assert.equal(result.success, false);
    assert.equal(result.bookingOutcome, undefined);
    assert.equal(result.error.code, "TEST_CALL_NOT_SAVED");
    assert.match(result.error.message, /13:00 on 2026-11-14 is free/);
    const event = (db.tables["sarvam_agent_events"] ?? []).find(
      (e) => e["kind"] === "book_appointment",
    )!;
    assert.equal((event["detail"] as { test_call: boolean }).test_call, true);
  });

  test("Sarvam test chats and evals (caller identified by email) never book", async () => {
    const { body, calls } = await bookWith("owner@example.com");
    assert.deepEqual(calls, ["check_calendar_availability"]);
    assert.equal((body["result"] as { error: { code: string } }).error.code, "TEST_CALL_NOT_SAVED");
  });

  test("other callers still book normally", async () => {
    markTestCaller();
    const { body, calls } = await bookWith("+919000000001");
    assert.deepEqual(calls, ["book_appointment"]);
    assert.equal((body["result"] as { bookingOutcome: string }).bookingOutcome, "confirmed");
  });

  test("a test caller's callback request is logged as a test call and creates no lead", async () => {
    markTestCaller();
    const leadsBefore = (db.tables["leads"] ?? []).length;
    const res = await call("tools/record_call_outcome", tokens[ORG_SMILE]!, {
      interaction_id: "20261113/test-2",
      caller_number: TEST_PHONE,
      outcome: "callback_requested",
      customer_name: "Tester",
    });
    assert.deepEqual(res.body, { ok: true, duplicate: false });
    assert.equal((db.tables["leads"] ?? []).length, leadsBefore);
    const event = (db.tables["sarvam_agent_events"] ?? []).find(
      (e) => e["kind"] === "call_outcome",
    )!;
    assert.equal((event["detail"] as { test_call: boolean }).test_call, true);
  });
});

describe("Sarvam configuration brief", () => {
  test("every configured tool targets a real endpoint and uses bearer auth", () => {
    const cfg = sarvamToolConfiguration("https://clickai.in/");
    assert.deepEqual(
      cfg.tools.map((t) => t.lifecycle),
      ["on_start", "run", "run", "run", "run", "on_end"],
    );
    for (const t of cfg.tools) {
      assert.match(
        t.url,
        /^https:\/\/clickai\.in\/api\/public\/sarvam\/agent\/(context|tools\/[a-z_]+)$/,
      );
      if (t.url.includes("/tools/"))
        assert.ok((AGENT_TOOLS as readonly string[]).includes(t.url.split("/").pop()!));
      assert.equal(t.method, "POST");
      assert.match(t.auth, /Bearer token/);
    }
    assert.deepEqual(cfg.allowlistIps, ["4.213.167.70", "35.154.84.150"]);
    // Sarvam's built-in current_date/current_time are read-only; never save into them.
    const saved = cfg.tools[0]!.saveIntoVariables!;
    for (const reserved of ["current_date", "current_time", "current_datetime", "current_day"])
      assert.ok(!saved.includes(reserved), reserved);
    assert.deepEqual(
      saved,
      cfg.inputVariables.map((v) => v.name),
    );
    const onEnd = cfg.tools.find((t) => t.lifecycle === "on_end")!;
    const outputs = new Set(cfg.outputVariables.map((v) => `@${v.name}`));
    for (const k of ["outcome", "summary", "customer_name", "interest"])
      assert.ok(outputs.has(onEnd.body[k]!), k);
  });
});

describe("service validation, requested times and honest callbacks", () => {
  const slotsReply = (slots: string[]): AgentApiDeps => ({
    ...deps(),
    executeTool: async (_ctx, name) => ({
      content: JSON.stringify(
        name === "check_calendar_availability"
          ? { success: true, data: { slots: slots.map((start) => ({ start, end: start })) } }
          : { success: true, bookingOutcome: "confirmed", data: { id: "booking-1" } },
      ),
    }),
  });
  const run = async (tool: string, body: Record<string, unknown>, d = deps()) => {
    const res = await handleSarvamAgentRequest(
      sarvamRequest(`tools/${tool}`, tokens[ORG_SMILE]!, body),
      tool,
      d,
    );
    return (await res.json()) as Record<string, unknown>;
  };

  test("matchService maps caller wording to one configured service and never substitutes", () => {
    const services = [
      { name: "Root Canal Treatment" },
      { name: "Tooth Removal" },
      { name: "Tooth Whitening" },
    ];
    assert.deepEqual(matchService(services, "root canal"), {
      kind: "match",
      service: { name: "Root Canal Treatment" },
    });
    assert.equal(matchService(services, "General checkup").kind, "none");
    assert.equal(matchService(services, "tooth").kind, "ambiguous");
    assert.equal(matchService(services, "tooth removal").kind, "match");
  });

  test("with require_service, an unoffered service is refused before availability is checked", async () => {
    const body = await run("check_availability", {
      interaction_id: "i-1",
      date: "2026-11-14",
      service_name: "General checkup",
      require_service: true,
    });
    const result = body["result"] as {
      success: boolean;
      error: { code: string; options: string[] };
    };
    assert.equal(result.success, false);
    assert.equal(result.error.code, "SERVICE_NOT_OFFERED");
    assert.deepEqual(result.error.options, ["Consultation"]);
    assert.equal(toolCalls.length, 0, "no availability lookup and no booking");
  });

  test("without require_service (live v4 agents) the old lenient behaviour is unchanged", async () => {
    const body = await run("check_availability", {
      interaction_id: "i-2",
      date: "2026-11-14",
      service_name: "General checkup",
    });
    assert.equal(body["ok"], true);
    assert.equal(toolCalls.length, 1);
  });

  test("a matched service books with its canonical id", async () => {
    const calls: Record<string, unknown>[] = [];
    const d: AgentApiDeps = {
      ...deps(),
      executeTool: async (_c, name, input) => {
        calls.push({ name, ...input });
        return {
          content: JSON.stringify({
            success: true,
            bookingOutcome: "confirmed",
            data: { id: "b-9" },
          }),
        };
      },
    };
    const body = await run(
      "book_appointment",
      {
        interaction_id: "i-3",
        date: "2026-11-14",
        time: "10:00",
        service_name: "consultation",
        customer_name: "Ravi",
        customer_phone: "+919000000001",
        require_service: true,
      },
      d,
    );
    assert.deepEqual(body["service"], { id: `svc-${ORG_SMILE}`, name: "Consultation" });
    assert.equal(calls[0]!["serviceId"], `svc-${ORG_SMILE}`);
    const event = db.tables["sarvam_agent_events"]!.find((e) => e["kind"] === "book_appointment")!;
    assert.equal((event["detail"] as { booking_id: string }).booking_id, "b-9");
  });

  test("the server, not the agent, says whether the caller's time is free", async () => {
    // 10:30, 11:00 and 16:30 IST.
    const d = slotsReply([
      "2026-11-14T05:00:00.000Z",
      "2026-11-14T05:30:00.000Z",
      "2026-11-14T11:00:00.000Z",
    ]);
    const free = await run(
      "check_availability",
      { interaction_id: "i-4", date: "2026-11-14", time: "16:30" },
      d,
    );
    assert.deepEqual(free["requested_time"], { time: "16:30", available: true, alternatives: [] });
    const taken = await run(
      "check_availability",
      { interaction_id: "i-4", date: "2026-11-14", time: "10:00" },
      d,
    );
    assert.deepEqual(taken["requested_time"], {
      time: "10:00",
      available: false,
      alternatives: ["10:30", "11:00", "16:30"],
    });
    assert.deepEqual(requestedTimeAnswer("12:00", []), {
      time: "12:00",
      available: false,
      alternatives: [],
    });
  });

  test("request_callback saves the lead before the agent may promise a callback, once per call", async () => {
    const body = await run("request_callback", {
      interaction_id: "i-5",
      caller_number: "+919000000001",
      customer_name: "Meena",
      reason: "insurance question",
    });
    assert.deepEqual(body, { ok: true, recorded: true });
    assert.equal(db.tables["leads"]!.length, 1);
    const again = await run("request_callback", {
      interaction_id: "i-5",
      caller_number: "+919000000001",
    });
    assert.equal(again["duplicate"], true);
    // The end-of-call record knows the callback is saved and does not add a second lead.
    await run("record_call_outcome", {
      interaction_id: "i-5",
      caller_number: "+919000000001",
      outcome: "callback_requested",
      customer_name: "Meena",
    });
    assert.equal(db.tables["leads"]!.length, 1);
    const outcome = db.tables["sarvam_agent_events"]!.find((e) => e["kind"] === "call_outcome")!;
    const facts = (outcome["detail"] as { facts: { callback_recorded: boolean; lead_id: string } })
      .facts;
    assert.equal(facts.callback_recorded, true);
    assert.equal(facts.lead_id, db.tables["leads"]![0]!["id"]);
  });

  test("request_callback is refused when neither lead capture nor message taking is on", async () => {
    const agent = db.tables["agent_configs"]!.find((a) => a["organization_id"] === ORG_SMILE)!;
    agent["capabilities"] = { answer_faqs: true, calendar_book: true };
    const body = await run("request_callback", {
      interaction_id: "i-cap",
      caller_number: "+919000000001",
    });
    assert.deepEqual(body, { ok: true, recorded: false, error: { code: "CAPABILITY_DISABLED" } });
    assert.equal((db.tables["leads"] ?? []).length, 0);
    agent["capabilities"] = { take_callback: true };
    const allowed = await run("request_callback", {
      interaction_id: "i-cap2",
      caller_number: "+919000000001",
    });
    assert.equal(allowed["recorded"], true, "message taking alone is enough");
  });

  test("request_callback without a caller number reports not recorded", async () => {
    const body = await run("request_callback", { interaction_id: "i-6", caller_number: "" });
    assert.deepEqual(body, { ok: true, recorded: false, error: { code: "NO_CALLER_NUMBER" } });
    assert.equal((db.tables["leads"] ?? []).length, 0);
  });

  test("test callers get the recorded path but no lead is saved", async () => {
    const body = await run("request_callback", {
      interaction_id: "i-7",
      caller_number: "evals@sarvam.ai",
    });
    assert.deepEqual(body, { ok: true, recorded: true, test_call: true });
    assert.equal((db.tables["leads"] ?? []).length, 0);
  });

  describe("opt-out during a call", () => {
    const caller = "+919000000011";
    const leads = () => db.tables["leads"] ?? [];
    const events = (kind: string, id: string) =>
      (db.tables["sarvam_agent_events"] ?? []).filter(
        (e) => e["kind"] === kind && e["interaction_id"] === id,
      );

    test("1. callback saved, then opt-out: the saved lead is suppressed and later callbacks are refused", async () => {
      assert.equal(
        (await run("request_callback", { interaction_id: "o-1", caller_number: caller }))[
          "recorded"
        ],
        true,
      );
      assert.equal(leads().length, 1);
      assert.equal(leads()[0]!["status"] ?? "new", "new", "the database default; untouched");
      await run("record_call_outcome", {
        interaction_id: "o-1",
        caller_number: caller,
        outcome: "callback_requested",
        opted_out: "yes",
      });
      assert.equal(leads().length, 1, "no second lead");
      assert.equal(leads()[0]!["status"], "do_not_contact");
      // One auditable record: the call's outcome row carries the opt-out and what it suppressed.
      const recorded = events("call_outcome", "o-1");
      assert.equal(recorded.length, 1);
      const outcome = recorded[0]!["detail"] as Record<string, unknown>;
      assert.equal(outcome["opted_out"], true);
      assert.equal(outcome["suppressed_lead_id"], leads()[0]!["id"]);
      assert.equal(outcome["source"], "tool");
      // A callback arriving after the opt-out is on record is refused and saves nothing.
      assert.deepEqual(
        await run("request_callback", { interaction_id: "o-1", caller_number: caller }),
        { ok: true, recorded: false, error: { code: "CALLER_OPTED_OUT" } },
      );
      assert.equal(leads().length, 1);
    });

    test("1b. a retried end-of-call request still leaves the lead suppressed", async () => {
      await run("request_callback", { interaction_id: "o-1b", caller_number: caller });
      const end = {
        interaction_id: "o-1b",
        caller_number: caller,
        outcome: "callback_requested",
        opted_out: "yes",
      };
      await run("record_call_outcome", end);
      leads()[0]!["status"] = "new"; // e.g. the first suppression write was lost
      assert.deepEqual(await run("record_call_outcome", end), { ok: true, duplicate: true });
      assert.equal(leads()[0]!["status"], "do_not_contact");
      assert.equal(leads().length, 1);
    });

    test("2. opt-out on record first, then a callback: refused, no lead", async () => {
      await run("record_call_outcome", {
        interaction_id: "o-2",
        caller_number: caller,
        outcome: "not_interested",
        opted_out: "yes",
      });
      const res = await run("request_callback", {
        interaction_id: "o-2",
        caller_number: caller,
        customer_name: "Ravi",
      });
      assert.deepEqual(res, { ok: true, recorded: false, error: { code: "CALLER_OPTED_OUT" } });
      assert.equal(leads().length, 0);
      assert.equal(events("callback", "o-2")[0]!["status"], "rejected");
    });

    test("3. opt-out with no callback: no lead, even when the outcome says callback_requested", async () => {
      await run("record_call_outcome", {
        interaction_id: "o-3",
        caller_number: caller,
        outcome: "callback_requested",
        customer_name: "Ravi",
        opted_out: "yes",
      });
      assert.equal(leads().length, 0);
      const outcome = events("call_outcome", "o-3")[0]!["detail"] as Record<string, unknown>;
      assert.equal(outcome["opted_out"], true);
      assert.equal(outcome["suppressed_lead_id"], null);
    });

    test("4. callback without an opt-out keeps today's behaviour", async () => {
      await run("request_callback", { interaction_id: "o-4", caller_number: caller });
      await run("record_call_outcome", {
        interaction_id: "o-4",
        caller_number: caller,
        outcome: "callback_requested",
        opted_out: "no",
      });
      assert.equal(leads().length, 1);
      assert.equal(leads()[0]!["status"] ?? "new", "new", "the database default; untouched");
      const outcome = events("call_outcome", "o-4")[0]!["detail"] as Record<string, unknown>;
      assert.equal(outcome["opted_out"], false);
      assert.ok(!("suppressed_lead_id" in outcome));
    });

    test("an opt-out only touches this call's own lead in this organization", async () => {
      (db.tables["leads"] ??= []).push({
        id: "other-org-lead",
        organization_id: ORG_ABC,
        status: "new",
      });
      await run("request_callback", { interaction_id: "o-5", caller_number: caller });
      await run("record_call_outcome", {
        interaction_id: "o-5",
        caller_number: caller,
        outcome: "callback_requested",
        opted_out: "yes",
      });
      assert.equal(leads().find((l) => l["id"] === "other-org-lead")!["status"], "new");
    });

    test("record_call_outcome's recommended body is exactly the eight-field contract", () => {
      const tool = sarvamToolConfiguration("https://clickai.in").tools.find(
        (t) => t.name === "record_call_outcome",
      )!;
      assert.equal(tool.lifecycle, "on_end");
      assert.equal(
        tool.url,
        "https://clickai.in/api/public/sarvam/agent/tools/record_call_outcome",
      );
      assert.deepEqual(tool.body, {
        interaction_id: "@Interaction ID",
        caller_number: "@User Identifier",
        outcome: "@call_outcome",
        summary: "@call_summary",
        customer_name: "@customer_name",
        interest: "@caller_interest",
        requested_slot: "@requested_slot",
        opted_out: "@opted_out",
      });
    });

    test("integration: Sarvam's opted_out, sent through that body, reaches ClickAI and blocks the lead", async () => {
      // What Sarvam sends: each "@…" filled from the call's system and after-call variables.
      const tool = sarvamToolConfiguration("https://clickai.in").tools.find(
        (t) => t.name === "record_call_outcome",
      )!;
      const system: Record<string, string> = {
        "Interaction ID": "o-int",
        "User Identifier": caller,
      };
      const finalVariables: Record<string, string> = {
        call_outcome: "callback_requested",
        call_summary: "Asked for a callback, then asked not to be called again.",
        customer_name: "Ravi",
        caller_interest: "root canal",
        requested_slot: "",
        opted_out: "yes",
      };
      const fill = (vars: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(tool.body).map(([field, ref]) => {
            const name = ref.slice(1);
            return [field, system[name] ?? vars[name] ?? ""];
          }),
        );
      const sent = fill(finalVariables);
      assert.equal(sent["opted_out"], "yes", "the field reaches ClickAI");
      assert.deepEqual(await run("record_call_outcome", sent), { ok: true, duplicate: false });
      assert.equal(leads().length, 0, "no lead for an opt-out");
      const recorded = events("call_outcome", "o-int")[0]!["detail"] as Record<string, unknown>;
      assert.equal(recorded["opted_out"], true);

      // The same call without the opt-out (the old seven-field body) would have created a lead.
      const withoutOptOut = fill({ ...finalVariables, opted_out: "no" });
      withoutOptOut["interaction_id"] = "o-int-2";
      await run("record_call_outcome", withoutOptOut);
      assert.equal(leads().length, 1);
    });

    test("if this call's records cannot be read, no callback lead is saved (fails closed)", async () => {
      await run("record_call_outcome", {
        interaction_id: "o-7",
        caller_number: caller,
        outcome: "not_interested",
        opted_out: "yes",
      });
      db.failOn = "sarvam_agent_events";
      try {
        const res = await run("request_callback", { interaction_id: "o-7", caller_number: caller });
        assert.equal(res["recorded"], undefined, "not reported as recorded");
        assert.equal(res["ok"], false);
      } finally {
        db.failOn = null;
      }
      assert.equal(leads().length, 0);
    });

    test("an inbound caller with an unverified number cannot put any contact on do-not-call", async () => {
      // The claimed number belongs to contacts in this and another customer's workspace.
      const victim = "+919000000099";
      (db.tables["contacts"] ??= []).push(
        { id: "own-contact", organization_id: ORG_SMILE, phone: victim, opted_out: false },
        { id: "other-contact", organization_id: ORG_ABC, phone: victim, opted_out: false },
      );
      await run("record_call_outcome", {
        interaction_id: "o-6",
        caller_number: victim,
        outcome: "not_interested",
        opted_out: "yes",
      });
      assert.ok(
        db.tables["contacts"]!.every((c) => c["opted_out"] === false),
        "no contact is identified or updated from a caller number",
      );
      assert.equal(
        (events("call_outcome", "o-6")[0]!["detail"] as Record<string, unknown>)["opted_out"],
        true,
        "the opt-out itself is still recorded",
      );
    });
  });

  test("callFacts reports what the tools actually did", () => {
    assert.deepEqual(
      callFacts([
        {
          kind: "check_availability",
          status: "ok",
          detail: { service_id: "s1", available: false },
        },
        {
          kind: "book_appointment",
          status: "ok",
          detail: { outcome: "not_booked", error_code: "TEST_CALL_NOT_SAVED" },
        },
      ]),
      {
        availability_checked: true,
        requested_time_available: false,
        service_id: "s1",
        booking_outcome: "not_booked",
        booking_id: null,
        booking_error: "TEST_CALL_NOT_SAVED",
        callback_recorded: false,
        lead_id: null,
        opted_out: false,
        appointment_changed: null,
        changed_booking_id: null,
      },
    );
  });

  test("callFacts reports a moved or cancelled appointment only from ClickAI's own ok record", () => {
    const facts = (events: Parameters<typeof callFacts>[0]) => callFacts(events);
    const moved = facts([
      {
        kind: "reschedule_appointment",
        status: "ok",
        detail: { booking_id: "b1", outcome: "rescheduled" },
      },
    ]);
    assert.equal(moved.appointment_changed, "rescheduled");
    assert.equal(moved.changed_booking_id, "b1");
    const cancelled = facts([
      { kind: "reschedule_appointment", status: "ok", detail: { booking_id: "b1" } },
      {
        kind: "cancel_appointment",
        status: "ok",
        detail: { booking_id: "b1", outcome: "cancelled" },
      },
    ]);
    assert.equal(cancelled.appointment_changed, "cancelled", "the last confirmed change wins");
    for (const status of ["error", "rejected"]) {
      const none = facts([
        {
          kind: "reschedule_appointment",
          status,
          detail: { booking_id: "b1", outcome: "not_changed" },
        },
        { kind: "cancel_appointment", status, detail: { booking_id: "b1" } },
      ]);
      assert.equal(none.appointment_changed, null, status);
      assert.equal(none.changed_booking_id, null);
    }
  });

  test("the context carries each tenant's own greeting", async () => {
    db.tables["agent_configs"]!.find((a) => a["organization_id"] === ORG_ABC)!["greetings"] = {
      "en-IN": "Thank you for calling {business_name}. How can I help you?",
    };
    const smile = await call("context", tokens[ORG_SMILE]!, { interaction_id: "g-1" });
    const abc = await call("context", tokens[ORG_ABC]!, { interaction_id: "g-2" });
    assert.equal(smile.body["greeting"], "Welcome to Smile Dental. How can I help you today?");
    assert.equal(abc.body["greeting"], "Thank you for calling ABC Dental. How can I help you?");
  });
});

describe("inbound admission gate at the HTTP boundary (Phase 5)", () => {
  const numberOf = (org: string) =>
    db.tables["phone_numbers"]!.find((n) => n["organization_id"] === org)!;
  const NOT_ADMITTED: [string, Record<string, unknown>][] = [
    ["provisioning number", { status: "provisioning" }],
    ["paused / inbound off", { inbound_enabled: false }],
    ["failed number", { status: "suspended" }],
    ["no deployment", { provider_deployment_id: null }],
    [
      "unverified mapping",
      {
        verified_deployment_id: null,
        verified_sarvam_app_id: null,
        verified_sarvam_app_version: null,
      },
    ],
    ["deployment mismatch", { verified_deployment_id: "dep-old" }],
    ["agent mismatch", { verified_sarvam_app_id: "App-old" }],
    ["version mismatch", { verified_sarvam_app_version: 2 }],
    ["blocked", { admission_blocked_at: "2026-11-11T04:00:00Z" }],
    ["released", { status: "released" }],
  ];
  for (const [name, patch] of NOT_ADMITTED)
    test(`${name}: context, business info and tools all refused with no business data`, async () => {
      Object.assign(numberOf(ORG_SMILE), patch);
      for (const path of [
        "context",
        "tools/get_business_info",
        "tools/check_availability",
        "tools/book_appointment",
      ]) {
        const r = await call(path, tokens[ORG_SMILE]!, { date: "2026-11-12", time: "10:00" });
        assert.equal(r.status, 403, `${name} ${path}`);
        assert.equal(r.body["error"], "not_admitted");
        assert.doesNotMatch(JSON.stringify(r.body), /Smile Dental|Dr\. Meera|500|parking/i);
      }
      assert.equal(toolCalls.length, 0, "no tool ever ran");
      // The other customer is unaffected.
      assert.equal((await call("context", tokens[ORG_ABC]!)).status, 200);
    });

  test("a body naming another tenant's deployment or number never changes who is admitted", async () => {
    Object.assign(numberOf(ORG_SMILE), { status: "provisioning" });
    const r = await call("context", tokens[ORG_SMILE]!, {
      deployment_id: "dep-org-abc",
      phone_number: "+917900000002",
      organization_id: ORG_ABC,
    });
    assert.equal(r.status, 403);
  });

  test("a database failure while checking admission refuses (fails closed)", async () => {
    db.failOn = "phone_numbers";
    const r = await call("context", tokens[ORG_SMILE]!);
    assert.equal(r.status, 403);
    db.failOn = null;
  });

  test("a refused request is audited as rejected under its own tenant, without secrets", async () => {
    Object.assign(numberOf(ORG_SMILE), { status: "provisioning" });
    await call("context", tokens[ORG_SMILE]!);
    const ev = db.tables["sarvam_agent_events"]!.at(-1)!;
    assert.equal(ev["organization_id"], ORG_SMILE);
    assert.equal(ev["status"], "rejected");
    assert.doesNotMatch(JSON.stringify(ev), new RegExp(tokens[ORG_SMILE]!));
  });
});

describe("outbound calls: inbound-only tools refuse, identified by ClickAI's own call id", () => {
  const OUT_ID = "8f14e45f-ceea-467e-a4a9-1c1c1c1c1c1c";
  const DIALLED = "+919811122233";
  const outboundRow = (over: Record<string, unknown> = {}) =>
    (db.tables["call_logs"] ??= []).push({
      id: OUT_ID,
      organization_id: ORG_SMILE,
      provider: "sarvam",
      direction: "outbound",
      status: "initiated",
      started_at: NOW.toISOString(),
      destination_number: DIALLED,
      ...over,
    });
  const booking = () => {
    const inputs: Record<string, unknown>[] = [];
    const d: AgentApiDeps = {
      ...deps(),
      executeTool: async (_c, name, input) => {
        inputs.push({ name, ...input });
        return {
          content: JSON.stringify({
            success: true,
            bookingOutcome: "confirmed",
            data: { id: "b" },
          }),
        };
      },
    };
    return { inputs, d };
  };
  const book = (body: Record<string, unknown>, d: AgentApiDeps) =>
    handleSarvamAgentRequest(
      sarvamRequest("tools/book_appointment", tokens[ORG_SMILE]!, {
        interaction_id: "20261119/out-1",
        date: "2026-11-14",
        time: "10:00",
        customer_name: "Ravi",
        ...body,
      }),
      "book_appointment",
      d,
    );

  test("an open outbound call books for the dialled number, never the caller id the agent sent", async () => {
    outboundRow();
    for (const sent of ["", "user-identifier-xyz", "+919000000001"]) {
      const { inputs, d } = booking();
      const res = await book({ customer_phone: sent, clickai_call_id: OUT_ID }, d);
      const body = (await res.json()) as {
        result: { success: boolean; bookingOutcome?: string };
      };
      assert.equal(body.result.success, true, `agent sent "${sent}"`);
      assert.equal(body.result.bookingOutcome, "confirmed");
      assert.equal(inputs.length, 1, "one booking request");
      assert.equal(inputs[0]!["name"], "book_appointment");
      assert.equal(inputs[0]!["customerPhone"], DIALLED, `agent sent "${sent}"`);
      assert.equal(inputs[0]!["customerName"], "Ravi");
    }
    const event = db.tables["sarvam_agent_events"]!.filter(
      (e) => e["kind"] === "book_appointment",
    ).at(-1)!;
    assert.equal(event["status"], "ok");
    assert.equal((event["detail"] as { outbound_call?: boolean }).outbound_call, true);
  });

  test("an ended call, or one older than 15 minutes, cannot book; nothing is written", async () => {
    for (const over of [
      { status: "completed" },
      { status: "failed" },
      { status: "outcome_unknown" },
      { started_at: new Date(NOW.getTime() - 16 * 60_000).toISOString() },
    ]) {
      db.tables["call_logs"] = [];
      outboundRow(over);
      const { inputs, d } = booking();
      const res = await book({ clickai_call_id: OUT_ID }, d);
      const body = (await res.json()) as { result: { success: boolean; error: { code: string } } };
      assert.equal(body.result.success, false, JSON.stringify(over));
      assert.equal(body.result.error.code, "OUTBOUND_CALL_NOT_OPEN");
      assert.equal(inputs.length, 0, "no calendar call");
    }
  });

  test("without the person's name nothing is booked and the agent is told to ask for it", async () => {
    outboundRow();
    const { inputs, d } = booking();
    const res = await book({ clickai_call_id: OUT_ID, customer_name: "" }, d);
    const body = (await res.json()) as {
      result: { success: boolean; error: { code: string; message: string } };
    };
    assert.equal(body.result.success, false);
    assert.equal(body.result.error.code, "CUSTOMER_NAME_REQUIRED");
    assert.match(body.result.error.message, /ask for the person's name/);
    assert.equal(inputs.length, 0);
  });

  test("a slot taken since the lookup, or a backend failure, is reported as not booked", async () => {
    outboundRow();
    for (const failure of [
      { success: false, error: { code: "SLOT_UNAVAILABLE", message: "That time was just taken." } },
      { success: false, error: { code: "BOOKING_FAILED", message: "Database unavailable." } },
      { success: false, error: { code: "BOOKING_NOT_ACTIVE", message: "Cancelled." } },
    ]) {
      const d: AgentApiDeps = {
        ...deps(),
        executeTool: async () => ({ content: JSON.stringify(failure), isError: true }),
      };
      const res = await book({ clickai_call_id: OUT_ID }, d);
      const body = (await res.json()) as {
        ok: boolean;
        result: { success: boolean; bookingOutcome?: string; error: { code: string } };
      };
      assert.equal(body.ok, false, failure.error.code);
      assert.equal(body.result.success, false);
      assert.equal(body.result.bookingOutcome, undefined, "never a confirmation");
      assert.equal(body.result.error.code, failure.error.code);
      const event = db.tables["sarvam_agent_events"]!.filter(
        (e) => e["kind"] === "book_appointment",
      ).at(-1)!;
      assert.equal((event["detail"] as { outcome: string }).outcome, "not_booked");
    }
  });

  test("a calendar sync failure is passed on as saved-not-confirmed, never as confirmed", async () => {
    outboundRow();
    const d: AgentApiDeps = {
      ...deps(),
      executeTool: async () => ({
        content: JSON.stringify({
          success: true,
          bookingOutcome: "saved_calendar_sync_failed",
          data: { id: "b-1" },
        }),
      }),
    };
    const res = await book({ clickai_call_id: OUT_ID }, d);
    const body = (await res.json()) as { result: { bookingOutcome: string } };
    assert.equal(body.result.bookingOutcome, "saved_calendar_sync_failed");
    assert.doesNotMatch(JSON.stringify(body), /"confirmed"/);
  });

  test("the same booking sent twice in one call uses one idempotency key (no second booking)", async () => {
    outboundRow();
    const contexts: { callId?: string | undefined }[] = [];
    const d: AgentApiDeps = {
      ...deps(),
      executeTool: async (ctx) => {
        contexts.push(ctx);
        return { content: JSON.stringify({ success: true, bookingOutcome: "confirmed" }) };
      },
    };
    await book({ clickai_call_id: OUT_ID }, d);
    await book({ clickai_call_id: OUT_ID }, d);
    assert.equal(contexts.length, 2);
    // ai-tools book_appointment keys the booking on ctx.callId + the slot, so
    // create_calendar_event returns the first booking for the second request.
    assert.equal(contexts[0]!.callId, "sarvam-20261119/out-1");
    assert.equal(contexts[1]!.callId, contexts[0]!.callId);
  });

  test("a dialled test-caller number is checked like a booking but never saved", async () => {
    outboundRow();
    db.tables["sarvam_agent_integrations"]!.find((r) => r["organization_id"] === ORG_SMILE)![
      "test_caller_numbers"
    ] = [DIALLED];
    const calls: string[] = [];
    const d: AgentApiDeps = {
      ...deps(),
      executeTool: async (_c, name) => {
        calls.push(name);
        return { content: JSON.stringify({ success: true, data: { slots: [] } }) };
      },
    };
    const res = await book({ customer_phone: "+919000000001", clickai_call_id: OUT_ID }, d);
    const body = (await res.json()) as { result: { success: boolean; error: { code: string } } };
    assert.equal(body.result.success, false);
    assert.equal(body.result.error.code, "TEST_CALL_NOT_SAVED");
    assert.deepEqual(calls, ["check_calendar_availability"], "no booking written");
  });

  test("another customer's call id, an inbound row or a malformed id changes nothing", async () => {
    outboundRow({ organization_id: ORG_ABC });
    (db.tables["call_logs"] ??= []).push({
      id: "11111111-2222-4333-8444-555555555555",
      organization_id: ORG_SMILE,
      provider: "sarvam",
      direction: "inbound",
      destination_number: DIALLED,
    });
    for (const id of [OUT_ID, "11111111-2222-4333-8444-555555555555", "not-a-uuid", ""]) {
      const { inputs, d } = booking();
      await book({ customer_phone: "+919000000001", clickai_call_id: id }, d);
      assert.equal(inputs[0]!["customerPhone"], "+919000000001", id);
    }
  });

  test("an outbound call records no mid-call callback: it is saved from the call result", async () => {
    outboundRow();
    const leadsBefore = (db.tables["leads"] ?? []).length;
    const res = await handleSarvamAgentRequest(
      sarvamRequest("tools/request_callback", tokens[ORG_SMILE]!, {
        interaction_id: "20261119/out-2",
        caller_number: "+919000000001",
        clickai_call_id: OUT_ID,
        customer_name: "Ravi",
      }),
      "request_callback",
      deps(),
    );
    const body = (await res.json()) as { recorded: boolean; error: { code: string } };
    assert.equal(body.recorded, false, "never claims a callback it did not save");
    assert.equal(body.error.code, "OUTBOUND_USE_CALL_RESULT");
    assert.equal((db.tables["leads"] ?? []).length, leadsBefore, "no lead here");
  });

  test("check_availability still answers on an outbound call (read-only)", async () => {
    outboundRow();
    const res = await handleSarvamAgentRequest(
      sarvamRequest("tools/check_availability", tokens[ORG_SMILE]!, {
        interaction_id: "20261119/out-3",
        date: "2026-11-14",
        clickai_call_id: OUT_ID,
      }),
      "check_availability",
      deps(),
    );
    assert.equal(res.status, 200);
  });
});

describe("dual agents: the outbound agent's credential is limited by role", () => {
  /** Gives a customer a second, OUTBOUND credential (and optionally registers its outbound agent). */
  async function outboundCredential(
    org: string,
    opts: { registered?: boolean; role?: string } = {},
  ) {
    const { token, hash, prefix } = await generateIntegrationToken();
    db.tables["sarvam_agent_integrations"]!.push({
      id: `int-out-${org}`,
      organization_id: org,
      agent_config_id: `agent-${org}`,
      token_hash: hash,
      token_prefix: prefix,
      status: "active",
      expires_at: null,
      role: opts.role ?? "outbound",
    });
    if (opts.registered !== false) {
      const agent = db.tables["agent_configs"]!.find((a) => a["organization_id"] === org)!;
      Object.assign(agent, {
        sarvam_outbound_app_id: `Out-${org}`,
        sarvam_outbound_app_version: 1,
      });
    }
    return token;
  }
  const rejectedEvents = () =>
    (db.tables["sarvam_agent_events"] ?? []).filter(
      (e) =>
        e["status"] === "rejected" &&
        (e["detail"] as Record<string, unknown> | null)?.["error_code"] ===
          "OUTBOUND_AGENT_TOOL_FORBIDDEN",
    );

  test("callbacks are refused for the outbound credential, whatever the body says", async () => {
    const token = await outboundCredential(ORG_SMILE);
    const r = await call("tools/request_callback", token, {
      customer_name: "A",
      reason: "book",
      call_direction: "inbound",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body["error"], "forbidden_for_outbound_agent");
    assert.doesNotMatch(JSON.stringify(r.body), /RECORDED/);
    assert.equal(toolCalls.length, 0, "no callback tool ever ran");
    assert.equal(rejectedEvents().length, 1, "the refusal is audited");
    assert.equal(rejectedEvents()[0]!["organization_id"], ORG_SMILE);
  });

  test("the outbound credential books only on an open call ClickAI placed, for the dialled number", async () => {
    const token = await outboundCredential(ORG_SMILE);
    const CALL = "8f14e45f-ceea-467e-a4a9-2d2d2d2d2d2d";
    const slot = {
      interaction_id: "20261111/out-book",
      date: "2026-11-12",
      time: "10:00",
      customer_name: "A",
      customer_phone: "+919000000001",
    };
    // No ClickAI call id (or another customer's call): refused, nothing written.
    for (const id of ["", CALL]) {
      const r = await call("tools/book_appointment", token, { ...slot, clickai_call_id: id });
      const result = r.body["result"] as { success: boolean; error: { code: string } };
      assert.equal(result.success, false, id);
      assert.equal(result.error.code, "OUTBOUND_CALL_NOT_VERIFIED", id);
    }
    (db.tables["call_logs"] ??= []).push({
      id: CALL,
      organization_id: ORG_ABC,
      provider: "sarvam",
      direction: "outbound",
      status: "initiated",
      started_at: NOW.toISOString(),
      destination_number: "+919811100000",
    });
    const other = await call("tools/book_appointment", token, { ...slot, clickai_call_id: CALL });
    assert.equal(
      (other.body["result"] as { error: { code: string } }).error.code,
      "OUTBOUND_CALL_NOT_VERIFIED",
      "another customer's call id",
    );
    assert.equal(toolCalls.length, 0, "nothing booked so far");
    // The customer's own open call: booked for the number ClickAI dialled.
    db.tables["call_logs"]!.at(-1)!["organization_id"] = ORG_SMILE;
    const ok = await call("tools/book_appointment", token, { ...slot, clickai_call_id: CALL });
    assert.equal(ok.status, 200);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]!.name, "book_appointment");
    assert.equal(toolCalls[0]!.ctx.organizationId, ORG_SMILE);
    assert.equal(toolCalls[0]!.input["customerPhone"], "+919811100000");
  });

  test("the outbound credential may read business data, check availability and record the outcome", async () => {
    const token = await outboundCredential(ORG_SMILE);
    const ctx = await call("context", token);
    assert.equal(ctx.status, 200);
    assert.equal(ctx.body["business_name"], "Smile Dental");
    const info = await call("tools/get_business_info", token, { organization_id: ORG_ABC });
    assert.equal(info.body["business_name"], "Smile Dental", "never another customer's data");
    assert.doesNotMatch(JSON.stringify(info.body), /ABC Dental|₹700/);
    const avail = await call("tools/check_availability", token, { date: "2026-11-12" });
    assert.equal(avail.status, 200);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]!.ctx.organizationId, ORG_SMILE);
    assert.notEqual(toolCalls[0]!.name, "book_appointment");
    const outcome = await call("tools/record_call_outcome", token, {
      interaction_id: "20261111/out-1",
      outcome: "not_interested",
      opted_out: "yes",
    });
    assert.equal(outcome.status, 200);
    assert.equal(rejectedEvents().length, 0);
  });

  test("an outbound credential without a registered outbound agent gets no data", async () => {
    const token = await outboundCredential(ORG_SMILE, { registered: false });
    const r = await call("context", token);
    assert.equal(r.status, 403);
    assert.equal(r.body["error"], "not_admitted");
    assert.doesNotMatch(JSON.stringify(r.body), /Smile Dental/);
  });

  test("an unknown role fails closed (no inbound rights by default)", async () => {
    const token = await outboundCredential(ORG_SMILE, { role: "admin" });
    const r = await call("tools/book_appointment", token, { date: "2026-11-12", time: "10:00" });
    assert.equal(r.status, 401);
    assert.equal(toolCalls.length, 0);
  });

  test("the inbound credential keeps its tools (inbound bookings are not affected)", async () => {
    await outboundCredential(ORG_SMILE);
    const r = await call("tools/check_availability", tokens[ORG_SMILE]!, { date: "2026-11-12" });
    assert.equal(r.status, 200);
    assert.equal(toolCalls.length, 1);
  });

  test("the outbound template carries only the allowed tools and the outbound call variables", () => {
    const cfg = sarvamToolConfiguration("https://clickai.in", "outbound");
    assert.deepEqual(cfg.tools.map((t) => t.name).sort(), [
      "book_appointment",
      "cancel_appointment",
      "check_availability",
      "clickai_business_context",
      "get_business_info",
      "list_appointments",
      "record_call_outcome",
      "reschedule_appointment",
    ]);
    // Booking sends ClickAI's own call id, so the server books for the dialled number.
    const bookTool = cfg.tools.find((t) => t.name === "book_appointment")!;
    assert.equal(bookTool.body["clickai_call_id"], "@clickai_call_id");
    // The agent's generated prompt carries the whole flow and never claims a booking
    // without confirmation (full coverage in sarvam-agent-prompt.test.ts).
    for (const step of [
      /check_availability/,
      /times the tool returned/,
      /ask for their name/,
      /book_appointment/,
      /bookingOutcome "confirmed"/,
      /NOT booked/,
    ])
      assert.match(cfg.systemPrompt ?? "", step);
    const names = cfg.inputVariables.map((v) => v.name);
    for (const v of [
      "call_direction",
      "clickai_call_id",
      "campaign_objective",
      "campaign_instructions",
    ])
      assert.ok(names.includes(v), v);
    assert.ok(cfg.outputVariables.some((v) => v.name === "opted_out"));
    assert.doesNotMatch(JSON.stringify(cfg.tools), /request_callback|send_reminder|call_transfer/);
    // The inbound template is unchanged by the role parameter.
    assert.deepEqual(
      sarvamToolConfiguration("https://clickai.in"),
      sarvamToolConfiguration("https://clickai.in", "inbound"),
    );
    assert.ok(
      sarvamToolConfiguration("https://clickai.in").tools.some(
        (t) => t.name === "book_appointment",
      ),
    );
  });
});

describe("outbound agents can look at, move and cancel the dialled person's own appointments", () => {
  const OUT_ID = "9a14e45f-ceea-467e-a4a9-1c1c1c1c1c1c";
  const DIALLED = "+919811122233";
  const OTHER_PERSON = "+919000000099";
  const BIZ = "biz-org-smile";
  // 2026-11-11 10:00 IST is NOW; these are tomorrow 15:00 IST and the day after 10:00 IST.
  const TOMORROW_3PM = "2026-11-12T09:30:00.000Z";
  const outRow = (over: Record<string, unknown> = {}) =>
    (db.tables["call_logs"] ??= []).push({
      id: OUT_ID,
      organization_id: ORG_SMILE,
      provider: "sarvam",
      direction: "outbound",
      status: "initiated",
      started_at: NOW.toISOString(),
      destination_number: DIALLED,
      ...over,
    });
  const bookingRow = (id: string, over: Record<string, unknown> = {}) =>
    (db.tables["bookings"] ??= []).push({
      id,
      organization_id: ORG_SMILE,
      business_id: BIZ,
      customer_phone: DIALLED,
      status: "CONFIRMED",
      start_at: TOMORROW_3PM,
      end_at: "2026-11-12T10:00:00.000Z",
      service_id: "svc-org-smile",
      ...over,
    });
  async function outboundToken(role = "outbound") {
    const { token, hash, prefix } = await generateIntegrationToken();
    db.tables["sarvam_agent_integrations"]!.push({
      id: `int-appt-${role}`,
      organization_id: ORG_SMILE,
      agent_config_id: `agent-${ORG_SMILE}`,
      token_hash: hash,
      token_prefix: prefix,
      status: "active",
      expires_at: null,
      role,
    });
    const agent = db.tables["agent_configs"]!.find((a) => a["organization_id"] === ORG_SMILE)!;
    Object.assign(agent, { sarvam_outbound_app_id: "Out-smile", sarvam_outbound_app_version: 1 });
    return token;
  }
  const run = async (
    tool: string,
    token: string,
    body: Record<string, unknown>,
    over: Partial<AgentApiDeps> = {},
  ) => {
    const res = await handleSarvamAgentRequest(
      sarvamRequest(`tools/${tool}`, token, {
        interaction_id: "20261125/appt-1",
        clickai_call_id: OUT_ID,
        ...body,
      }),
      tool,
      { ...deps(), ...over },
    );
    return {
      status: res.status,
      body: (await res.json()) as {
        ok: boolean;
        appointments?: { appointment_id: string; date: string; time: string; service: string }[];
        result?: {
          success: boolean;
          rescheduled?: boolean;
          cancelled?: boolean;
          error?: { code: string; message: string };
          data?: Record<string, unknown>;
        };
      },
    };
  };
  const lastEvent = (kind: string) =>
    (db.tables["sarvam_agent_events"] ?? []).filter((e) => e["kind"] === kind).at(-1);
  const movedTo = () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const executeTool: AgentApiDeps["executeTool"] = async (_c, name, input) => {
      calls.push({ name, input });
      return { content: JSON.stringify({ success: true, data: { id: input["bookingId"] } }) };
    };
    return { calls, executeTool };
  };

  test("list: only this number's own upcoming, active appointments in this business", async () => {
    outRow();
    bookingRow("mine-1");
    bookingRow("mine-2", {
      start_at: "2026-11-13T04:30:00.000Z",
      end_at: "2026-11-13T05:00:00.000Z",
    });
    bookingRow("someone-else", { customer_phone: OTHER_PERSON });
    bookingRow("past", {
      start_at: "2026-11-10T04:30:00.000Z",
      end_at: "2026-11-10T05:00:00.000Z",
    });
    bookingRow("cancelled", { status: "CANCELLED" });
    bookingRow("other-business", { business_id: "biz-other" });
    bookingRow("other-org", { organization_id: ORG_ABC });
    const token = await outboundToken();
    const r = await run("list_appointments", token, {});
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.appointments!.map((a) => a.appointment_id),
      ["mine-1", "mine-2"],
    );
    assert.deepEqual(r.body.appointments![0], {
      appointment_id: "mine-1",
      date: "2026-11-12",
      time: "15:00",
      service: "Consultation",
    });
    assert.equal(lastEvent("list_appointments")!["status"], "ok");
  });

  test("reschedule: the booking engine moves it, keeping its length, and the audit says so", async () => {
    outRow();
    bookingRow("mine-1");
    const token = await outboundToken();
    const { calls, executeTool } = movedTo();
    const r = await run(
      "reschedule_appointment",
      token,
      { appointment_id: "mine-1", date: "2026-11-14", time: "11:00" },
      { executeTool },
    );
    assert.equal(r.body.result!.success, true);
    assert.equal(r.body.result!.rescheduled, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "reschedule_appointment");
    assert.deepEqual(calls[0]!.input, {
      bookingId: "mine-1",
      newStartIso: "2026-11-14T05:30:00.000Z", // 11:00 IST
      newEndIso: "2026-11-14T06:00:00.000Z", // the same 30 minutes
    });
    const event = lastEvent("reschedule_appointment")!;
    assert.equal(event["status"], "ok");
    assert.equal((event["detail"] as { outcome: string }).outcome, "rescheduled");
  });

  test("reschedule: a slot taken, a backend error or an unreadable reply is never reported as moved", async () => {
    outRow();
    bookingRow("mine-1");
    const token = await outboundToken();
    const replies = [
      {
        content: JSON.stringify({
          success: false,
          error: {
            code: "SLOT_NO_LONGER_AVAILABLE",
            message: "That time slot is no longer available.",
          },
        }),
      },
      {
        content: JSON.stringify({
          success: false,
          error: { code: "TOOL_NOT_PERMITTED", message: "Not permitted." },
        }),
        isError: true,
      },
      { content: "not json at all" },
      { content: JSON.stringify({ data: {} }) },
    ];
    for (const reply of replies) {
      const r = await run(
        "reschedule_appointment",
        token,
        { appointment_id: "mine-1", date: "2026-11-14", time: "11:00" },
        { executeTool: async () => reply },
      );
      assert.equal(r.body.ok, false, reply.content);
      assert.equal(r.body.result!.success, false);
      assert.equal(r.body.result!.rescheduled, undefined, "never a confirmation");
      assert.ok(r.body.result!.error!.code);
      const detail = lastEvent("reschedule_appointment")!["detail"] as { outcome: string };
      assert.equal(detail.outcome, "not_changed");
    }
  });

  test("reschedule: another person's appointment, an unknown id or a time in the past changes nothing", async () => {
    outRow();
    bookingRow("someone-else", { customer_phone: OTHER_PERSON });
    bookingRow("mine-1");
    const token = await outboundToken();
    const { calls, executeTool } = movedTo();
    for (const body of [
      { appointment_id: "someone-else", date: "2026-11-14", time: "11:00" },
      { appointment_id: "does-not-exist", date: "2026-11-14", time: "11:00" },
    ]) {
      const r = await run("reschedule_appointment", token, body, { executeTool });
      assert.equal(r.body.result!.success, false);
      assert.equal(r.body.result!.error!.code, "APPOINTMENT_NOT_FOUND");
    }
    const past = await run(
      "reschedule_appointment",
      token,
      { appointment_id: "mine-1", date: "2026-11-11", time: "08:00" },
      { executeTool },
    );
    assert.equal(past.body.result!.error!.code, "TIME_IN_PAST");
    assert.equal(calls.length, 0, "the booking engine was never asked");
  });

  test("cancel: needs the person's confirmation first, then cancels exactly that appointment", async () => {
    outRow();
    bookingRow("mine-1");
    const token = await outboundToken();
    const cancelled: Record<string, unknown>[] = [];
    const cancelAppointment: AgentApiDeps["cancelAppointment"] = async (input) => {
      cancelled.push(input as unknown as Record<string, unknown>);
      return { success: true };
    };
    const asked = await run(
      "cancel_appointment",
      token,
      { appointment_id: "mine-1" },
      { cancelAppointment },
    );
    assert.equal(asked.body.result!.error!.code, "CONFIRMATION_REQUIRED");
    assert.equal(cancelled.length, 0);
    const done = await run(
      "cancel_appointment",
      token,
      { appointment_id: "mine-1", confirmed: "true" },
      { cancelAppointment },
    );
    assert.equal(done.body.result!.cancelled, true);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]!["bookingId"], "mine-1");
    assert.equal(cancelled[0]!["organizationId"], ORG_SMILE);
    assert.equal(
      (lastEvent("cancel_appointment")!["detail"] as { outcome: string }).outcome,
      "cancelled",
    );
  });

  test("cancel: a refused cancellation (capability off, error) is never reported as cancelled", async () => {
    outRow();
    bookingRow("mine-1");
    const token = await outboundToken();
    const r = await run(
      "cancel_appointment",
      token,
      { appointment_id: "mine-1", confirmed: true },
      {
        cancelAppointment: async () => ({
          success: false,
          error: {
            code: "TOOL_NOT_PERMITTED",
            message: "This agent is not permitted to use calendar_cancel.",
          },
        }),
      },
    );
    assert.equal(r.body.ok, false);
    assert.equal(r.body.result!.success, false);
    assert.equal(r.body.result!.cancelled, undefined);
    assert.equal(r.body.result!.error!.code, "TOOL_NOT_PERMITTED");
  });

  test("an inbound credential, an unverified call and an ended call cannot touch appointments", async () => {
    bookingRow("mine-1");
    const { calls, executeTool } = movedTo();
    const inbound = await outboundToken("inbound");
    outRow();
    const asInbound = await run("list_appointments", inbound, {});
    assert.equal(asInbound.body.result!.error!.code, "OUTBOUND_ONLY");
    const token = await outboundToken();
    const unverified = await run("list_appointments", token, { clickai_call_id: "" });
    assert.equal(unverified.body.result!.error!.code, "OUTBOUND_CALL_NOT_VERIFIED");
    db.tables["call_logs"] = [];
    outRow({ status: "completed" });
    const ended = await run(
      "reschedule_appointment",
      token,
      { appointment_id: "mine-1", date: "2026-11-14", time: "11:00" },
      { executeTool },
    );
    assert.equal(ended.body.result!.error!.code, "OUTBOUND_CALL_NOT_OPEN");
    assert.equal(calls.length, 0);
  });

  test("another customer's credential never sees this customer's appointments", async () => {
    outRow();
    bookingRow("mine-1");
    const { token, hash, prefix } = await generateIntegrationToken();
    db.tables["sarvam_agent_integrations"]!.push({
      id: "int-abc-out",
      organization_id: ORG_ABC,
      agent_config_id: `agent-${ORG_ABC}`,
      token_hash: hash,
      token_prefix: prefix,
      status: "active",
      expires_at: null,
      role: "outbound",
    });
    Object.assign(
      db.tables["agent_configs"]!.find((a) => a["organization_id"] === ORG_ABC)!,
      {
        sarvam_outbound_app_id: "Out-abc",
        sarvam_outbound_app_version: 1,
      },
    );
    // ABC's credential names SMILE's outbound call id: the call is not ABC's, so it is not verified.
    const r = await run("list_appointments", token, {});
    assert.equal(r.body.result!.error!.code, "OUTBOUND_CALL_NOT_VERIFIED");
    assert.equal(r.body.appointments, undefined);
  });
});

describe("a wrongly selected credential is refused (fixed agent_ref on every tool)", () => {
  // The tool is on ABC's agent (it sends ABC's reference); Smile's credential was picked.
  const abc = `inbound:agent-${ORG_ABC}`;
  const smile = `inbound:agent-${ORG_SMILE}`;
  const body = (agent_ref: unknown) => ({
    agent_ref,
    interaction_id: "20261111/x",
    caller_number: "+919000000001",
    date: "2026-11-12",
    time: "10:00",
    reason: "call back",
  });
  const paths = [
    "context",
    "tools/get_business_info",
    "tools/check_availability",
    "tools/book_appointment",
    "tools/request_callback",
    "tools/record_call_outcome",
  ];

  test("no data is served and nothing runs, on any of the six endpoints", async () => {
    for (const path of paths) {
      const r = await call(path, tokens[ORG_SMILE]!, body(abc));
      assert.equal(r.status, 403, path);
      assert.equal(r.body["error"], "credential_mismatch", path);
      assert.doesNotMatch(JSON.stringify(r.body), /Smile|ABC|₹|Meera/, path);
    }
    assert.equal(toolCalls.length, 0);
    assert.equal(db.tables["leads"]?.length ?? 0, 0);
  });

  test("another role's reference or a non-text value is refused too", async () => {
    for (const ref of [`outbound:agent-${ORG_SMILE}`, "", 7, null, [smile]])
      assert.equal(
        (await call("context", tokens[ORG_SMILE]!, body(ref))).status,
        403,
        JSON.stringify(ref),
      );
  });

  test("the matching reference works, and agents built before the field existed still do", async () => {
    for (const b of [body(smile), { interaction_id: "20261111/y" }]) {
      const r = await call("context", tokens[ORG_SMILE]!, b);
      assert.equal(r.status, 200);
      assert.equal(r.body["business_name"], "Smile Dental");
    }
  });
});
