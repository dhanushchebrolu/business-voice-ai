import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_TOOLS,
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
          rows().push({ id: crypto.randomUUID(), ...r });
        }
        return { data: op.rows, error: null };
      }
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (op.kind === "update") {
        for (const r of matched) Object.assign(r, (op as { payload: Row }).payload);
      }
      return { data: matched.map((r) => ({ ...r })), error: null };
    };
    const builder = {
      select: () => builder,
      eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), builder),
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
    });
    (db.tables["sarvam_agent_integrations"] ??= []).push({
      id: `int-${org}`,
      organization_id: org,
      agent_config_id: agent,
      token_hash: hash,
      token_prefix: prefix,
      status: "active",
      expires_at: null,
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

describe("Sarvam configuration brief", () => {
  test("every configured tool targets a real endpoint and uses bearer auth", () => {
    const cfg = sarvamToolConfiguration("https://clickai.in/");
    assert.deepEqual(
      cfg.tools.map((t) => t.lifecycle),
      ["on_start", "run", "run", "run", "on_end"],
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
