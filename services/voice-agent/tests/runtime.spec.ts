import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { attachCallGuards, decideCall } from "../src/agent/call.ts";
import { ReceptionistAgent } from "../src/agent/receptionist.ts";
import { InMemoryBookingBackend } from "../src/backend/in-memory.ts";
import { KlyroClient } from "../src/backend/klyro-client.ts";
import { newConversation, resolveDate } from "../src/conversation/state.ts";
import { readUtterance } from "../src/conversation/understanding.ts";
import { loadConfig } from "../src/runtime/config.ts";
import { CallTelemetry, maskPhone, redact } from "../src/runtime/telemetry.ts";

const BASE = {
  LIVEKIT_URL: "wss://example.livekit.cloud",
  LIVEKIT_API_KEY: "key",
  LIVEKIT_API_SECRET: "secret-secret-secret",
  SARVAM_API_KEY: "sk",
  KLYRO_BASE_URL: "https://klyro.example",
  VOICE_AGENT_HMAC_SECRET: "x".repeat(40),
  ANTHROPIC_API_KEY: "ak",
};

describe("configuration", () => {
  test("valid production config loads with safe defaults", () => {
    const c = loadConfig({ ...BASE, APP_ENV: "production" });
    assert.equal(c.MAX_CONCURRENT_SESSIONS, 8);
    assert.equal(c.CLAUDE_MODEL.length > 0, true);
  });
  test("refuses: no LLM, http klyro or ws LiveKit outside development; secret values never echoed", () => {
    const secret = "super-secret-value-123456789012345";
    assert.throws(
      () => loadConfig({ ...BASE, ANTHROPIC_API_KEY: undefined }),
      /an LLM is required/,
    );
    assert.throws(
      () => loadConfig({ ...BASE, APP_ENV: "staging", KLYRO_BASE_URL: "http://klyro.example" }),
      /https/,
    );
    assert.throws(
      () => loadConfig({ ...BASE, APP_ENV: "production", LIVEKIT_URL: "ws://x" }),
      /wss/,
    );
    try {
      loadConfig({
        ...BASE,
        VOICE_AGENT_HMAC_SECRET: "short",
        LIVEKIT_API_SECRET: secret.slice(0, 3),
      });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(!(e as Error).message.includes(secret.slice(0, 3) + "\n"));
      assert.ok(!(e as Error).message.includes("short"));
    }
  });
});

describe("telemetry never carries caller data", () => {
  test("phone numbers masked; transcripts, names and secrets redacted", () => {
    assert.equal(maskPhone("+919876543210"), "********3210");
    const r = redact({
      transcript: "मेरा नाम धनुष है",
      customer_name: "Ravi",
      caller: "+919876543210",
      ms: 120,
      tool: "book_appointment",
      api_key: "abc",
    });
    assert.deepEqual(r, {
      transcript: "[redacted:16]",
      customer_name: "[redacted:4]",
      caller: "[redacted:13]",
      ms: 120,
      tool: "book_appointment",
      api_key: "[redacted:3]",
    });
    const lines: string[] = [];
    new CallTelemetry({ callId: "c", sipCallId: "s", room: "r" }, (l) => lines.push(l)).emit(
      "turn.user_final",
      { transcript: "my number is 9876543210" },
    );
    assert.ok(!lines[0]!.includes("9876543210"));
  });
});

