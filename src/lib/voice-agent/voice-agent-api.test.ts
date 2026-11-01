import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { signRequest, verifySignedRequest, MAX_SKEW_SECONDS } from "./internal-auth.ts";
import { participantSeconds, verifyLiveKitWebhook } from "./livekit-webhook.ts";
import {
  handleLiveKitWebhook,
  handleOutboundPrepare,
  handleSessionStart,
  handleTool,
  type HttpDeps,
} from "./http.server.ts";
import {
  endSipSession,
  pruneVoiceAgentNonces,
  prepareOutboundSipCall,
  reconcileStaleSipCalls,
  runSessionTool,
  startSipSession,
  type SessionDeps,
} from "./sessions.server.ts";

/* ------------------------------------------------------------------ */
/* A tiny in-memory stand-in for the Supabase client (only what the    */
/* voice-agent code uses), with call_logs' unique (provider,           */
/* provider_call_id) index and webhook_events' unique (provider,       */
/* event_id) index.                                                    */
/* ------------------------------------------------------------------ */
type Row = Record<string, unknown>;
function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    call_logs: [],
    webhook_events: [],
    phone_numbers: [],
    ...seed,
  };
  const unique: Record<string, string[]> = {
    call_logs: ["provider", "provider_call_id"],
    webhook_events: ["provider", "event_id"],
  };
  function q(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row = {};
    let inserted: Row | null = null;
    let error: { code: string } | null = null;
    const api = {
      select: () => api,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), api),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), api),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), api),
      lt: (k: string, v: string) => (filters.push((r) => String(r[k]) < v), api),
      limit: () => api,
      insert: (row: Row) => {
        op = "insert";
        const u = unique[table];
        const rows = tables[table]!;
        if (
          u &&
          u.every((k) => row[k] !== null && row[k] !== undefined) &&
          rows.some((r) => u.every((k) => r[k] === row[k]))
        ) {
          error = { code: "23505" };
        } else {
          inserted = { id: crypto.randomUUID(), ...row };
          rows.push(inserted);
        }
        return api;
      },
      update: (p: Row) => ((op = "update"), (payload = p), api),
      delete: () => ((op = "delete"), api),
      maybeSingle: async () => ({
        data: tables[table]!.filter((r) => filters.every((f) => f(r)))[0] ?? null,
        error: null,
      }),
      single: async () =>
        op === "insert" ? { data: error ? null : inserted, error } : api.maybeSingle(),
      then: (res: (v: unknown) => void) => {
        if (op === "delete")
          tables[table] = tables[table]!.filter((r) => !filters.every((f) => f(r)));
        if (op === "update")
          for (const r of tables[table]!.filter((r) => filters.every((f) => f(r))))
            Object.assign(r, payload);
        res({
          data: op === "select" ? tables[table]!.filter((r) => filters.every((f) => f(r))) : null,
          error: op === "insert" ? error : null,
        });
      },
    };
    return api;
  }
  return { tables, client: { from: q } };
}

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const BIZ_A = "00000000-0000-4000-8000-0000000000ba";
const PN_A = {
  id: "00000000-0000-4000-8000-0000000000a1",
  organization_id: ORG_A,
  business_id: BIZ_A,
  agent_config_id: "agent-a",
  e164: "+918000000001",
  status: "active",
};

