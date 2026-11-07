import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { attachCallGuards, decideCall, reportEnd } from "../src/agent/call.ts";
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
  // Explicit: outside development the provider is never defaulted.
  LLM_PROVIDER: "anthropic",
};

describe("configuration: the LLM provider is explicit and Sarvam is used when chosen", () => {
  const { LLM_PROVIDER: _omit, ...noProvider } = BASE;
  test("staging/production refuse to start without LLM_PROVIDER (never defaulted to Anthropic)", () => {
    for (const APP_ENV of ["staging", "production"])
      assert.throws(
        () => loadConfig({ ...noProvider, APP_ENV }),
        /LLM_PROVIDER: must be set explicitly/,
      );
  });
  test("the missing provider is named even when other settings are also wrong", () => {
    const { ANTHROPIC_API_KEY: _k, ...bare } = noProvider;
    assert.throws(
      () => loadConfig({ ...bare, APP_ENV: "production" }),
      /LLM_PROVIDER: must be set explicitly/,
    );
  });
  test("development still defaults (local runs)", () => {
    assert.equal(loadConfig({ ...noProvider, APP_ENV: "development" }).LLM_PROVIDER, "anthropic");
  });
  test("the intended production configuration: Sarvam sarvam-105b-conversations, no Anthropic key needed", () => {
    const c = loadConfig({
      ...noProvider,
      ANTHROPIC_API_KEY: undefined,
      APP_ENV: "production",
      LLM_PROVIDER: "sarvam",
      SARVAM_LLM_MODEL: "sarvam-105b-conversations",
    });
    assert.equal(c.LLM_PROVIDER, "sarvam");
    assert.equal(c.SARVAM_LLM_MODEL, "sarvam-105b-conversations");
    assert.equal(c.ANTHROPIC_API_KEY, undefined);
  });
  test("Sarvam with a fallback LLM configured is refused (no silent fallback)", () => {
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          APP_ENV: "production",
          LLM_PROVIDER: "sarvam",
          FALLBACK_LLM_BASE_URL: "https://x.example/v1",
        }),
      /no LLM fallback/,
    );
  });
});

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
    assert.equal(d.maxCallSeconds, null, "older klyro: no limit sent");
  });
  test("klyro's maximum call duration is passed through to the call guards' limit", async () => {
    const d = await decideCall(
      client({
        allowed: true,
        callId: "c3",
        callerNumber: null,
        tools: [],
        maxCallSeconds: 900,
        business: {
          name: "B",
          timezone: "Asia/Kolkata",
          country: "IN",
          currency: "INR",
          services: [],
          agentName: "A",
          primaryLanguage: "en-IN",
          extraLanguages: [],
          greetings: {},
          voiceId: "priya",
          speakingPace: 1,
          instructions: "",
        },
      }),
      info,
      telemetry(),
    );
    assert.equal(d.kind === "accept" && d.maxCallSeconds, 900);
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
      io: {
        say: async () => undefined,
        hangup: async (r) => void hung.push(r),
        apologize: async () => undefined,
        disconnect: async () => undefined,
      },
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
      io: {
        say: async () => undefined,
        hangup: async (r) => void hung.push(r),
        apologize: async () => undefined,
        disconnect: async () => undefined,
      },
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
      io: {
        say: async () => undefined,
        hangup: async () => undefined,
        apologize: async () => undefined,
        disconnect: async () => undefined,
      },
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

describe("F5: drain timeout covers the longest call", () => {
  test("defaults are consistent; a drain shorter than a call (+60 s) is refused at start-up", () => {
    const c = loadConfig(BASE);
    assert.ok(c.DRAIN_TIMEOUT_MS >= c.MAX_CALL_SECONDS * 1000 + 60_000);
    assert.throws(
      () => loadConfig({ ...BASE, DRAIN_TIMEOUT_MS: "900000", MAX_CALL_SECONDS: "1800" }),
      /DRAIN_TIMEOUT_MS must be at least MAX_CALL_SECONDS \+ 60 s/,
    );
    assert.doesNotThrow(() =>
      loadConfig({ ...BASE, DRAIN_TIMEOUT_MS: "900000", MAX_CALL_SECONDS: "780" }),
    );
  });
  test("the k8s grace period exceeds the default drain + the watchdog's 30 s margin", async () => {
    const { readFileSync } = await import("node:fs");
    const yaml = readFileSync(new URL("../deploy/k8s/voice-agent.yaml", import.meta.url), "utf8");
    const grace = Number(yaml.match(/terminationGracePeriodSeconds:\s*(\d+)/)?.[1]);
    const drain = loadConfig(BASE).DRAIN_TIMEOUT_MS / 1000;
    assert.ok(grace > drain + 30, `grace ${grace}s must exceed drain ${drain}s + 30s`);
    assert.doesNotMatch(
      yaml,
      /DRAIN_TIMEOUT_MS[^\n]*value/,
      "no manifest override that could break the check",
    );
  });
});

describe("H-B: provider failure ends the call cleanly (apology, disconnect, no silent line)", () => {
  const EV = {
    UserInputTranscribed: "uit",
    ConversationItemAdded: "cia",
    MetricsCollected: "mc",
    UserStateChanged: "usc",
    Error: "err",
    Close: "close",
  };
  function harness(
    o: {
      apologize?: () => Promise<void>;
      disconnect?: () => Promise<void>;
      language?: "en-IN" | "hi-IN" | "te-IN";
      apologyTimeoutMs?: number;
      backoff?: number[];
    } = {},
  ) {
    const em = new EventEmitter();
    const calls: string[] = [];
    const lines: string[] = [];
    const telemetry = new CallTelemetry({ callId: "c1", sipCallId: "SCL_1", room: "r" }, (l) =>
      lines.push(l),
    );
    const ag = new ReceptionistAgent({
      business: {
        businessName: "x",
        timeZone: "Asia/Kolkata",
        services: [],
        now: () => new Date(),
      },
      backend: new InMemoryBookingBackend({ timeZoneOffset: "+05:30", openHours: [] }),
      state: newConversation({
        callId: "c1",
        callerId: null,
        primaryLanguage: o.language ?? "hi-IN",
      }),
    });
    const g = attachCallGuards({
      session: Object.assign(em, {
        say: () => ({ waitForPlayout: async () => undefined }),
      }) as never,
      agent: ag,
      telemetry,
      events: EV as never,
      maxCallSeconds: 600,
      io: {
        say: async () => undefined,
        hangup: async (r) => void calls.push(`hangup:${r}`),
        apologize: async (lang) => {
          calls.push(`apologize:${lang}`);
          await (o.apologize ?? (async () => undefined))();
        },
        disconnect: async () => {
          calls.push("disconnect");
          await (o.disconnect ?? (async () => undefined))();
        },
      },
      cleanup: {
        apologyTimeoutMs: o.apologyTimeoutMs ?? 50,
        disconnectBackoffMs: o.backoff ?? [0, 0, 0],
        sleep: async () => undefined,
      },
    });
    const events = () => lines.map((l) => JSON.parse(l).event as string);
    return { em, calls, events, g };
  }

  test("CloseReason.ERROR: apology in the caller's language, then disconnect; finished = error", async () => {
    const h = harness({ language: "te-IN" });
    h.em.emit("close", { reason: "error", error: { type: "stt_error" } });
    assert.deepEqual(await h.g.finished, { reason: "error" });
    assert.deepEqual(h.calls, ["apologize:te-IN", "disconnect"]);
    assert.ok(h.events().includes("call.aborted"));
  });
  test("repeated STT failures (recoverable errors, then the framework closes): one apology, one disconnect", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++)
      h.em.emit("err", {
        error: { type: "stt_error", recoverable: false, error: new Error("sarvam ws closed") },
      });
    assert.deepEqual(h.calls, [], "errors alone do not end the call; the framework decides");
    h.em.emit("close", { reason: "error", error: { type: "stt_error" } });
    await h.g.finished;
    assert.deepEqual(h.calls, ["apologize:hi-IN", "disconnect"]);
    assert.equal(h.events().filter((e) => e === "provider.error").length, 3);
  });
  test("LLM failure: apology (TTS still works), then disconnect", async () => {
    const h = harness();
    h.em.emit("close", { reason: "error", error: { type: "llm_error" } });
    await h.g.finished;
    assert.deepEqual(h.calls, ["apologize:hi-IN", "disconnect"]);
  });
  test("TTS failure: no apology attempt (TTS is what failed), straight to disconnect", async () => {
    const h = harness();
    h.em.emit("close", { reason: "error", error: { type: "tts_error" } });
    await h.g.finished;
    assert.deepEqual(h.calls, ["disconnect"]);
  });
  test("the apology never blocks cleanup: a hanging apology times out, the caller is still disconnected", async () => {
    const h = harness({
      apologize: () => new Promise<void>(() => undefined),
      apologyTimeoutMs: 20,
    });
    const t0 = Date.now();
    h.em.emit("close", { reason: "error", error: { type: "llm_error" } });
    await h.g.finished;
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(h.calls, ["apologize:hi-IN", "disconnect"]);
    assert.ok(h.events().includes("call.apology_failed"));
  });
  test("caller hangs up during cleanup: apology fails, disconnect still runs (idempotent), no duplicate cleanup", async () => {
    const h = harness({
      apologize: async () => {
        throw new Error("participant disconnected");
      },
    });
    h.em.emit("close", { reason: "error", error: { type: "stt_error" } });
    h.em.emit("close", { reason: "participant_disconnected" }); // the caller left meanwhile
    await h.g.finished;
    assert.deepEqual(h.calls, ["apologize:hi-IN", "disconnect"]);
  });
  test("room deletion failure: retried; succeeds on a later attempt", async () => {
    let n = 0;
    const h = harness({
      disconnect: async () => {
        if (++n < 3) throw new Error("twirp unavailable");
      },
    });
    h.em.emit("close", { reason: "error", error: { type: "llm_error" } });
    await h.g.finished;
    assert.equal(h.calls.filter((c) => c === "disconnect").length, 3);
    assert.equal(h.events().filter((e) => e === "room.disconnect_failed").length, 2);
    assert.ok(!h.events().includes("call.cleanup_failed"));
  });
  test("room deletion keeps failing: bounded attempts, cleanup_failed alert, and the call still finishes", async () => {
    const h = harness({
      disconnect: async () => {
        throw new Error("livekit down");
      },
      backoff: [0, 0, 0, 0],
    });
    h.em.emit("close", { reason: "job_shutdown" });
    assert.deepEqual(await h.g.finished, { reason: "job_shutdown" });
    assert.equal(h.calls.filter((c) => c === "disconnect").length, 4);
    assert.ok(h.events().includes("call.cleanup_failed"));
  });
  test("duplicate close events: cleanup runs once", async () => {
    const h = harness();
    h.em.emit("close", { reason: "error", error: { type: "stt_error" } });
    h.em.emit("close", { reason: "error", error: { type: "stt_error" } });
    h.em.emit("close", { reason: "job_shutdown" });
    await h.g.finished;
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(h.calls, ["apologize:hi-IN", "disconnect"]);
  });
  test("normal caller hang-up is not an error: no apology, no cleanup", async () => {
    const h = harness();
    h.em.emit("close", { reason: "participant_disconnected" });
    assert.deepEqual(await h.g.finished, { reason: "participant_disconnected" });
    assert.deepEqual(h.calls, []);
    assert.ok(!h.events().includes("call.aborted"));
  });
  test("our own hang-up (silence) closes with user_initiated: not treated as an error; the room is still removed", async () => {
    const h = harness();
    h.em.emit("usc", { newState: "away" });
    h.em.emit("usc", { newState: "away" });
    await new Promise((r) => setImmediate(r)); // goodbye played; end("silence") running
    h.em.emit("close", { reason: "user_initiated" }); // emitted by session.close() inside end()
    assert.deepEqual(await h.g.finished, { reason: "silence" });
    assert.deepEqual(h.calls, ["hangup:silence", "disconnect"]);
    assert.ok(!h.events().includes("call.aborted"));
  });
  test("a user_initiated close from any other path: no apology, but the caller is disconnected", async () => {
    const h = harness();
    h.em.emit("close", { reason: "user_initiated" });
    assert.deepEqual(await h.g.finished, { reason: "user_initiated" });
    assert.deepEqual(h.calls, ["disconnect"]);
    assert.ok(!h.events().includes("call.aborted"));
  });
});