describe("call lifecycle", () => {
  const info = {
    roomName: "r",
    sipCallId: "SCL_1",
    calledNumber: "+918000000001",
    callerNumber: "+919876543210",
    direction: "inbound" as const,
  };
  const telemetry = () =>
    new CallTelemetry({ callId: null, sipCallId: "SCL_1", room: "r" }, () => undefined);
  const client = (body: unknown, status = 200) =>
    new KlyroClient({
      baseUrl: "https://k",
      secret: "s".repeat(32),
      retries: 0,
      fetchImpl: (async () =>
        new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
    });

  test("klyro denies (entitlement) -> reject, no agent", async () => {
    const d = await decideCall(
      client({ allowed: false, reason: "not_entitled", callId: "c1" }),
      info,
      telemetry(),
    );
    assert.equal(d.kind, "reject");
  });
  test("klyro unreachable -> reject: never take a call the backend has not authorised", async () => {
    const d = await decideCall(client({}, 503), info, telemetry());
    assert.deepEqual([d.kind, d.kind === "reject" && d.reason], ["reject", "backend_unreachable"]);
  });
  test("accepted -> business facts from klyro, caller ID inferred, prices only in INR from klyro", async () => {
    const d = await decideCall(
      client({
        allowed: true,
        callId: "c2",
        callerNumber: "+919876543210",
        tools: ["check_calendar_availability"],
        business: {
          name: "Smile Dental",
          timezone: "Asia/Kolkata",
          country: "IN",
          currency: "INR",
          services: [{ id: "s1", name: "Cleaning", price: 800, durationMinutes: 30 }],
          agentName: "Aria",
          primaryLanguage: "te-IN",
          extraLanguages: [],
          greetings: { "te-IN": "నమస్కారం" },
          voiceId: "priya",
          speakingPace: 1,
          instructions: "facts",
        },
      }),
      info,
      telemetry(),
    );
    assert.equal(d.kind, "accept");
    if (d.kind !== "accept") return;
    assert.equal(d.greeting, "నమస్కారం");
    assert.equal(d.state.language.current, "te-IN");
    assert.equal(d.state.phone?.provenance, "inferred");
    assert.equal(d.business.services[0]!.priceInr, 800);
  });

  function fakeSession() {
    const em = new EventEmitter();
    const said: string[] = [];
    return {
      em,
      said,
      session: Object.assign(em, {
        say: (t: string) => (said.push(t), { waitForPlayout: async () => undefined }),
      }),
    };
  }
  const EVENTS = {
    UserInputTranscribed: "uit",
    ConversationItemAdded: "cia",
    MetricsCollected: "mc",
    UserStateChanged: "usc",
    Error: "err",
    Close: "close",
  };
  const agent = () =>
    new ReceptionistAgent({
      business: {
        businessName: "x",
        timeZone: "Asia/Kolkata",
        services: [],
        now: () => new Date(),
      },
      backend: new InMemoryBookingBackend({ timeZoneOffset: "+05:30", openHours: [] }),
      state: newConversation({ callId: "c", callerId: null, primaryLanguage: "hi-IN" }),
    });

  test("long silence: one check-in in the caller's language, then goodbye and hang up", async () => {
    const f = fakeSession();
    const hung: string[] = [];
    const g = attachCallGuards({
      session: f.session as never,
      agent: agent(),
      telemetry: telemetry(),
      events: EVENTS as never,
      maxCallSeconds: 600,
      io: { say: async () => undefined, hangup: async (r) => void hung.push(r) },
    });
    f.em.emit("usc", { newState: "away" });
    assert.equal(hung.length, 0);
    assert.equal(f.said[0], "क्या आप लाइन पर हैं?");
    f.em.emit("usc", { newState: "away" });
    assert.deepEqual(await g.finished, { reason: "silence" });
    assert.deepEqual(hung, ["silence"]);
  });
  test("maximum call length ends the call", async () => {
    const f = fakeSession();
    const hung: string[] = [];
    const g = attachCallGuards({
      session: f.session as never,
      agent: agent(),
      telemetry: telemetry(),
      events: EVENTS as never,
      maxCallSeconds: 0.05,
      io: { say: async () => undefined, hangup: async (r) => void hung.push(r) },
    });
    assert.deepEqual(await g.finished, { reason: "max_duration" });
  });
  test("SIP disconnect (session closed by LiveKit) finishes the call; interruptions counted", async () => {
    const f = fakeSession();
    const t = telemetry();
    const g = attachCallGuards({
      session: f.session as never,
      agent: agent(),
      telemetry: t,
      events: EVENTS as never,
      maxCallSeconds: 600,
      io: { say: async () => undefined, hangup: async () => undefined },
    });
    f.em.emit("cia", { item: { type: "message", role: "assistant", interrupted: true } });
    f.em.emit("err", {
      error: { type: "stt_error", recoverable: true, error: new Error("sarvam ws closed") },
    });
    f.em.emit("close", { reason: "participant_disconnected" });
    assert.deepEqual(await g.finished, { reason: "participant_disconnected" });
    assert.equal(t.counters.interruptions, 1);
    assert.equal(t.counters.providerErrors, 1);
  });
});

describe("dates and intents (timezone-aware)", () => {
  const ctx = (iso: string) => ({
    businessName: "x",
    timeZone: "Asia/Kolkata",
    services: [],
    now: () => new Date(iso),
  });
  test("'today' near midnight UTC is the business's date, not the server's", () => {
    // 2026-11-02 20:00 UTC = 2026-11-03 01:30 IST
    assert.equal(
      resolveDate({ kind: "relative", days: 0 }, ctx("2026-11-02T20:00:00Z")),
      "2026-11-03",
    );
    assert.equal(
      resolveDate({ kind: "relative", days: 1 }, ctx("2026-11-02T20:00:00Z")),
      "2026-11-04",
    );
  });
  test("weekdays in three languages resolve forward from the business's today", () => {
    const monday = ctx("2026-11-02T04:30:00Z"); // Monday in IST
    assert.equal(
      resolveDate(readUtterance("on Friday", { catalog: [] }).date!.value, monday),
      "2026-11-06",
    );
    assert.equal(
      resolveDate(readUtterance("शुक्रवार को", { catalog: [] }).date!.value, monday),
      "2026-11-06",
    );
    assert.equal(
      resolveDate(readUtterance("శుక్రవారం", { catalog: [] }).date!.value, monday),
      "2026-11-06",
    );
    assert.equal(
      resolveDate(readUtterance("Monday", { catalog: [] }).date!.value, monday),
      "2026-11-02",
    );
  });
  test("'परसों' is inferred (it also means the day before yesterday); 'day after tomorrow' is explicit", () => {
    assert.equal(readUtterance("परसों आ सकता हूँ", { catalog: [] }).date?.certainty, "inferred");
    assert.equal(readUtterance("day after tomorrow", { catalog: [] }).date?.certainty, "explicit");
  });
  test("intents: price, services, cancel, reschedule, availability, book (en/hi/te/romanized)", () => {
    const i = (t: string) => readUtterance(t, { catalog: [] }).intent;
    assert.equal(i("how much does cleaning cost"), "price");
    assert.equal(i("cleaning kitna hai"), "price");
    assert.equal(i("క్లీనింగ్ ధర ఎంత"), "price");
    assert.equal(i("what services do you offer"), "services");
    assert.equal(i("I want to cancel my appointment"), "cancel");
    assert.equal(i("अपॉइंटमेंट रद्द करना है"), "cancel");
    assert.equal(i("can I reschedule my appointment"), "reschedule");
    assert.equal(i("कल कोई स्लॉट खाली है?"), "availability");
    assert.equal(i("mujhe appointment book karna hai"), "book");
  });
});
