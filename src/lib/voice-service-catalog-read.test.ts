import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { ServiceRow } from "./service-matching.ts";

/**
 * Production incident (Smile Dental, "Root canal"): when the configured
 * services read failed — e.g. PostgREST answered PGRST303 — the runtime used
 * the failure as an EMPTY catalog and cached it for the rest of the call, so
 * nothing the caller said could ever match a service.
 *
 * Runs the real voice runtime with a fake admin client (same lazy-Proxy
 * shape client.server.ts exports) whose `services` read fails first, then
 * succeeds.
 */

const CLIENT_SPECIFIER = "@/integrations/supabase/client.server";
const FAKE_CLIENT_MODULE = `
const target = () => globalThis.__fakeSupabaseAdmin;
export const supabaseAdmin = new Proxy({}, {
  get(_, prop, receiver) { return Reflect.get(target(), prop, receiver); },
});
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === CLIENT_SPECIFIER) {
      return {
        url: `data:text/javascript,${encodeURIComponent(FAKE_CLIENT_MODULE)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const CATALOG: ServiceRow[] = [
  { id: "svc-teeth-cleaning", name: "Teeth Cleaning", duration_minutes: 30 },
  { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 90 },
];

/** Every table answers "nothing"; `services` answers from the queued results. */
type ServicesResult = {
  data: ServiceRow[] | null;
  error: { code: string; message: string } | null;
};
class FakeAdminClient {
  // Counted in a shared object, not on `this`: calls arrive through the
  // lazy Proxy, whose writes would land on the Proxy's own empty target.
  readonly reads = { services: 0 };
  readonly servicesResults: ServicesResult[];
  constructor(results: ServicesResult[]) {
    this.servicesResults = results;
  }
  get servicesReads() {
    return this.reads.services;
  }
  from(table: string) {
    const reads = this.reads;
    const results = this.servicesResults;
    const result = () => {
      if (table !== "services") return { data: null, error: null };
      const next = results[Math.min(reads.services, results.length - 1)]!;
      reads.services++;
      return next;
    };
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "gte", "lte"]) {
      chain[m] = () => chain;
    }
    for (const m of ["insert", "update", "upsert", "delete"]) chain[m] = () => chain;
    chain["maybeSingle"] = async () => ({ data: null, error: null });
    chain["single"] = async () => ({ data: null, error: null });
    chain["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(res, rej);
    return chain;
  }
  rpc() {
    return Promise.resolve({ data: null, error: null });
  }
}

const { startRuntimeSession, terminateRuntimeSession, CALLER_ID_QUESTION } =
  await import("./voice-runtime.server.ts");
const { createHarness } = await import("./telephony/voice-runtime-test-harness.ts");
type Harness = ReturnType<typeof createHarness>;

const CALLER_ID = "+919876543210";
const DATE = "2030-10-14";
const SLOT = { start: `${DATE}T16:00:00.000Z`, end: `${DATE}T16:30:00.000Z` };
const SERVICE_QUESTION = "Which service would you like to book?";

function marker(state: Record<string, unknown>): string {
  return `<<<APPT_STATE:${JSON.stringify({
    service: null,
    customer_name: null,
    phone: null,
    email: null,
    preferred_date: DATE,
    preferred_time: "16:00",
    preferred_period: null,
    wants_next_available: false,
    checking_availability: false,
    ready_to_book: false,
    ...state,
  })}>>>`;
}

async function drain(hops = 200) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

function setUp(client: FakeAdminClient) {
  (globalThis as { __fakeSupabaseAdmin?: unknown }).__fakeSupabaseAdmin = client;
  const h = createHarness();
  const original = h.deps.executeTool!;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    await original(name, toolInput, ctx);
    if (name === "check_calendar_availability") {
      return { content: JSON.stringify({ success: true, data: { slots: [SLOT] } }) };
    }
    if (name === "book_appointment") {
      return {
        content: JSON.stringify({
          success: true,
          data: { id: "booking-1", status: "CONFIRMED", startAt: SLOT.start, endAt: SLOT.end },
          bookingOutcome: "confirmed",
        }),
      };
    }
    return { content: JSON.stringify({ success: true, data: {} }) };
  };
  let emitted = 0;
  const catchUp = () => {
    while (emitted < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      emitted++;
    }
  };
  const turn = async (said: string, reply: string) => {
    catchUp();
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance(said);
    await drain();
    return h.tts.sentTexts.slice(before).join(" ");
  };
  return { h, turn };
}