function sessionDeps(over: Partial<SessionDeps> = {}) {
  const db = fakeDb({ phone_numbers: [PN_A] });
  const executed: Array<{ ctx: unknown; name: string; input: unknown }> = [];
  const billed: Array<{ id: unknown; seconds: number }> = [];
  const deps: SessionDeps = {
    db: db.client as never,
    resolveNumber: async (_p, e164) => (e164 === PN_A.e164 ? PN_A : null),
    checkAccess: async () => ({ allowed: true, reason: null }),
    loadBusiness: async () => ({
      name: "Smile Dental",
      timezone: "Asia/Kolkata",
      country: "IN",
      currency: "INR",
      services: [],
      agentName: "Aria",
      primaryLanguage: "en-IN",
      extraLanguages: ["hi-IN", "te-IN"],
      greetings: {},
      voiceId: "priya",
      speakingPace: 1,
      instructions: "x",
    }),
    availableTools: async () => ["check_calendar_availability", "book_appointment"],
    executeTool: async (ctx, name, input) => (
      executed.push({ ctx, name, input }),
      { content: '{"success":true}' }
    ),
    finalizeBilling: async (call, seconds) => billed.push({ id: call.id, seconds }),
    now: () => new Date("2026-11-02T04:30:00Z"),
    ...over,
  };
  return { deps, db, executed, billed };
}

const SECRET = "test-secret-0123456789abcdef";
function httpDeps(
  session: SessionDeps,
  db: ReturnType<typeof fakeDb>,
  now = 1_793_600_000,
): HttpDeps {
  const env: Record<string, string> = {
    VOICE_AGENT_HMAC_SECRET: SECRET,
    LIVEKIT_API_KEY: "lk-key",
    LIVEKIT_API_SECRET: "lk-secret",
  };
  return {
    session,
    env: (n) => env[n],
    nowSeconds: () => now,
    claimOnce: async (provider, eventId) => {
      const r = await (
        db.client.from("webhook_events") as unknown as {
          insert: (r: Row) => { single: () => Promise<{ error: unknown }> };
        }
      )
        .insert({ provider, event_id: eventId })
        .single();
      return !r.error;
    },
    releaseClaim: async (provider, eventId) => {
      db.tables["webhook_events"] = db.tables["webhook_events"]!.filter(
        (r) => !(r["provider"] === provider && r["event_id"] === eventId),
      );
    },
  };
}
async function signed(
  path: string,
  body: unknown,
  opts: { secret?: string; now?: number; nonce?: string } = {},
) {
  const text = JSON.stringify(body);
  const h = await signRequest({
    secret: opts.secret ?? SECRET,
    keyId: "current",
    method: "POST",
    path,
    body: text,
    nowSeconds: opts.now ?? 1_793_600_000,
    ...(opts.nonce ? { nonce: opts.nonce } : {}),
  });
  return new Request(`https://klyro.example${path}`, {
    method: "POST",
    body: text,
    headers: { ...h, "content-type": "application/json" },
  });
}

describe("internal request signing", () => {
  const verify = (
    req: { body: string; headers: Record<string, string> },
    now: number,
    claim = async () => true,
  ) =>
    verifySignedRequest({
      secrets: { current: SECRET },
      method: "POST",
      path: "/p",
      body: req.body,
      header: (n) => req.headers[n] ?? null,
      nowSeconds: now,
      claimNonce: claim,
    });
  test("valid signature accepted; tampered body, wrong key, stale and replayed rejected", async () => {
    const body = '{"a":1}';
    const h = {
      ...(await signRequest({
        secret: SECRET,
        keyId: "current",
        method: "POST",
        path: "/p",
        body,
        nowSeconds: 1000000000,
      })),
    } as Record<string, string>;
    assert.deepEqual((await verify({ body, headers: h }, 1000000000)).ok, true);
    assert.deepEqual(await verify({ body: '{"a":2}', headers: h }, 1000000000), {
      ok: false,
      reason: "bad_signature",
    });
    const wrong = {
      ...(await signRequest({
        secret: "other",
        keyId: "current",
        method: "POST",
        path: "/p",
        body,
        nowSeconds: 1000000000,
      })),
    } as Record<string, string>;
    assert.deepEqual(await verify({ body, headers: wrong }, 1000000000), {
      ok: false,
      reason: "bad_signature",
    });
    assert.deepEqual(await verify({ body, headers: h }, 1000000000 + MAX_SKEW_SECONDS + 1), {
      ok: false,
      reason: "stale",
    });
    assert.deepEqual(await verify({ body, headers: h }, 1000000000, async () => false), {
      ok: false,
      reason: "replayed",
    });
    assert.deepEqual(
      await verify({ body, headers: { ...h, "x-clickai-key-id": "previous" } }, 1000000000),
      { ok: false, reason: "unknown_key" },
    );
  });
  test("no secret configured fails closed", async () => {
    const r = await verifySignedRequest({
      secrets: { current: undefined },
      method: "POST",
      path: "/p",
      body: "",
      header: () => null,
      claimNonce: async () => true,
    });
    assert.deepEqual(r, { ok: false, reason: "not_configured" });
  });
});