describe("Phase 2.11: the agent binds its reports and states its own limit", () => {
  const capture = () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new KlyroClient({
      baseUrl: "https://k",
      secret: "s".repeat(32),
      retries: 0,
      fetchImpl: (async (url: string, init: RequestInit) => {
        posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response(
          JSON.stringify({ allowed: false, reason: "x", callId: null, ok: true }),
          {
            status: 200,
          },
        );
      }) as unknown as typeof fetch,
    });
    return { posts, client };
  };
  const tel = () =>
    new CallTelemetry({ callId: "c", sipCallId: "SCL_1", room: "call-_r" }, () => undefined);

  test("session start sends the agent's MAX_CALL_SECONDS (klyro records min(klyro, agent) per call)", async () => {
    const { posts, client } = capture();
    await decideCall(
      client,
      {
        roomName: "call-_r",
        sipCallId: "SCL_1",
        calledNumber: "+918000000001",
        callerNumber: null,
        direction: "inbound",
      },
      tel(),
      undefined,
      2400,
    );
    assert.equal(posts[0]!.body["maxCallSeconds"], 2400);
  });
  test("the end report carries the call's room and sip.callID (klyro refuses a mismatch)", async () => {
    const { posts, client } = capture();
    await reportEnd(
      client,
      "11111111-1111-4111-8111-111111111111",
      "goodbye",
      newConversation({ callId: "c", callerId: null, primaryLanguage: "en-IN" }),
      tel(),
      { roomName: "call-_r", sipCallId: "SCL_1" },
    );
    assert.equal(posts[0]!.url, "https://k/api/internal/voice-agent/session-end");
    assert.equal(posts[0]!.body["roomName"], "call-_r");
    assert.equal(posts[0]!.body["sipCallId"], "SCL_1");
  });
});