async function start(h: Harness) {
  const callId = `catalog-${crypto.randomUUID()}`;
  await startRuntimeSession(
    {
      callId,
      organizationId: "00000000-0000-0000-0000-000000000000",
      businessId: "00000000-0000-0000-0000-000000000001",
      agentConfigId: "00000000-0000-0000-0000-000000000002",
      agentVersion: 3,
      instructions: "You are Aria, a helpful receptionist for Smile Dental.",
      snapshotAgent: {
        agent_name: "Aria",
        persona: "professional",
        custom_personality: null,
        objectives: ["answer_questions"],
        capabilities: {},
        primary_language: "en-IN",
        extra_languages: [],
        multilingual: false,
        voice_id: "ritu",
        speaking_pace: 1,
        greetings: { "en-IN": "Hello, thanks for calling Smile Dental." },
        transfer_number: null,
        after_hours_behavior: "take_message",
      },
      businessName: "Smile Dental",
      bridge: h.bridge,
      businessCountry: "IN",
      callerNumber: CALLER_ID,
      // No catalog passed in: the runtime reads it from the database.
    },
    h.deps,
  );
  return callId;
}

let logs: { event: string; payload: Record<string, unknown> }[] = [];
beforeEach(() => {
  logs = [];
});
async function capture<T>(run: () => Promise<T>): Promise<T> {
  const original = console.info;
  console.info = (event: unknown, payload?: unknown) => {
    if (typeof event === "string" && event.startsWith("voice_runtime:")) {
      logs.push({ event, payload: (payload ?? {}) as Record<string, unknown> });
    }
  };
  try {
    return await run();
  } finally {
    console.info = original;
  }
}

describe("a failed services read is retried, never treated as an empty catalog", () => {
  test('PGRST303 on the first read, then the catalog loads and "Root canal" books', async () => {
    const client = new FakeAdminClient([
      { data: null, error: { code: "PGRST303", message: "JWT issued at future" } },
      { data: CATALOG, error: null },
    ]);
    const { h, turn } = setUp(client);
    const callId = await start(h);
    await capture(async () => {
      const first = await turn(
        "I want to book an appointment at 4 PM today",
        `Sure, what's your phone number?\n${marker({})}`,
      );
      assert.match(first, new RegExp(CALLER_ID_QUESTION.replace(/[?]/g, "\\?")));
      await turn("Yes", `Great. What's the reason for your visit?\n${marker({})}`);
      await turn("Root canal", `Got it.\n${marker({ customer_name: "Dhanush" })}`);
      await turn(
        "Yes, please book it",
        `Booking now.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
      );
    });

    const unavailable = logs.filter(
      (l) => l.event === "voice_runtime:services_catalog_unavailable",
    );
    assert.equal(unavailable.length, 1, "the failed read is reported once");
    assert.equal(unavailable[0]!.payload["code"], "PGRST303");
    assert.ok(client.servicesReads >= 2, "the catalog was read again after the failure");

    const spoken = h.tts.sentTexts.join(" ");
    assert.equal(spoken.split(SERVICE_QUESTION).length - 1, 0, spoken);
    const bookCalls = h.tools.calls.filter((c) => c.name === "book_appointment");
    assert.equal(bookCalls.length, 1);
    assert.equal(bookCalls[0]!.input["serviceId"], "svc-root-canal");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a catalog that never loads still can't trap the caller: bounded asks, then a callback", async () => {
    const client = new FakeAdminClient([
      { data: null, error: { code: "PGRST303", message: "JWT issued at future" } },
    ]);
    const { h, turn } = setUp(client);
    const callId = await start(h);
    const replies: string[] = [];
    await capture(async () => {
      await turn(
        "I want to book an appointment at 4 PM today",
        `Sure, what's your phone number?\n${marker({})}`,
      );
      await turn("Yes", `Great.\n${marker({})}`);
      for (const said of ["Root canal", "Root canal please", "I said root canal", "root canal"]) {
        replies.push(
          await turn(
            said,
            `Booking.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
          ),
        );
      }
    });
    const all = replies.join(" | ");
    assert.ok(all.split(SERVICE_QUESTION).length - 1 <= 2, `bounded: ${all}`);
    assert.match(all, /call you back/i);
    assert.doesNotMatch(replies[3]!, /which service/i, "stops asking");
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);

    const unavailable = logs.filter(
      (l) => l.event === "voice_runtime:services_catalog_unavailable",
    );
    assert.ok(unavailable.length >= 2, "retried on later turns, not cached as empty");
    const logged = JSON.stringify(unavailable);
    for (const secret of ["root canal", "Root canal", "JWT issued", CALLER_ID, "Dhanush"]) {
      assert.ok(!logged.includes(secret), `logged ${secret}`);
    }
    await terminateRuntimeSession(callId, "test cleanup");
  });
});