/** Mints a LiveKit webhook token the way livekit-server-sdk does (HS256, iss=api key, sha256 claim). */
async function liveKitAuth(
  body: string,
  opts: { key?: string; secret?: string; exp?: number } = {},
) {
  const enc = new TextEncoder();
  const b64u = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const sha = btoa(
    String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(body)))),
  );
  const h = b64u(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const c = b64u(
    enc.encode(
      JSON.stringify({ iss: opts.key ?? "lk-key", exp: opts.exp ?? 1_793_600_600, sha256: sha }),
    ),
  );
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(opts.secret ?? "lk-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const s = b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`${h}.${c}`))));
  return `${h}.${c}.${s}`;
}

describe("LiveKit webhook verification", () => {
  const body = JSON.stringify({
    event: "participant_left",
    id: "EV_1",
    createdAt: "1793600100",
    participant: { joinedAt: "1793600000", attributes: { "sip.callID": "SCL_1" } },
  });
  test("valid accepted; wrong secret, wrong issuer, expired, body swapped rejected", async () => {
    const ok = await verifyLiveKitWebhook({
      apiKey: "lk-key",
      apiSecret: "lk-secret",
      authorization: await liveKitAuth(body),
      body,
      nowSeconds: 1_793_600_000,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && participantSeconds(ok.event), 100);
    const bad = async (auth: string, b = body, now = 1_793_600_000) =>
      (await verifyLiveKitWebhook({
        apiKey: "lk-key",
        apiSecret: "lk-secret",
        authorization: auth,
        body: b,
        nowSeconds: now,
      })) as { ok: false; reason: string };
    assert.equal((await bad(await liveKitAuth(body, { secret: "nope" }))).reason, "bad_signature");
    assert.equal((await bad(await liveKitAuth(body, { key: "other" }))).reason, "bad_issuer");
    assert.equal((await bad(await liveKitAuth(body, { exp: 1_793_599_000 }))).reason, "expired");
    assert.equal(
      (await bad(await liveKitAuth(body), body.replace("SCL_1", "SCL_2"))).reason,
      "body_mismatch",
    );
  });
});

describe("SIP session start keeps the entitlement gate", () => {
  test("entitled call: one call_logs row, business config returned", async () => {
    const { deps, db } = sessionDeps();
    const r = await startSipSession(deps, {
      sipCallId: "SCL_1",
      roomName: "call-1",
      calledNumber: PN_A.e164,
      callerNumber: "+919876543210",
      direction: "inbound",
    });
    assert.equal(r.allowed, true);
    assert.equal(db.tables["call_logs"]!.length, 1);
    assert.equal(db.tables["call_logs"]![0]!["provider"], "livekit_sip");
    assert.equal(db.tables["call_logs"]![0]!["organization_id"], ORG_A);
  });
  test("a retried start for the same SIP call reuses the row", async () => {
    const { deps, db } = sessionDeps();
    const a = await startSipSession(deps, {
      sipCallId: "SCL_1",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    const b = await startSipSession(deps, {
      sipCallId: "SCL_1",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    assert.equal(db.tables["call_logs"]!.length, 1);
    assert.equal(a.callId, b.callId);
  });
  test("gate denied: no agent session, call recorded as failed", async () => {
    const { deps, db } = sessionDeps({
      checkAccess: async () => ({ allowed: false, reason: "wallet empty" }),
    });
    const r = await startSipSession(deps, {
      sipCallId: "SCL_2",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    assert.deepEqual(
      { allowed: r.allowed, reason: !r.allowed && r.reason },
      { allowed: false, reason: "not_entitled" },
    );
    assert.equal(db.tables["call_logs"]![0]!["status"], "failed");
  });
  test("unknown number: denied, nothing written", async () => {
    const { deps, db } = sessionDeps();
    const r = await startSipSession(deps, {
      sipCallId: "SCL_3",
      roomName: "r",
      calledNumber: "+918000000099",
      callerNumber: null,
      direction: "inbound",
    });
    assert.equal(r.allowed, false);
    assert.equal(db.tables["call_logs"]!.length, 0);
  });
  test("outbound without a klyro-authorised call row is refused", async () => {
    const { deps } = sessionDeps();
    const r = await startSipSession(deps, {
      sipCallId: "SCL_4",
      roomName: "r",
      calledNumber: "+919999999999",
      callerNumber: null,
      direction: "outbound",
    });
    assert.deepEqual(
      { allowed: r.allowed, reason: !r.allowed && r.reason },
      { allowed: false, reason: "invalid_outbound" },
    );
  });
});

describe("tools: tenant isolation and authorization", () => {
  async function call() {
    const s = sessionDeps();
    const r = await startSipSession(s.deps, {
      sipCallId: "SCL_T",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    return { ...s, callId: r.callId! };
  }
  test("tenant ids come from the call row; model-supplied ids are stripped", async () => {
    const { deps, executed, callId } = await call();
    const r = await runSessionTool(deps, callId, "check_calendar_availability", {
      dateIso: "2026-11-03",
      durationMinutes: 30,
      organizationId: ORG_B,
      business_id: "evil",
    });
    assert.equal(r.ok, true);
    const ctx = executed[0]!.ctx as { organizationId: string; businessId: string; callId: string };
    assert.equal(ctx.organizationId, ORG_A);
    assert.equal(ctx.businessId, BIZ_A);
    assert.equal(ctx.callId, callId);
    assert.deepEqual(executed[0]!.input, { dateIso: "2026-11-03", durationMinutes: 30 });
  });
  test("tools outside the voice set or the agent's capabilities are refused", async () => {
    const { deps, callId } = await call();
    assert.deepEqual(await runSessionTool(deps, callId, "request_payment", {}), {
      ok: false,
      reason: "tool_not_allowed",
    });
    assert.deepEqual(await runSessionTool(deps, callId, "reschedule_appointment", {}), {
      ok: false,
      reason: "tool_not_allowed",
    });
  });
  test("an unknown or ended call cannot run tools", async () => {
    const { deps, db, callId } = await call();
    assert.deepEqual(await runSessionTool(deps, crypto.randomUUID(), "book_appointment", {}), {
      ok: false,
      reason: "unknown_call",
    });
    db.tables["call_logs"]![0]!["status"] = "completed";
    assert.deepEqual(await runSessionTool(deps, callId, "book_appointment", {}), {
      ok: false,
      reason: "call_ended",
    });
  });
});

describe("HTTP: signed requests, replay, billing from signed webhooks only", () => {
  test("unsigned and replayed requests are rejected; signed start works", async () => {
    const { deps, db } = sessionDeps();
    const h = httpDeps(deps, db);
    const body = {
      sipCallId: "SCL_H",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    };
    const unsigned = new Request("https://klyro.example/api/internal/voice-agent/session", {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal((await handleSessionStart(unsigned, h)).status, 401);
    const req = await signed("/api/internal/voice-agent/session", body, {
      nonce: "nonce-aaaaaaaaaaaaaaaa",
    });
    assert.equal((await handleSessionStart(req, h)).status, 200);
    const replay = await signed("/api/internal/voice-agent/session", body, {
      nonce: "nonce-aaaaaaaaaaaaaaaa",
    });
    assert.equal((await handleSessionStart(replay, h)).status, 401, "same nonce twice");
    const wrongSecret = await signed("/api/internal/voice-agent/session", body, {
      secret: "attacker",
    });
    assert.equal((await handleSessionStart(wrongSecret, h)).status, 401);
  });
  test("a cross-tenant call id in a tool request cannot reach another org", async () => {
    const { deps, db } = sessionDeps();
    const h = httpDeps(deps, db);
    const r = await handleTool(
      await signed("/api/internal/voice-agent/tool", {
        callId: crypto.randomUUID(),
        tool: "book_appointment",
        input: {},
      }),
      h,
    );
    assert.equal(r.status, 404);
  });
  test("LiveKit participant_left bills once; duplicate delivery and forged events do nothing", async () => {
    const { deps, db, billed } = sessionDeps();
    const h = httpDeps(deps, db);
    await startSipSession(deps, {
      sipCallId: "SCL_B",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    const body = JSON.stringify({
      event: "participant_left",
      id: "EV_9",
      createdAt: "1793600130",
      participant: { joinedAt: "1793600000", attributes: { "sip.callID": "SCL_B" } },
    });
    const post = async (auth: string) =>
      handleLiveKitWebhook(
        new Request("https://klyro.example/api/public/webhooks/livekit", {
          method: "POST",
          body,
          headers: { authorization: auth },
        }),
        h,
      );
    assert.equal((await post(await liveKitAuth(body, { secret: "forged" }))).status, 401);
    assert.equal(billed.length, 0);
    assert.equal((await post(await liveKitAuth(body))).status, 200);
    assert.equal((await post(await liveKitAuth(body))).status, 200);
    assert.deepEqual(
      billed.map((b) => b.seconds),
      [130],
    );
    assert.equal(db.tables["call_logs"]![0]!["status"], "completed");
  });
});

describe("lifecycle safety nets", () => {
  test("the agent's own end report never bills (only the signed LiveKit event does)", async () => {
    const { deps, billed } = sessionDeps();
    const r = await startSipSession(deps, {
      sipCallId: "SCL_E",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    await endSipSession(deps, {
      callId: r.callId!,
      reason: "hangup",
      summary: "intent=book; booking=confirmed",
      outcome: "booked",
    });
    assert.equal(billed.length, 0);
  });
  test("stale SIP calls (lost webhook) are closed as failed and not billed; recent ones untouched", async () => {
    const { deps, db, billed } = sessionDeps();
    await startSipSession(deps, {
      sipCallId: "SCL_OLD",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    db.tables["call_logs"]![0]!["started_at"] = "2026-11-01T00:00:00.000Z";
    await startSipSession(deps, {
      sipCallId: "SCL_NEW",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    assert.deepEqual(await reconcileStaleSipCalls(deps, { olderThanMinutes: 180 }), { closed: 1 });
    assert.deepEqual(
      db.tables["call_logs"]!.map((c) => [
        c["provider_call_id"],
        c["status"],
        c["failure_reason"] ?? null,
      ]),
      [
        ["SCL_OLD", "failed", "livekit_end_event_missing"],
        ["SCL_NEW", "answered", null],
      ],
    );
    assert.equal(billed.length, 0);
    assert.deepEqual(
      await reconcileStaleSipCalls(deps, { olderThanMinutes: 180 }),
      { closed: 0 },
      "idempotent",
    );
  });
  test("outbound: gate first, call row before dialling; then only that row can start a session", async () => {
    const denied = sessionDeps({
      checkAccess: async () => ({ allowed: false, reason: "outbound locked" }),
    });
    assert.deepEqual(
      await prepareOutboundSipCall(denied.deps, {
        organizationId: ORG_A,
        phoneNumberId: PN_A.id,
        toNumber: "+919999999999",
      }),
      { ok: false, reason: "outbound locked" },
    );
    assert.equal(denied.db.tables["call_logs"]!.length, 0);
    const other = sessionDeps();
    assert.deepEqual(
      await prepareOutboundSipCall(other.deps, {
        organizationId: ORG_B,
        phoneNumberId: PN_A.id,
        toNumber: "+919999999999",
      }),
      { ok: false, reason: "number_not_available" },
    );
    const ok = sessionDeps();
    const prep = await prepareOutboundSipCall(ok.deps, {
      organizationId: ORG_A,
      phoneNumberId: PN_A.id,
      toNumber: "+919999999999",
    });
    assert.equal(prep.ok, true);
    const start = await startSipSession(ok.deps, {
      sipCallId: "SCL_OUT",
      roomName: "r",
      calledNumber: "+919999999999",
      callerNumber: null,
      direction: "outbound",
      outboundCallLogId: prep.ok ? prep.callId : undefined,
    });
    assert.equal(start.allowed, true);
    assert.equal(ok.db.tables["call_logs"]![0]!["provider_call_id"], "SCL_OUT");
  });
});

describe("review fixes", () => {
  test("outbound authorisation endpoint is off unless explicitly enabled", async () => {
    const { deps, db } = sessionDeps();
    const h = httpDeps(deps, db);
    const body = { organizationId: ORG_A, phoneNumberId: PN_A.id, toNumber: "+919999999999" };
    const r = await handleOutboundPrepare(
      await signed("/api/internal/voice-agent/outbound", body),
      h,
    );
    assert.equal(r.status, 404);
    assert.equal(db.tables["call_logs"]!.length, 0);
    const enabled: HttpDeps = {
      ...h,
      env: (n) => (n === "VOICE_AGENT_OUTBOUND_ENABLED" ? "true" : h.env(n)),
    };
    const ok = await handleOutboundPrepare(
      await signed("/api/internal/voice-agent/outbound", body, { nonce: "nonce-bbbbbbbbbbbbbbbb" }),
      enabled,
    );
    assert.equal(ok.status, 200);
  });
  test("replay records older than the cutoff are pruned; other providers' rows untouched", async () => {
    const { deps, db } = sessionDeps();
    db.tables["webhook_events"]!.push(
      { provider: "voice_agent_request", event_id: "old", created_at: "2026-10-30T00:00:00.000Z" },
      { provider: "voice_agent_request", event_id: "new", created_at: "2026-11-02T04:00:00.000Z" },
      { provider: "vobiz", event_id: "old-vobiz", created_at: "2026-10-30T00:00:00.000Z" },
    );
    await pruneVoiceAgentNonces(deps, { olderThanHours: 24 });
    assert.deepEqual(db.tables["webhook_events"]!.map((r) => r["event_id"]).sort(), [
      "new",
      "old-vobiz",
    ]);
  });
});

describe("webhook processing failure", () => {
  test("a failed completion releases the claim; LiveKit's retry then bills once", async () => {
    let fail = true;
    const { deps, db, billed } = sessionDeps({
      finalizeBilling: async (call, seconds) => {
        if (fail) throw new Error("db unavailable");
        billed.push({ id: call.id, seconds });
      },
    });
    const h = httpDeps(deps, db);
    await startSipSession(deps, {
      sipCallId: "SCL_R",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    const body = JSON.stringify({
      event: "participant_left",
      id: "EV_R",
      createdAt: "1793600090",
      participant: { joinedAt: "1793600000", attributes: { "sip.callID": "SCL_R" } },
    });
    const post = async () =>
      handleLiveKitWebhook(
        new Request("https://klyro.example/api/public/webhooks/livekit", {
          method: "POST",
          body,
          headers: { authorization: await liveKitAuth(body) },
        }),
        h,
      );
    assert.equal((await post()).status, 500);
    assert.equal(
      db.tables["webhook_events"]!.some((r) => r["event_id"] === "EV_R"),
      false,
      "claim released",
    );
    fail = false;
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    assert.deepEqual(
      billed.map((b) => b.seconds),
      [90],
    );
  });
});