describe("F13: the agent refuses unexpected LiveKit hosts outside development", () => {
  const prod = { ...BASE, APP_ENV: "production" };
  test("foreign, look-alike, credential-carrying and path URLs are refused; *.livekit.cloud and allow-listed hosts pass", () => {
    for (const url of [
      "wss://evil.example",
      "wss://proj.livekit.cloud.evil.example",
      "wss://livekit.cloud",
      "wss://user:pw@proj.livekit.cloud",
      "wss://proj.livekit.cloud/x",
    ])
      assert.throws(() => loadConfig({ ...prod, LIVEKIT_URL: url }), /LIVEKIT_URL/, url);
    assert.equal(
      loadConfig({ ...prod, LIVEKIT_URL: "wss://proj.livekit.cloud" }).LIVEKIT_URL,
      "wss://proj.livekit.cloud",
    );
    assert.equal(
      loadConfig({
        ...prod,
        LIVEKIT_URL: "wss://lk.internal.example",
        LIVEKIT_ALLOWED_HOSTS: "lk.internal.example",
      }).LIVEKIT_URL,
      "wss://lk.internal.example",
    );
    // development keeps the local server usable
    assert.equal(
      loadConfig({ ...BASE, APP_ENV: "development", LIVEKIT_URL: "ws://localhost:7880" }).APP_ENV,
      "development",
    );
  });
});
