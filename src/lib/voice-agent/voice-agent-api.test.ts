import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { signRequest, verifySignedRequest, MAX_SKEW_SECONDS } from "./internal-auth.ts";
import { participantSeconds, verifyLiveKitWebhook } from "./livekit-webhook.ts";
import {
  handleLiveKitWebhook,
  handleSessionEnd,
  handleSessionStart,
  handleTool,
  type HttpDeps,
} from "./http.server.ts";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createRateLimiter, type RateLimitStore } from "../rate-limit.server.ts";
import {
  LiveKitApiError,
  LiveKitConfigError,
  allowedLiveKitHosts,
  classifyDispatchError,
  createAgentDispatch,
  deleteLiveKitRoom,
  listLiveKitRooms,
  listRoomParticipants,
  livekitApiBase,
  roomAdminToken,
  roomDeleteToken,
  roomListToken,
} from "./livekit-api.ts";
import { normalizeInboundNumber } from "./phone.ts";
import {
  ROOM_SWEEP_ALERT_AFTER_FAILURES,
  ROOM_SWEEP_BACKOFF_MAX_MS,
  ROOM_SWEEP_MAX_ROWS_PER_RUN,
  maxCallSecondsFromEnv,
  sweepFailed,
  sweepOverdueSipRooms,
  type RoomSweepDeps,
} from "./room-sweep.server.ts";
import { DbError } from "./call-meta.ts";
import {
  CRON_REPLAY_PROVIDER,
  authenticateVoiceCron,
  cronBearerToken,
  signCronRequest,
  type CronAuthDeps,
  type VoiceCronRoute,
} from "./cron-auth.server.ts";
import {
  MAX_TRACKED_SOURCES,
  VOICE_AGENT_LIMITS,
  clientIp,
  createFailureCounter,
  sharedLimitKey,
  sourceKey,
  type SharedScope,
  type VoiceAgentLimiter,
} from "./rate-limits.ts";
import {
  checkDestination,
  outboundCallId,
  startOutboundAgentCall,
  type OutboundDeps,
} from "./outbound.server.ts";
import { handleOutboundClaim } from "./http.server.ts";
import {
  OUTBOUND_CLAIM_TTL_SECONDS,
  VOICE_AGENT_RATE_LIMIT_KEY_PATTERN,
  claimOutboundCall,
  completeSipCallFromLiveKit,
  endSipSession,
  outboundRoomName,
  pruneVoiceAgentNonces,
  pruneVoiceAgentRateLimits,
  reconcileStaleSipCalls,
  runSessionTool,
  startSipSession,
  type SessionDeps,
} from "./sessions.server.ts";

/* ------------------------------------------------------------------ */
/* A small in-memory stand-in for the Supabase client: only what the   */
/* voice-agent code uses. Semantics that matter for correctness:       */
/*  - primary key (id) and the unique indexes call_logs(provider,      */
/*    provider_call_id) and webhook_events(provider, event_id) -> 23505;*/
/*  - each UPDATE ... WHERE applies atomically and can RETURN rows      */
/*    (.select() after .update()), like one SQL statement;             */
/*  - reads return copies (snapshots), never live references;          */
/*  - "col->>key" JSON paths, count/head, LIKE;                       */
/*  - ORDER BY / LIMIT on selects (like PostgREST), and injectable     */
/*    errors per table/operation ({ data: null, error }) to exercise   */
/*    database failures.                                               */
/* Concurrency: callers interleave at awaits, so two Promise.all'd     */
/* claims both read "initiated" and then race on the conditional       */
/* update, exactly as two requests would against PostgreSQL.          */
/* ------------------------------------------------------------------ */
type Row = Record<string, unknown>;
const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CALL_DEFAULTS: Row = {
  ended_at: null,
  answered_at: null,
  duration_seconds: 0,
  customer_charge: 0,
  provider_metadata: {},
  failure_reason: null,
};
type DbOp = "select" | "insert" | "update" | "delete";
type Fault = (table: string, op: DbOp) => { message: string } | null;
function fakeDb(seed: Record<string, Row[]> = {}) {
  const faults: { fn: Fault | null } = { fn: null };
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
  const get = (r: Row, k: string): unknown => {
    const m = k.match(/^(\w+)->>(\w+)$/);
    if (!m) return r[k];
    const o = r[m[1]!] as Row | null | undefined;
    const v = o?.[m[2]!];
    return v === undefined || v === null ? null : String(v);
  };
  const copy = <T>(x: T): T => structuredClone(x);
  function q(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row = {};
    let inserted: Row | null = null;
    let error: { code: string } | null = null;
    let returning = false;
    let countOnly = false;
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    const match = () => tables[table]!.filter((r) => filters.every((f) => f(r)));
    const shaped = () => {
      let rows = match();
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => {
          const x = get(a, col);
          const y = get(b, col);
          if (x === y) return 0;
          if (x === null) return 1; // NULLS LAST (PostgreSQL default for ASC)
          if (y === null) return -1;
          return (String(x) < String(y) ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      return limitN === null ? rows : rows.slice(0, limitN);
    };
    const fault = () => faults.fn?.(table, op) ?? null;
    const api = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (op === "update" || op === "insert") returning = true;
        if (opts?.head) countOnly = true;
        return api;
      },
      eq: (k: string, v: unknown) => (filters.push((r) => get(r, k) === v), api),
      is: (k: string, v: unknown) => (filters.push((r) => (get(r, k) ?? null) === v), api),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(get(r, k))), api),
      lt: (k: string, v: string) => (
        filters.push((r) => get(r, k) !== null && String(get(r, k)) < v),
        api
      ),
      gte: (k: string, v: string) => (
        filters.push((r) => get(r, k) !== null && String(get(r, k)) >= v),
        api
      ),
      like: (k: string, pattern: string) => {
        // SQL LIKE: % = any run, _ = one char, \_ / \% = literal.
        let src = "^";
        for (let n = 0; n < pattern.length; n++) {
          const ch = pattern[n]!;
          if (ch === "\\" && n + 1 < pattern.length) src += escapeRe(pattern[++n]!);
          else if (ch === "%") src += ".*";
          else if (ch === "_") src += ".";
          else src += escapeRe(ch);
        }
        const re = new RegExp(src + "$");
        filters.push((r) => re.test(String(get(r, k))));
        return api;
      },
      order: (col: string, o?: { ascending?: boolean }) => (
        (orderBy = { col, asc: o?.ascending !== false }),
        api
      ),
      limit: (n: number) => ((limitN = n), api),
      insert: (row: Row) => {
        op = "insert";
        const u = unique[table];
        const rows = tables[table]!;
        const withId = {
          id: crypto.randomUUID(),
          ...(table === "call_logs" ? CALL_DEFAULTS : {}),
          ...copy(row),
        };
        if (
          rows.some((r) => r["id"] === withId["id"]) ||
          (u &&
            u.every((k) => row[k] !== null && row[k] !== undefined) &&
            rows.some((r) => u.every((k) => r[k] === row[k])))
        ) {
          error = { code: "23505" };
        } else {
          inserted = withId;
          rows.push(inserted);
        }
        return api;
      },
      update: (p: Row) => ((op = "update"), (payload = p), api),
      delete: () => ((op = "delete"), api),
      maybeSingle: async () => {
        const e = fault();
        return e ? { data: null, error: e } : { data: copy(match()[0] ?? null), error: null };
      },
      single: async () =>
        op === "insert" ? { data: error ? null : copy(inserted), error } : api.maybeSingle(),
      then: (res: (v: unknown) => void) => {
        const e = fault();
        if (e) return res({ data: null, count: null, error: e });
        let data: unknown = null;
        if (op === "delete")
          tables[table] = tables[table]!.filter((r) => !filters.every((f) => f(r)));
        if (op === "update") {
          const hit = match(); // one atomic statement: match and write together
          for (const r of hit) Object.assign(r, copy(payload));
          if (returning) data = copy(hit);
        }
        if (op === "select") data = copy(shaped());
        if (op === "insert" && returning) data = error ? null : [copy(inserted)];
        res({
          data: countOnly ? null : data,
          count: countOnly ? match().length : null,
          error: op === "insert" ? error : null,
        });
      },
    };
    return api;
  }
  return { tables, faults, client: { from: q } };
}

/**
 * In-memory mirror of public.reserve_voice_agent_outbound_call (migration
 * 20261102090000). Synchronous, so atomic within this process. The SQL
 * itself is exercised against real PostgreSQL with concurrent connections in
 * supabase/migrations/voice_agent_outbound_reservation.pg.test.ts.
 */
function fakeReserve(
  tables: Record<string, Row[]>,
  p: Parameters<NonNullable<SessionDeps["reserveOutbound"]>>[0],
): Awaited<ReturnType<NonNullable<SessionDeps["reserveOutbound"]>>> {
  const rows = tables["call_logs"]!;
  const ex = rows.find((r) => r["id"] === p.callId);
  if (ex) {
    if (
      ex["organization_id"] !== p.organizationId ||
      ex["phone_number_id"] !== p.phoneNumberId ||
      ex["destination_number"] !== p.destinationNumber ||
      ex["provider"] !== "livekit_sip" ||
      ex["direction"] !== "outbound"
    )
      return { outcome: "conflict", callId: null, status: null };
    return { outcome: "existing", callId: p.callId, status: String(ex["status"]) };
  }
  const now = Date.parse(p.nowIso);
  const mine = rows.filter(
    (r) =>
      r["organization_id"] === p.organizationId &&
      r["provider"] === "livekit_sip" &&
      r["direction"] === "outbound",
  );
  const active = mine.filter(
    (r) =>
      ["initiated", "ringing", "answered", "in_progress"].includes(String(r["status"])) &&
      !(
        r["status"] === "initiated" &&
        Date.parse(String(r["started_at"])) < now - p.claimTtlSeconds * 1000
      ),
  ).length;
  if (active >= p.maxActive) return { outcome: "limit_active", callId: null, status: null };
  const daily = mine.filter(
    (r) => Date.parse(String(r["started_at"])) >= now - 24 * 3_600_000,
  ).length;
  if (daily >= p.maxDaily) return { outcome: "limit_daily", callId: null, status: null };
  rows.push({
    ...CALL_DEFAULTS,
    id: p.callId,
    organization_id: p.organizationId,
    business_id: p.businessId,
    phone_number_id: p.phoneNumberId,
    provider: "livekit_sip",
    provider_call_id: null,
    direction: "outbound",
    caller_number: p.callerNumber,
    destination_number: p.destinationNumber,
    status: "initiated",
    started_at: p.nowIso,
    provider_metadata: { transport: "sip", dispatch: "pending", requested_by: p.requestedBy },
  });
  return { outcome: "created", callId: p.callId, status: "initiated" };
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
    reserveOutbound: async (p) => fakeReserve(db.tables, p),
    now: () => new Date("2026-11-02T04:30:00Z"),
    ...over,
  };
  return { deps, db, executed, billed };
}

const SECRET = "test-secret-0123456789abcdef";
const ALLOW_ALL: HttpDeps["limiter"] = {
  authFailureBudget: () => ({ allowed: true, retryAfterSeconds: 0 }),
  recordAuthFailure: () => undefined,
  shared: async () => ({ allowed: true, retryAfterSeconds: 0 }),
};
function httpDeps(
  session: SessionDeps,
  db: ReturnType<typeof fakeDb>,
  now = 1_793_600_000,
  limiter: HttpDeps["limiter"] = ALLOW_ALL,
): HttpDeps {
  const env: Record<string, string> = {
    VOICE_AGENT_HMAC_SECRET: SECRET,
    LIVEKIT_API_KEY: "lk-key",
    LIVEKIT_API_SECRET: "lk-secret",
  };
  return {
    session,
    env: (n) => env[n],
    limiter,
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
  opts: {
    secret?: string;
    now?: number;
    nonce?: string;
    keyId?: "current" | "previous";
    ip?: string;
  } = {},
) {
  const text = JSON.stringify(body);
  const h = await signRequest({
    secret: opts.secret ?? SECRET,
    keyId: opts.keyId ?? "current",
    method: "POST",
    path,
    body: text,
    nowSeconds: opts.now ?? 1_793_600_000,
    ...(opts.nonce ? { nonce: opts.nonce } : {}),
  });
  return new Request(`https://klyro.example${path}`, {
    method: "POST",
    body: text,
    headers: {
      ...h,
      "content-type": "application/json",
      ...(opts.ip ? { "cf-connecting-ip": opts.ip } : {}),
    },
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
});

describe("review fixes", () => {
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

/* ================================================================== */
/* Phase 2.2: outbound lifecycle, single-use claims, billing once,    */
/* reconciliation, rate limiting                                       */
/* ================================================================== */

const T0 = Date.parse("2026-11-02T04:30:00Z");
const clockAt = (t: { ms: number }) => () => new Date(t.ms);
const KEY = "11111111-2222-4333-8444-555555555555";
const USER_OWNER = "u-owner";
const OUT_TO = "+919876543210";
const PN_OUT = { ...PN_A, provider: "vobiz", outbound_enabled: true };

function outboundDeps(over: Partial<OutboundDeps> = {}, sessOver: Partial<SessionDeps> = {}) {
  const clock = { ms: T0 };
  const s = sessionDeps({ now: clockAt(clock), ...sessOver });
  s.db.tables["phone_numbers"] = [structuredClone(PN_OUT)];
  const roles: Record<string, string> = {
    [`${USER_OWNER}:${ORG_A}`]: "owner",
    [`u-admin:${ORG_A}`]: "admin",
    [`u-staff:${ORG_A}`]: "staff",
    [`u-manager:${ORG_A}`]: "manager",
  };
  const dispatched: Array<{ room: string; agentName: string; metadata: string }> = [];
  const env: Record<string, string> = {
    VOICE_AGENT_OUTBOUND_ENABLED: "true",
    LIVEKIT_URL: "wss://dev.livekit.cloud",
    LIVEKIT_API_KEY: "lk-key",
    LIVEKIT_API_SECRET: "lk-secret",
  };
  const deps: OutboundDeps = {
    session: s.deps,
    env: (n) => env[n],
    memberRole: async (u, o) => roles[`${u}:${o}`] ?? null,
    canAfford: async () => true,
    rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    dispatch: async (p) => void dispatched.push(p),
    ...over,
  };
  return { ...s, deps, env, dispatched, clock, calls: () => s.db.tables["call_logs"]! };
}
const OUT = { userId: USER_OWNER, phoneNumberId: PN_A.id, toE164: OUT_TO, idempotencyKey: KEY };
const code = (r: { ok: boolean } & Record<string, unknown>) => (r.ok ? "ok" : r["code"]);

/** Creates a dispatched outbound row and returns its id. */
async function placeOutbound(o: ReturnType<typeof outboundDeps>, key = KEY) {
  const r = await startOutboundAgentCall(o.deps, { ...OUT, idempotencyKey: key });
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { callId: string }).callId;
}

describe("H1/M2/M3: outbound request -> row -> dispatch (authorised, idempotent)", () => {
  test("happy path: row id derived from the request key; dispatch metadata names ONLY the row", async () => {
    const o = outboundDeps();
    const r = await startOutboundAgentCall(o.deps, OUT);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.callId, await outboundCallId(ORG_A, USER_OWNER, KEY));
    assert.deepEqual(
      [r.status, r.replayed, r.room],
      ["dispatched", false, outboundRoomName(r.callId)],
    );
    const row = o.calls()[0]!;
    assert.deepEqual(
      [
        row["status"],
        row["direction"],
        row["organization_id"],
        row["caller_number"],
        row["destination_number"],
      ],
      ["initiated", "outbound", ORG_A, PN_A.e164, OUT_TO],
    );
    assert.equal((row["provider_metadata"] as Row)["dispatch"], "dispatched");
    assert.equal((row["provider_metadata"] as Row)["requested_by"], USER_OWNER);
    assert.equal(o.dispatched.length, 1);
    assert.deepEqual(JSON.parse(o.dispatched[0]!.metadata), { outboundCallLogId: r.callId });
    assert.equal(o.dispatched[0]!.agentName, "clickai-receptionist");
  });

  test("the derived id is a valid UUID (accepted by the internal API's zod schemas) and per org/user/key", async () => {
    const a = await outboundCallId(ORG_A, USER_OWNER, KEY);
    assert.equal(z.string().uuid().safeParse(a).success, true);
    assert.equal(a, await outboundCallId(ORG_A, USER_OWNER, KEY.toUpperCase()));
    const others = await Promise.all([
      outboundCallId(ORG_B, USER_OWNER, KEY),
      outboundCallId(ORG_A, "u-admin", KEY),
      outboundCallId(ORG_A, USER_OWNER, "11111111-2222-4333-8444-555555555556"),
    ]);
    assert.equal(new Set([a, ...others]).size, 4);
  });

  test("authorization: owner/admin only; staff and manager refused; another tenant's number == missing number", async () => {
    assert.equal(
      code(await startOutboundAgentCall(outboundDeps().deps, { ...OUT, userId: "u-admin" })),
      "ok",
    );
    for (const u of ["u-staff", "u-manager"]) {
      const o = outboundDeps();
      assert.equal(code(await startOutboundAgentCall(o.deps, { ...OUT, userId: u })), "forbidden");
      assert.equal(o.calls().length + o.dispatched.length, 0);
    }
    const o = outboundDeps();
    const stranger = await startOutboundAgentCall(o.deps, { ...OUT, userId: "u-other-tenant" });
    const missing = await startOutboundAgentCall(o.deps, {
      ...OUT,
      phoneNumberId: "00000000-0000-4000-8000-0000000000ff",
    });
    assert.deepEqual(stranger, missing, "no cross-tenant probing");
    assert.equal(o.calls().length + o.dispatched.length, 0);
  });

  test("kill switch, missing LiveKit config, missing/invalid request id: refused before anything is written", async () => {
    const off = outboundDeps();
    off.env["VOICE_AGENT_OUTBOUND_ENABLED"] = "1";
    assert.equal(code(await startOutboundAgentCall(off.deps, OUT)), "disabled");
    const noLk = outboundDeps();
    delete noLk.env["LIVEKIT_URL"];
    assert.equal(code(await startOutboundAgentCall(noLk.deps, OUT)), "not_configured");
    const bad = outboundDeps();
    assert.equal(
      code(await startOutboundAgentCall(bad.deps, { ...OUT, idempotencyKey: "retry-1" })),
      "invalid_request",
    );
    for (const x of [off, noLk, bad]) assert.equal(x.calls().length + x.dispatched.length, 0);
  });

  test("M2: the same request repeated (sequentially or concurrently) is ONE row and ONE dispatch", async () => {
    const o = outboundDeps();
    const first = await startOutboundAgentCall(o.deps, OUT);
    const again = await startOutboundAgentCall(o.deps, OUT);
    assert.ok(first.ok && again.ok);
    assert.equal(again.ok && again.replayed, true);
    assert.equal(again.ok && again.callId, first.ok && first.callId);
    const c = outboundDeps();
    const all = await Promise.all([1, 2, 3, 4].map(() => startOutboundAgentCall(c.deps, OUT)));
    assert.equal(new Set(all.map((r) => (r.ok ? r.callId : r.code))).size, 1);
    for (const x of [o, c]) {
      assert.equal(x.calls().length, 1, "one row (primary key conflict, not a lookup race)");
      assert.equal(x.dispatched.length, 1, "only the request that created the row dispatches");
    }
    // A new key is a new call; a reused key for another destination is refused.
    assert.equal(
      code(
        await startOutboundAgentCall(o.deps, {
          ...OUT,
          idempotencyKey: "21111111-2222-4333-8444-555555555555",
        }),
      ),
      "ok",
    );
    assert.equal(o.calls().length, 2);
    assert.equal(
      code(await startOutboundAgentCall(o.deps, { ...OUT, toE164: "+919876500000" })),
      "conflict",
    );
    assert.equal(o.calls().length, 2);
  });

  test("ambiguous dispatch (timeout/network/5xx/429): never 'failed', reported pending; retrying the same request re-dispatches", async () => {
    let attempts = 0;
    let mode: "timeout" | "ok" = "timeout";
    const o = outboundDeps({
      dispatch: async () => {
        attempts++;
        if (mode === "timeout") throw new DOMException("aborted", "AbortError");
      },
    });
    const r = await startOutboundAgentCall(o.deps, OUT);
    assert.ok(r.ok);
    assert.equal(r.ok && r.status, "pending");
    assert.equal(attempts, 2, "one immediate retry of an unknown outcome");
    const row = o.calls()[0]!;
    assert.equal(row["status"], "initiated", "a possibly active call is never marked failed");
    assert.equal((row["provider_metadata"] as Row)["dispatch"], "unknown");
    mode = "ok";
    const retry = await startOutboundAgentCall(o.deps, OUT);
    assert.deepEqual(retry.ok && [retry.status, retry.replayed], ["dispatched", true]);
    assert.equal(attempts, 3);
    assert.equal(o.calls().length, 1);
    // 5xx and 429 are unknown too
    for (const status of [503, 429, 408]) {
      const x = outboundDeps({
        dispatch: async () => {
          throw new LiveKitApiError(status, "x");
        },
      });
      const y = await startOutboundAgentCall(x.deps, OUT);
      assert.equal(y.ok && y.status, "pending", String(status));
      assert.equal(x.calls()[0]!["status"], "initiated");
    }
  });

  test("a definite rejection (4xx) closes the row as failed (nothing can dial); no retry; never billed", async () => {
    let attempts = 0;
    const o = outboundDeps({
      dispatch: async () => {
        attempts++;
        throw new LiveKitApiError(401, "unauthenticated");
      },
    });
    assert.equal(code(await startOutboundAgentCall(o.deps, OUT)), "dispatch_rejected");
    assert.equal(attempts, 1);
    const row = o.calls()[0]!;
    assert.deepEqual([row["status"], row["failure_reason"]], ["failed", "dispatch_rejected"]);
    assert.equal(o.billed.length, 0);
    // a replay of the same request does not dispatch again
    const again = await startOutboundAgentCall(o.deps, OUT);
    assert.deepEqual(again.ok && [again.status, again.replayed], ["failed", true]);
    assert.equal(attempts, 1);
  });

  test("an unknown dispatch is not re-dispatched once the claim window is nearly over", async () => {
    let attempts = 0;
    const o = outboundDeps({
      dispatch: async () => {
        attempts++;
        throw new TypeError("fetch failed");
      },
    });
    await startOutboundAgentCall(o.deps, OUT);
    o.clock.ms += (OUTBOUND_CLAIM_TTL_SECONDS - 10) * 1000;
    const late = await startOutboundAgentCall(o.deps, OUT);
    assert.deepEqual(late.ok && [late.status, late.replayed], ["initiated", true]);
    assert.equal(attempts, 2, "no dispatch that could only be refused at claim time");
  });
});

describe("M4: toll-fraud controls", () => {
  const env =
    (m: Record<string, string> = {}) =>
    (n: string) =>
      m[n];
  test("destination policy: India by default, regular subscriber numbers only, no self-calls, explicit blocks", () => {
    const ok = (to: string, e = env()) => checkDestination(to, PN_A.e164, e).ok;
    assert.equal(ok("+919876543210"), true);
    assert.equal(ok("+914023456789"), true, "landline");
    assert.equal(ok("+14155550100"), false, "other countries off by default");
    assert.equal(ok("+911800123456"), false, "toll-free/premium service codes");
    assert.equal(ok("+91190012345"), false);
    assert.equal(ok("+9198765432"), false, "too short");
    assert.equal(ok("+9198765432101"), false, "too long");
    assert.equal(ok(PN_A.e164), false, "calling itself");
    assert.equal(
      ok("+14155550100", env({ VOICE_AGENT_OUTBOUND_ALLOWED_PREFIXES: "+91,+1" })),
      true,
    );
    assert.equal(
      ok("+919876543210", env({ VOICE_AGENT_OUTBOUND_BLOCKED_PREFIXES: "+91987" })),
      false,
    );
    assert.equal(
      ok("+919876543210", env({ VOICE_AGENT_OUTBOUND_ALLOWED_PREFIXES: "junk" })),
      false,
      "junk config allows nothing",
    );
  });
  test("caps: concurrent and daily limits per organization (old rows not counted); nothing written when refused", async () => {
    const active = outboundDeps();
    for (const st of ["initiated", "ringing", "answered"])
      active.calls().push({
        id: crypto.randomUUID(),
        organization_id: ORG_A,
        provider: "livekit_sip",
        direction: "outbound",
        status: st,
        started_at: new Date(T0 - 60_000).toISOString(),
      });
    assert.equal(code(await startOutboundAgentCall(active.deps, OUT)), "limit_reached");
    assert.equal(active.calls().length, 3);
    assert.equal(active.dispatched.length, 0);
    const daily = outboundDeps();
    daily.env["VOICE_AGENT_OUTBOUND_DAILY_LIMIT"] = "2";
    for (const ago of [3_600_000, 7_200_000, 25 * 3_600_000])
      daily.calls().push({
        id: crypto.randomUUID(),
        organization_id: ORG_A,
        provider: "livekit_sip",
        direction: "outbound",
        status: "completed",
        started_at: new Date(T0 - ago).toISOString(),
      });
    assert.equal(code(await startOutboundAgentCall(daily.deps, OUT)), "limit_reached");
    daily.env["VOICE_AGENT_OUTBOUND_DAILY_LIMIT"] = "3";
    assert.equal(
      code(await startOutboundAgentCall(daily.deps, OUT)),
      "ok",
      "the 25 h old row is outside the window",
    );
  });
  test("L3: refusals are classified accurately", async () => {
    const suspended = outboundDeps();
    suspended.db.tables["phone_numbers"]![0]!["status"] = "suspended";
    assert.equal(code(await startOutboundAgentCall(suspended.deps, OUT)), "not_available");
    const locked = outboundDeps(
      {},
      {
        checkAccess: async () => ({
          allowed: false,
          reason: "Outbound calling is disabled on this number.",
        }),
      },
    );
    const l = await startOutboundAgentCall(locked.deps, OUT);
    assert.deepEqual(
      [code(l), !l.ok && l.message],
      ["not_entitled", "Outbound calling is disabled on this number."],
    );
    // the reservation function missing (migration not applied) or failing:
    // outbound fails closed, never falls back to a racy count-then-insert
    for (const over of [
      { reserveOutbound: undefined },
      {
        reserveOutbound: async () => {
          throw new Error("function public.reserve_voice_agent_outbound_call does not exist");
        },
      },
    ]) {
      const broken = outboundDeps({}, over as Partial<SessionDeps>);
      assert.equal(code(await startOutboundAgentCall(broken.deps, OUT)), "internal_error");
      assert.equal(broken.calls().length + broken.dispatched.length, 0);
    }
    const nonVobiz = outboundDeps();
    nonVobiz.db.tables["phone_numbers"]![0]!["provider"] = "sarvam";
    assert.equal(code(await startOutboundAgentCall(nonVobiz.deps, OUT)), "unsupported_number");
    const poor = outboundDeps({ canAfford: async () => false });
    assert.equal(code(await startOutboundAgentCall(poor.deps, OUT)), "insufficient_balance");
    const limited = outboundDeps({
      rateLimit: async () => ({ allowed: false, retryAfterSeconds: 9 }),
    });
    assert.equal(code(await startOutboundAgentCall(limited.deps, OUT)), "rate_limited");
    for (const x of [suspended, locked, nonVobiz, poor, limited])
      assert.equal(x.dispatched.length, 0);
  });
});

describe("H1/M3: the agent's claim (one job, before dialling; numbers only from the row)", () => {
  test("claim returns the row's destination and caller ID; wrong room refused", async () => {
    const o = outboundDeps();
    const id = await placeOutbound(o);
    assert.deepEqual(
      await claimOutboundCall(o.deps.session, { callId: id, roomName: "out-other", jobId: "AJ_1" }),
      { ok: false, reason: "wrong_room" },
    );
    const c = await claimOutboundCall(o.deps.session, {
      callId: id,
      roomName: outboundRoomName(id),
      jobId: "AJ_1",
    });
    assert.deepEqual(c, { ok: true, callId: id, toNumber: OUT_TO, fromNumber: PN_A.e164 });
    const row = o.calls()[0]!;
    assert.equal(row["status"], "ringing");
    assert.equal(((row["provider_metadata"] as Row)["claim"] as Row)["job_id"], "AJ_1");
  });
  test("single winner: a duplicate dispatch (second job) is refused; the same job retrying gets the same answer", async () => {
    const o = outboundDeps();
    const id = await placeOutbound(o);
    const room = outboundRoomName(id);
    const results = await Promise.all(
      ["AJ_1", "AJ_2", "AJ_3"].map((jobId) =>
        claimOutboundCall(o.deps.session, { callId: id, roomName: room, jobId }),
      ),
    );
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, "exactly one job may dial");
    const winnerJob = ((o.calls()[0]!["provider_metadata"] as Row)["claim"] as Row)[
      "job_id"
    ] as string;
    assert.equal(
      (await claimOutboundCall(o.deps.session, { callId: id, roomName: room, jobId: winnerJob }))
        .ok,
      true,
    );
    const loser = ["AJ_1", "AJ_2", "AJ_3"].find((j) => j !== winnerJob)!;
    assert.deepEqual(
      await claimOutboundCall(o.deps.session, { callId: id, roomName: room, jobId: loser }),
      {
        ok: false,
        reason: "already_claimed",
      },
    );
  });
  test("expired rows, ended rows and revoked entitlement cannot be claimed", async () => {
    const o = outboundDeps();
    const id = await placeOutbound(o);
    o.clock.ms += (OUTBOUND_CLAIM_TTL_SECONDS + 1) * 1000;
    assert.deepEqual(
      await claimOutboundCall(o.deps.session, {
        callId: id,
        roomName: outboundRoomName(id),
        jobId: "AJ",
      }),
      { ok: false, reason: "expired" },
    );
    const f = outboundDeps();
    const fid = await placeOutbound(f);
    f.calls()[0]!["status"] = "failed";
    assert.deepEqual(
      await claimOutboundCall(f.deps.session, {
        callId: fid,
        roomName: outboundRoomName(fid),
        jobId: "AJ",
      }),
      { ok: false, reason: "call_ended" },
    );
    let allowed = true;
    const g = outboundDeps(
      {},
      { checkAccess: async () => ({ allowed, reason: allowed ? null : "locked" }) },
    );
    const gid = await placeOutbound(g);
    allowed = false;
    assert.deepEqual(
      await claimOutboundCall(g.deps.session, {
        callId: gid,
        roomName: outboundRoomName(gid),
        jobId: "AJ",
      }),
      { ok: false, reason: "not_entitled" },
    );
    assert.deepEqual(
      [g.calls()[0]!["status"], g.calls()[0]!["failure_reason"]],
      ["failed", "not_entitled_at_dial"],
    );
  });
  test("HTTP: the claim endpoint is signed; refusals are 409; a forged request writes nothing", async () => {
    const o = outboundDeps();
    const id = await placeOutbound(o);
    const h = httpDeps(o.deps.session, o.db);
    const body = { callId: id, roomName: outboundRoomName(id), jobId: "AJ_1" };
    const unsigned = await handleOutboundClaim(
      new Request("https://klyro.example/api/internal/voice-agent/outbound-claim", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      h,
    );
    assert.equal(unsigned.status, 401);
    assert.equal(o.calls()[0]!["status"], "initiated");
    const ok = await handleOutboundClaim(
      await signed("/api/internal/voice-agent/outbound-claim", body, {
        nonce: "nonce-claim-aaaaaaaaaa",
      }),
      h,
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      ok: true,
      callId: id,
      toNumber: OUT_TO,
      fromNumber: PN_A.e164,
    });
    const other = await handleOutboundClaim(
      await signed(
        "/api/internal/voice-agent/outbound-claim",
        { ...body, jobId: "AJ_2" },
        { nonce: "nonce-claim-bbbbbbbbbb" },
      ),
      h,
    );
    assert.equal(other.status, 409);
  });
});

describe("H2: outbound session start is single-use", () => {
  async function claimed() {
    const o = outboundDeps();
    const id = await placeOutbound(o);
    await claimOutboundCall(o.deps.session, {
      callId: id,
      roomName: outboundRoomName(id),
      jobId: "AJ_1",
    });
    return { o, id };
  }
  const start = (
    o: ReturnType<typeof outboundDeps>,
    id: string,
    sipCallId: string,
    room = outboundRoomName(id),
  ) =>
    startSipSession(o.deps.session, {
      sipCallId,
      roomName: room,
      calledNumber: OUT_TO,
      callerNumber: null,
      direction: "outbound",
      outboundCallLogId: id,
    });

  test("an unclaimed row or the wrong room cannot start a session", async () => {
    const o = outboundDeps();
    const id = await placeOutbound(o);
    assert.deepEqual(await start(o, id, "SCL_1"), {
      allowed: false,
      reason: "invalid_outbound",
      callId: id,
    });
    const c = await claimed();
    assert.deepEqual(await start(c.o, c.id, "SCL_1", "out-elsewhere"), {
      allowed: false,
      reason: "invalid_outbound",
      callId: null,
    });
  });
  test("claimed -> answered once; the same SIP call retrying is idempotent; another SIP call is refused", async () => {
    const { o, id } = await claimed();
    const a = await start(o, id, "SCL_1");
    assert.equal(a.allowed, true);
    assert.deepEqual(
      [o.calls()[0]!["status"], o.calls()[0]!["provider_call_id"]],
      ["answered", "SCL_1"],
    );
    assert.equal((await start(o, id, "SCL_1")).allowed, true, "retry of the same SIP call");
    assert.deepEqual(await start(o, id, "SCL_2"), {
      allowed: false,
      reason: "already_started",
      callId: id,
    });
    assert.equal(o.calls().length, 1);
  });
  test("concurrent starts by different SIP calls: exactly one live session", async () => {
    const { o, id } = await claimed();
    const r = await Promise.all(["SCL_A", "SCL_B", "SCL_C"].map((s) => start(o, id, s)));
    assert.equal(r.filter((x) => x.allowed).length, 1);
    assert.equal(r.filter((x) => !x.allowed && x.reason === "already_started").length, 2);
  });
});

describe("M6 / failed dials: the row is closed, never billed, never left open", () => {
  test("a failed dial reported by the agent closes a claimed (ringing) row as failed", async () => {
    const o = outboundDeps();
    const id = await placeOutbound(o);
    await claimOutboundCall(o.deps.session, {
      callId: id,
      roomName: outboundRoomName(id),
      jobId: "AJ_1",
    });
    await endSipSession(o.deps.session, { callId: id, reason: "dial_failed:busy", jobId: "AJ_1" });
    assert.deepEqual(
      [o.calls()[0]!["status"], o.calls()[0]!["failure_reason"]],
      ["failed", "dial_failed:busy"],
    );
    assert.equal(o.billed.length, 0);
  });
  test("race: answer vs failed-dial report -> one consistent outcome, never answered AND failed", async () => {
    for (let i = 0; i < 20; i++) {
      const o = outboundDeps();
      const id = await placeOutbound(o);
      await claimOutboundCall(o.deps.session, {
        callId: id,
        roomName: outboundRoomName(id),
        jobId: "AJ_1",
      });
      const [st] = await Promise.all([
        startSipSession(o.deps.session, {
          sipCallId: "SCL_X",
          roomName: outboundRoomName(id),
          calledNumber: OUT_TO,
          callerNumber: null,
          direction: "outbound",
          outboundCallLogId: id,
        }),
        endSipSession(o.deps.session, { callId: id, reason: "dial_failed:timeout", jobId: "AJ_1" }),
      ]);
      const status = o.calls()[0]!["status"];
      if (st.allowed) assert.equal(status, "answered");
      else assert.equal(status, "failed");
    }
  });
  test("answered calls keep their status on the agent's end report; klyro records when it heard the end", async () => {
    const { deps, db } = sessionDeps();
    const s = await startSipSession(deps, {
      sipCallId: "SCL_E",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    await endSipSession(deps, { callId: s.callId!, reason: "caller_hung_up", outcome: "booked" });
    const row = db.tables["call_logs"]![0]!;
    assert.deepEqual([row["status"], row["outcome"]], ["answered", "booked"]);
    assert.equal(typeof (row["provider_metadata"] as Row)["agent_ended_at"], "string");
  });
});

describe("M1/M7: completion and billing happen exactly once", () => {
  const webhookBody = (sip: string, joined: number, left: number, id = `EV_${sip}`) =>
    JSON.stringify({
      event: "participant_left",
      id,
      createdAt: String(left),
      participant: { joinedAt: String(joined), attributes: { "sip.callID": sip } },
    });
  const post = async (h: HttpDeps, body: string, ip = "203.0.113.10") =>
    handleLiveKitWebhook(
      new Request("https://klyro.example/api/public/webhooks/livekit", {
        method: "POST",
        body,
        headers: { authorization: await liveKitAuth(body), "cf-connecting-ip": ip },
      }),
      h,
    );

  test("M7: outbound bills from klyro's answered time, not LiveKit's joinedAt (ringing excluded)", async () => {
    const o = outboundDeps();
    const id = await placeOutbound(o);
    await claimOutboundCall(o.deps.session, {
      callId: id,
      roomName: outboundRoomName(id),
      jobId: "AJ_1",
    });
    const answered = Math.floor(o.clock.ms / 1000) + 25;
    o.clock.ms = answered * 1000;
    await startSipSession(o.deps.session, {
      sipCallId: "SCL_O",
      roomName: outboundRoomName(id),
      calledNumber: OUT_TO,
      callerNumber: null,
      direction: "outbound",
      outboundCallLogId: id,
    });
    const h = httpDeps(o.deps.session, o.db);
    // LiveKit: participant joined 20 s before the answer (ringing), left 60 s after it.
    assert.equal((await post(h, webhookBody("SCL_O", answered - 20, answered + 60))).status, 200);
    assert.deepEqual(
      o.billed.map((b) => b.seconds),
      [60],
    );
  });

  test("webhook + agent-report recovery racing on the same call: billed once", async () => {
    const clock = { ms: T0 };
    const s = sessionDeps({ now: clockAt(clock) });
    const st = await startSipSession(s.deps, {
      sipCallId: "SCL_R2",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    clock.ms += 120_000;
    await endSipSession(s.deps, { callId: st.callId!, reason: "hangup" });
    clock.ms += 16 * 60_000; // past the agent-report recovery delay
    const h = httpDeps(s.deps, s.db);
    const joined = Math.floor(T0 / 1000);
    await Promise.all([
      post(h, webhookBody("SCL_R2", joined, joined + 120)),
      reconcileStaleSipCalls(s.deps),
      reconcileStaleSipCalls(s.deps),
    ]);
    assert.equal(s.billed.length, 1, "exactly one billing");
    assert.equal(s.db.tables["call_logs"]![0]!["status"], "completed");
    assert.equal((s.db.tables["call_logs"]![0]!["provider_metadata"] as Row)["billing"], "done");
  });

  test("billing that throws is marked for retry; the sweep bills it once with the stored duration; later runs and late webhooks do not", async () => {
    const clock = { ms: T0 };
    let fail = true;
    const s = sessionDeps({
      now: clockAt(clock),
      finalizeBilling: async (call, seconds) => {
        if (fail) throw new Error("db unavailable");
        s.billed.push({ id: call.id, seconds });
      },
    });
    await startSipSession(s.deps, {
      sipCallId: "SCL_P",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    await assert.rejects(completeSipCallFromLiveKit(s.deps, { sipCallId: "SCL_P", seconds: 75 }));
    assert.equal((s.db.tables["call_logs"]![0]!["provider_metadata"] as Row)["billing"], "retry");
    fail = false;
    clock.ms += 11 * 60_000;
    const r1 = await reconcileStaleSipCalls(s.deps);
    assert.equal(r1.billingRetried, 1);
    assert.deepEqual(
      s.billed.map((b) => b.seconds),
      [75],
    );
    assert.equal((await reconcileStaleSipCalls(s.deps)).billingRetried, 0);
    await completeSipCallFromLiveKit(s.deps, { sipCallId: "SCL_P", seconds: 999 });
    assert.deepEqual(
      s.billed.map((b) => b.seconds),
      [75],
      "a late webhook never bills again",
    );
  });

  test("a signed webhook is never rate-limited, even from a source that also sent forgeries", async () => {
    const { deps, db, billed } = sessionDeps();
    const h = httpDeps(deps, db, undefined, realLimiter().limiter);
    await startSipSession(deps, {
      sipCallId: "SCL_W",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    // 100 valid (non-billing) events from LiveKit's IP: never counted
    for (let i = 0; i < 100; i++) {
      const b = JSON.stringify({
        event: "track_published",
        id: `EV_T${i}`,
        createdAt: "1793600001",
      });
      assert.equal((await post(h, b, "198.51.100.7")).status, 200);
    }
    const forged = (ip: string) =>
      handleLiveKitWebhook(
        new Request("https://klyro.example/api/public/webhooks/livekit", {
          method: "POST",
          body: "{}",
          headers: { authorization: "Bearer x.y.z", "cf-connecting-ip": ip },
        }),
        h,
      );
    for (let i = 0; i < VOICE_AGENT_LIMITS.webhook.limit; i++)
      assert.equal((await forged("192.0.2.66")).status, 401);
    assert.equal(
      (await forged("192.0.2.66")).status,
      429,
      "the forging source is cut off before any JWT work",
    );
    assert.equal(
      (await post(h, webhookBody("SCL_W", 1_793_600_000, 1_793_600_060), "198.51.100.7")).status,
      200,
    );
    assert.deepEqual(
      billed.map((b) => b.seconds),
      [60],
    );
  });
});

describe("L6: reconciliation sweep", () => {
  function seedRow(s: ReturnType<typeof sessionDeps>, r: Row) {
    const row = {
      id: crypto.randomUUID(),
      organization_id: ORG_A,
      business_id: BIZ_A,
      provider: "livekit_sip",
      ended_at: null,
      answered_at: null,
      duration_seconds: 0,
      customer_charge: 0,
      provider_metadata: {},
      ...r,
    };
    s.db.tables["call_logs"]!.push(row);
    return row["id"] as string;
  }
  const iso = (ms: number) => new Date(ms).toISOString();

  test("buckets close only what is safe; counts are rows actually changed; a second run changes nothing", async () => {
    const clock = { ms: T0 };
    const s = sessionDeps({ now: clockAt(clock) });
    const notDialed = seedRow(s, {
      direction: "outbound",
      status: "initiated",
      started_at: iso(T0 - 11 * 60_000),
    });
    const youngInitiated = seedRow(s, {
      direction: "outbound",
      status: "initiated",
      started_at: iso(T0 - 60_000),
    });
    const dialStuck = seedRow(s, {
      direction: "outbound",
      status: "ringing",
      started_at: iso(T0 - 40 * 60_000),
      provider_metadata: { claim: { job_id: "AJ", claimed_at: iso(T0 - 31 * 60_000) } },
    });
    const ringingRecent = seedRow(s, {
      direction: "outbound",
      status: "ringing",
      started_at: iso(T0 - 12 * 60_000),
      provider_metadata: { claim: { job_id: "AJ", claimed_at: iso(T0 - 11 * 60_000) } },
    });
    const lost = seedRow(s, {
      direction: "inbound",
      status: "answered",
      started_at: iso(T0 - 181 * 60_000),
      answered_at: iso(T0 - 181 * 60_000),
    });
    const reported = seedRow(s, {
      direction: "inbound",
      status: "answered",
      started_at: iso(T0 - 30 * 60_000),
      answered_at: iso(T0 - 30 * 60_000),
      provider_metadata: { agent_ended_at: iso(T0 - 25 * 60_000) },
    });
    const live = seedRow(s, {
      direction: "inbound",
      status: "answered",
      started_at: iso(T0 - 20 * 60_000),
      answered_at: iso(T0 - 20 * 60_000),
    });
    const r = await reconcileStaleSipCalls(s.deps);
    assert.deepEqual(
      [r.notDialed, r.dialNotCompleted, r.endEventMissing, r.billedFromAgentReport],
      [1, 1, 1, 1],
    );
    const by = (id: string) => s.db.tables["call_logs"]!.find((x) => x["id"] === id)!;
    assert.deepEqual(
      [by(notDialed)["status"], by(notDialed)["failure_reason"]],
      ["failed", "not_dialed"],
    );
    assert.deepEqual(
      [by(dialStuck)["status"], by(dialStuck)["failure_reason"]],
      ["failed", "dial_not_completed"],
    );
    assert.deepEqual(
      [by(lost)["status"], by(lost)["failure_reason"]],
      ["failed", "livekit_end_event_missing"],
    );
    assert.equal(by(reported)["status"], "completed");
    assert.deepEqual(
      s.billed.map((b) => b.seconds),
      [300],
      "answered -> agent end report, klyro's clock",
    );
    for (const id of [youngInitiated, ringingRecent, live]) assert.equal(by(id)["ended_at"], null);
    assert.deepEqual(Object.values(await reconcileStaleSipCalls(s.deps)), [0, 0, 0, 0, 0, 0]);
    // a delayed job can no longer claim the row the sweep closed
    assert.deepEqual(
      await claimOutboundCall(s.deps, {
        callId: notDialed,
        roomName: outboundRoomName(notDialed),
        jobId: "LATE",
      }),
      { ok: false, reason: "not_found" },
    );
  });

  test("overlapping runs: each row closed once, counts add up", async () => {
    const s = sessionDeps({ now: () => new Date(T0) });
    for (let i = 0; i < 6; i++)
      seedRow(s, {
        direction: "inbound",
        status: "answered",
        started_at: iso(T0 - 200 * 60_000),
        answered_at: iso(T0 - 200 * 60_000),
      });
    const [a, b] = await Promise.all([
      reconcileStaleSipCalls(s.deps),
      reconcileStaleSipCalls(s.deps),
    ]);
    assert.equal(a.endEventMissing + b.endEventMissing, 6);
  });

  test("billing work per run is bounded (Workers subrequests); the rest is deferred to the next run", async () => {
    const s = sessionDeps({ now: () => new Date(T0) });
    for (let i = 0; i < 6; i++)
      seedRow(s, {
        direction: "inbound",
        status: "answered",
        started_at: iso(T0 - 40 * 60_000),
        answered_at: iso(T0 - 40 * 60_000),
        provider_metadata: { agent_ended_at: iso(T0 - 30 * 60_000) },
      });
    const r1 = await reconcileStaleSipCalls(s.deps);
    assert.deepEqual([r1.billedFromAgentReport, r1.deferred], [4, 2]);
    const r2 = await reconcileStaleSipCalls(s.deps);
    assert.deepEqual([r2.billedFromAgentReport, r2.deferred], [2, 0]);
    assert.equal(s.billed.length, 6);
  });
});

/* ------------------------------------------------------------------ */
/* H4: rate limiting                                                   */
/* ------------------------------------------------------------------ */

/** The real limiter logic (failure counters + createRateLimiter) over an in-memory store. */
function realLimiter(opts: { failShared?: boolean; maxKeys?: number } = {}) {
  const counts = new Map<string, number>();
  const store: RateLimitStore = {
    async increment(key, windowStart) {
      if (opts.failShared) throw new Error("rate limit store down");
      const k = `${key}@${windowStart}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      return counts.get(k)!;
    },
  };
  const counterOpts = opts.maxKeys === undefined ? {} : { maxKeys: opts.maxKeys };
  const failures = {
    internal: createFailureCounter(VOICE_AGENT_LIMITS.internal.limit, 60, counterOpts),
    webhook: createFailureCounter(VOICE_AGENT_LIMITS.webhook.limit, 60, counterOpts),
    cron: createFailureCounter(VOICE_AGENT_LIMITS.cron.limit, 60, counterOpts),
  };
  const shared = new Map<
    SharedScope,
    (k: string) => Promise<{ allowed: boolean; retryAfterSeconds: number }>
  >();
  const limiter: VoiceAgentLimiter = {
    authFailureBudget: (scope, ip) => failures[scope].peek(sourceKey(ip)),
    recordAuthFailure: (scope, ip) => failures[scope].record(sourceKey(ip)),
    shared: (scope, key) => {
      if (!shared.has(scope)) {
        const { limit, windowSeconds } = VOICE_AGENT_LIMITS[scope];
        shared.set(
          scope,
          createRateLimiter(
            { increment: (k, w) => store.increment(sharedLimitKey(scope, k), w) },
            limit,
            windowSeconds,
          ),
        );
      }
      return shared.get(scope)!(key);
    },
  };
  return { limiter, counts, failures };
}

describe("H4: pre-auth limiter cannot be turned against legitimate senders", () => {
  test("source keys: IPv4 /32, IPv6 /64 (compressed, mixed, mapped forms), junk -> one bucket", () => {
    assert.equal(sourceKey("203.0.113.5"), "v4:203.0.113.5");
    assert.equal(
      sourceKey("2001:db8:1:2::1"),
      sourceKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"),
    );
    assert.notEqual(sourceKey("2001:db8:1:2::1"), sourceKey("2001:db8:1:3::1"));
    assert.equal(sourceKey("2001:db8:1:2::1"), "v6:2001:db8:1:2::/64");
    assert.equal(sourceKey("::ffff:203.0.113.5"), "v4:203.0.113.5");
    assert.equal(sourceKey("::1"), "v6:0:0:0:0::/64");
    for (const junk of ["", "unknown", "999.1.1.1", "1:2:3", "1::2::3", "zz::1"])
      assert.equal(sourceKey(junk), "unknown", junk);
  });
  test("failure counter: peek never counts; limit + Retry-After; window expiry; memory bounded by evicting the OLDEST", () => {
    const t = { ms: 0 };
    const c = createFailureCounter(3, 60, { now: () => t.ms, maxKeys: 3 });
    for (let i = 0; i < 10; i++) assert.equal(c.peek("a").allowed, true, "peeking is free");
    for (let i = 0; i < 3; i++) c.record("a");
    const d = c.peek("a");
    assert.deepEqual([d.allowed, d.retryAfterSeconds], [false, 60]);
    t.ms += 60_000;
    assert.equal(c.peek("a").allowed, true, "window over");
    for (let i = 0; i < 3; i++) c.record("x");
    c.record("y");
    c.record("z");
    c.record("w"); // evicts x, the oldest
    assert.equal(c.size(), 3);
    assert.equal(c.peek("x").allowed, true, "eviction frees, it never blocks");
    assert.equal(c.peek("brand-new").allowed, true, "a full table never refuses an unseen sender");
  });
  test("IPv6 spray of 20,000 forged requests: memory stays bounded and the agent's signed requests still pass", async () => {
    const { deps, db } = sessionDeps();
    const { limiter, failures } = realLimiter();
    const h = httpDeps(deps, db, undefined, limiter);
    for (let i = 0; i < 20_000; i++) {
      const ip = `2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`;
      const r = await handleSessionStart(
        new Request("https://klyro.example/api/internal/voice-agent/session", {
          method: "POST",
          body: "{}",
          headers: { "cf-connecting-ip": ip },
        }),
        h,
      );
      assert.equal(r.status, 401);
    }
    assert.ok(failures.internal.size() <= MAX_TRACKED_SOURCES);
    const req = await signed("/api/internal/voice-agent/session", {
      sipCallId: "SCL_AG",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    req.headers.set("cf-connecting-ip", "198.51.100.20");
    assert.equal((await handleSessionStart(req, h)).status, 200);
    assert.equal(
      db.tables["webhook_events"]!.length,
      1,
      "forgeries wrote nothing; only the valid nonce",
    );
  });
  test("one source that keeps failing gets 429 for further invalid requests; other sources and valid traffic are unaffected", async () => {
    const { deps, db } = sessionDeps();
    const h = httpDeps(deps, db, undefined, realLimiter().limiter);
    const forged = () =>
      handleSessionStart(
        new Request("https://klyro.example/api/internal/voice-agent/session", {
          method: "POST",
          body: "{}",
          headers: { "cf-connecting-ip": "192.0.2.9" },
        }),
        h,
      );
    for (let i = 0; i < VOICE_AGENT_LIMITS.internal.limit; i++)
      assert.equal((await forged()).status, 401);
    const cut = await forged();
    assert.equal(cut.status, 429);
    assert.ok(Number(cut.headers.get("retry-after")) >= 1);
    // More valid requests than the failure budget. Distinct called numbers:
    // the per-number session limit (30/min) is a separate, post-auth limit.
    for (let i = 0; i < VOICE_AGENT_LIMITS.internal.limit + 5; i++) {
      const req = await signed(
        "/api/internal/voice-agent/session",
        {
          sipCallId: `SCL_V${i}`,
          roomName: "r",
          calledNumber: `+9180000${String(i).padStart(5, "0")}`,
          callerNumber: null,
          direction: "inbound",
        },
        { nonce: `nonce-valid-${String(i).padStart(10, "0")}` },
      );
      req.headers.set("cf-connecting-ip", "198.51.100.20");
      assert.notEqual(
        (await handleSessionStart(req, h)).status,
        429,
        "valid signed requests are never counted",
      );
    }
  });
});

describe("shared (post-authentication) limits", () => {
  test("tool calls are limited per call; other calls unaffected; nothing executed when limited", async () => {
    const { deps, db, executed } = sessionDeps();
    const h = httpDeps(deps, db, undefined, realLimiter().limiter);
    const start = await startSipSession(deps, {
      sipCallId: "SCL_T",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    const tool = (i: number, id = start.callId!) =>
      signed(
        "/api/internal/voice-agent/tool",
        { callId: id, tool: "check_calendar_availability", input: {} },
        { nonce: `nonce-tool-${String(i).padStart(12, "0")}` },
      ).then((r) => handleTool(r, h));
    const limit = VOICE_AGENT_LIMITS.tool.limit;
    for (let i = 0; i < limit; i++) assert.equal((await tool(i)).status, 200);
    assert.equal((await tool(limit)).status, 429);
    assert.equal(executed.length, limit);
    assert.equal((await tool(limit + 1, "11111111-1111-4111-8111-111111111111")).status, 404);
  });
  test("session start is limited per called number; a limited start creates no row", async () => {
    const { deps, db } = sessionDeps();
    const h = httpDeps(deps, db, undefined, realLimiter().limiter);
    const limit = VOICE_AGENT_LIMITS.session_start.limit;
    const start = (i: number) =>
      signed(
        "/api/internal/voice-agent/session",
        {
          sipCallId: `SCL_S${i}`,
          roomName: "r",
          calledNumber: PN_A.e164,
          callerNumber: null,
          direction: "inbound",
        },
        { nonce: `nonce-start-${String(i).padStart(12, "0")}` },
      ).then((r) => handleSessionStart(r, h));
    for (let i = 0; i < limit; i++) assert.equal((await start(i)).status, 200);
    assert.equal((await start(limit)).status, 429);
    assert.equal(db.tables["call_logs"]!.length, limit);
  });
  test("a broken shared counter fails closed (429)", async () => {
    const { deps, db, executed } = sessionDeps();
    const h = httpDeps(deps, db, undefined, realLimiter({ failShared: true }).limiter);
    const r = await handleTool(
      await signed("/api/internal/voice-agent/tool", {
        callId: "11111111-1111-4111-8111-111111111111",
        tool: "check_calendar_availability",
        input: {},
      }),
      h,
    );
    assert.equal(r.status, 429);
    assert.equal(executed.length, 0);
  });
  test("client IP comes from cf-connecting-ip only", () => {
    const r = (hd: Record<string, string>) => new Request("https://k/x", { headers: hd });
    assert.equal(
      clientIp(r({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1" })),
      "203.0.113.9",
    );
    assert.equal(clientIp(r({ "x-forwarded-for": "1.1.1.1" })), "unknown");
  });
});

describe("housekeeping, wiring and staging scheduler", () => {
  test("L1: rate-limit keys match the cleanup pattern; other formats never do", async () => {
    assert.equal(VOICE_AGENT_RATE_LIMIT_KEY_PATTERN, "voice_agent_%");
    const { deps, db } = sessionDeps();
    db.tables["public_assistant_rate_limits"] = [
      { client_key: sharedLimitKey("tool", "c1"), window_start: "2026-10-30T00:00:00.000Z" },
      { client_key: sharedLimitKey("tool", "c2"), window_start: "2026-11-02T04:29:00.000Z" },
      {
        client_key: "chat:9f86d081884c7d659a2feaa0c55ad015",
        window_start: "2026-10-30T00:00:00.000Z",
      },
      {
        client_key: "voice:9f86d081884c7d659a2feaa0c55ad015",
        window_start: "2026-10-30T00:00:00.000Z",
      },
      { client_key: "sarvam_context:pn-1", window_start: "2026-10-30T00:00:00.000Z" },
    ];
    await pruneVoiceAgentRateLimits(deps, { olderThanHours: 24 });
    assert.deepEqual(
      db.tables["public_assistant_rate_limits"]!.map((r) => r["client_key"]).sort(),
      [
        "chat:9f86d081884c7d659a2feaa0c55ad015",
        "sarvam_context:pn-1",
        "voice:9f86d081884c7d659a2feaa0c55ad015",
        sharedLimitKey("tool", "c2"),
      ],
    );
  });
  test("the HMAC /outbound endpoint is gone; the server function takes the user from auth and requires an idempotency key", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, "../../..");
    assert.equal(existsSync(join(root, "src/routes/api/internal/voice-agent/outbound.ts")), false);
    const tree = readFileSync(join(root, "src/routeTree.gen.ts"), "utf8");
    assert.doesNotMatch(tree, /'\/api\/internal\/voice-agent\/outbound'/);
    assert.match(tree, /\/api\/internal\/voice-agent\/outbound-claim/);
    const fn = readFileSync(join(here, "outbound.functions.ts"), "utf8");
    assert.match(fn, /\.middleware\(\[requireSupabaseAuth\]\)/);
    assert.match(
      fn,
      /\{ \.\.\.data, userId: context\.userId \}/,
      "userId last: input can never override it",
    );
    assert.match(fn, /typeof input\?\.idempotencyKey !== "string"/);
    // No organization id is accepted from the client: not in the input type,
    // not read from data (the role lookup derives it from the number row).
    const inputType = fn.slice(
      fn.indexOf("interface StartAgentOutboundCallInput"),
      fn.indexOf("export const"),
    );
    assert.doesNotMatch(inputType, /organization/i);
    assert.doesNotMatch(fn, /data\.organization/);
  });
  test("L5: staging scheduler: reconcile every 15 min; the helper re-validates the host and route on every run", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, "../../../scripts/staging/schedule-cron.sql"), "utf8");
    assert.match(
      sql,
      /cron\.schedule\('clickai-staging-reconcile-sip-calls', '\*\/15 \* \* \* \*',\s*\$\$select public\.clickai_staging_call_cron\('reconcile-sip-calls'\)\$\$\)/,
    );
    const fn = sql.slice(
      sql.indexOf("create or replace function public.clickai_staging_call_cron"),
    );
    assert.match(fn, /language plpgsql/);
    assert.match(fn, /base !~ '\^https:\/\/clickai-staging\\\.\[a-z0-9-\]\+\\\.workers\\\.dev\$'/);
    assert.match(fn, /route not in \(/);
  });
});

describe("billing lease (compare-and-swap)", () => {
  test("a fresh 'pending' lease is never taken over; a stale one is taken by exactly one claimer", async () => {
    const clock = { ms: T0 };
    let gate: (() => void) | null = null;
    const s = sessionDeps({
      now: clockAt(clock),
      // the first biller hangs (crashes mid-billing): its lease stays "pending"
      finalizeBilling: async (call, seconds) => {
        if (!gate) await new Promise<void>((r) => (gate = r));
        s.billed.push({ id: call.id, seconds });
      },
    });
    await startSipSession(s.deps, {
      sipCallId: "SCL_L",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    void completeSipCallFromLiveKit(s.deps, { sipCallId: "SCL_L", seconds: 42 });
    await new Promise((r) => setImmediate(r));
    assert.equal((s.db.tables["call_logs"]![0]!["provider_metadata"] as Row)["billing"], "pending");
    clock.ms += 5 * 60_000;
    await completeSipCallFromLiveKit(s.deps, { sipCallId: "SCL_L", seconds: 42 });
    assert.equal(s.billed.length, 0, "fresh lease: its holder may still be billing");
    clock.ms += 11 * 60_000;
    gate = () => undefined; // later billers succeed immediately
    const runs = await Promise.all([
      reconcileStaleSipCalls(s.deps),
      reconcileStaleSipCalls(s.deps),
      reconcileStaleSipCalls(s.deps),
    ]);
    assert.equal(
      runs.reduce((n, r) => n + r.billingRetried, 0),
      1,
      "one claimer wins the stale lease",
    );
    assert.deepEqual(
      s.billed.map((b) => b.seconds),
      [42],
    );
    assert.equal((s.db.tables["call_logs"]![0]!["provider_metadata"] as Row)["billing"], "done");
  });
});

describe("F2: verify first; only real authentication failures count", () => {
  const NAT = "198.51.100.77"; // the agent pods' shared egress IP
  const startBody = (i: number) => ({
    sipCallId: `SCL_F2_${i}`,
    roomName: "r",
    calledNumber: `+9180001${String(i).padStart(5, "0")}`,
    callerNumber: null,
    direction: "inbound",
  });
  const start = async (h: HttpDeps, i: number, o: Parameters<typeof signed>[2] = {}) =>
    handleSessionStart(
      await signed("/api/internal/voice-agent/session", startBody(i), {
        nonce: `nonce-f2-${String(i).padStart(12, "0")}`,
        ip: NAT,
        ...o,
      }),
      h,
    );

  test("clock skew (stale timestamps) never consumes the budget shared by healthy agents behind one NAT", async () => {
    const { deps, db } = sessionDeps();
    const h = httpDeps(deps, db, undefined, realLimiter().limiter);
    // a pod with a clock 5 minutes behind keeps retrying
    for (let i = 0; i < 100; i++)
      assert.equal((await start(h, i, { now: 1_793_600_000 - 300 })).status, 401);
    // healthy pods on the same IP are served, and invalid requests still get 401, not 429
    assert.equal((await start(h, 200)).status, 200);
    const forged = await handleSessionStart(
      new Request("https://klyro.example/api/internal/voice-agent/session", {
        method: "POST",
        body: "{}",
        headers: { "cf-connecting-ip": NAT },
      }),
      h,
    );
    assert.equal(forged.status, 401, "the stale requests did not use up the budget");
  });

  test("a misconfigured pod (unknown key / wrong secret) exhausts the budget, but valid agents on the same NAT are never refused", async () => {
    const { deps, db } = sessionDeps();
    const h = httpDeps(deps, db, undefined, realLimiter().limiter);
    for (let i = 0; i < VOICE_AGENT_LIMITS.internal.limit; i++)
      assert.equal((await start(h, i, { secret: "w".repeat(32) })).status, 401);
    assert.equal(
      (await start(h, 100, { secret: "w".repeat(32) })).status,
      429,
      "still refused: no bypass",
    );
    assert.equal(
      (await start(h, 101, { keyId: "previous" })).status,
      429,
      "previous key not configured: refused",
    );
    for (let i = 300; i < 310; i++)
      assert.equal((await start(h, i)).status, 200, "valid signatures always pass");
  });

  test("key rotation: both current and previous keys are accepted while PREVIOUS is configured", async () => {
    const { deps, db } = sessionDeps();
    const base = httpDeps(deps, db, undefined, realLimiter().limiter);
    const OLD = "old-secret-0123456789abcdef0123";
    const h: HttpDeps = {
      ...base,
      env: (n) => (n === "VOICE_AGENT_HMAC_SECRET_PREVIOUS" ? OLD : base.env(n)),
    };
    assert.equal((await start(h, 1)).status, 200);
    assert.equal((await start(h, 2, { keyId: "previous", secret: OLD })).status, 200);
    assert.equal((await start(h, 3, { keyId: "previous", secret: "x".repeat(32) })).status, 401);
  });

  test("invalid signatures: no bypass; after the budget they get 429 and never reach a handler", async () => {
    const { deps, db } = sessionDeps();
    const h = httpDeps(deps, db, undefined, realLimiter().limiter);
    const statuses: number[] = [];
    for (let i = 0; i < VOICE_AGENT_LIMITS.internal.limit + 10; i++)
      statuses.push((await start(h, i, { secret: "z".repeat(32), ip: "192.0.2.50" })).status);
    assert.ok(statuses.every((st) => st === 401 || st === 429));
    assert.equal(statuses.filter((st) => st === 429).length, 10);
    assert.equal(db.tables["call_logs"]!.length, 0);
    assert.equal(db.tables["webhook_events"]!.length, 0, "no nonce was ever recorded");
  });

  test("webhooks: a signed event from a source that exhausted its budget is still processed; late (expired) signed events are not counted", async () => {
    const { deps, db } = sessionDeps();
    const h = httpDeps(deps, db, undefined, realLimiter().limiter);
    const LK = "203.0.113.200"; // LiveKit egress, possibly shared with other LiveKit customers
    const post = async (body: string, auth: string) =>
      handleLiveKitWebhook(
        new Request("https://klyro.example/api/public/webhooks/livekit", {
          method: "POST",
          body,
          headers: { authorization: auth, "cf-connecting-ip": LK },
        }),
        h,
      );
    // another LiveKit project (different key) points its webhooks at us
    const foreign = JSON.stringify({ event: "room_started", id: "EV_FOREIGN" });
    const foreignAuth = await liveKitAuth(foreign, {
      key: "other-project",
      secret: "other-secret",
    });
    for (let i = 0; i < VOICE_AGENT_LIMITS.webhook.limit; i++)
      assert.equal((await post(foreign, foreignAuth)).status, 401);
    assert.equal((await post(foreign, foreignAuth)).status, 429);
    // our own signed events from the same egress IP are still processed
    const ours = JSON.stringify({ event: "room_started", id: "EV_OURS", createdAt: "1793600001" });
    assert.equal((await post(ours, await liveKitAuth(ours))).status, 200);
    // an expired (late) but correctly signed event is rejected without being counted
    const { deps: d2, db: db2 } = sessionDeps();
    const h2 = httpDeps(d2, db2, undefined, realLimiter().limiter);
    const late = JSON.stringify({ event: "room_started", id: "EV_LATE" });
    const lateAuth = await liveKitAuth(late, { exp: 1_793_599_000 });
    for (let i = 0; i < VOICE_AGENT_LIMITS.webhook.limit + 5; i++) {
      const r = await handleLiveKitWebhook(
        new Request("https://klyro.example/api/public/webhooks/livekit", {
          method: "POST",
          body: late,
          headers: { authorization: lateAuth, "cf-connecting-ip": LK },
        }),
        h2,
      );
      assert.equal(r.status, 401, "never 429: time-only failures are not counted");
    }
  });
});

describe("F4: caps enforced atomically with the row insert", () => {
  test("10 concurrent requests (different keys) with the cap at 3: 3 rows, 3 dispatches, 7 limit_reached", async () => {
    const o = outboundDeps();
    const keys = Array.from(
      { length: 10 },
      (_, i) => `11111111-2222-4333-8444-${String(i).padStart(12, "0")}`,
    );
    const results = await Promise.all(
      keys.map((k) => startOutboundAgentCall(o.deps, { ...OUT, idempotencyKey: k })),
    );
    assert.equal(results.filter((r) => r.ok).length, 3);
    assert.equal(results.filter((r) => !r.ok && r.code === "limit_reached").length, 7);
    assert.equal(o.calls().length, 3);
    assert.equal(o.dispatched.length, 3);
  });
  test("an unclaimed row past its claim TTL no longer holds a slot; a rejected dispatch frees its slot at once", async () => {
    const o = outboundDeps();
    o.env["VOICE_AGENT_OUTBOUND_MAX_CONCURRENT"] = "1";
    await placeOutbound(o, "31111111-2222-4333-8444-555555555555");
    assert.equal(
      code(
        await startOutboundAgentCall(o.deps, {
          ...OUT,
          idempotencyKey: "41111111-2222-4333-8444-555555555555",
        }),
      ),
      "limit_reached",
    );
    o.clock.ms += (OUTBOUND_CLAIM_TTL_SECONDS + 1) * 1000;
    assert.equal(
      code(
        await startOutboundAgentCall(o.deps, {
          ...OUT,
          idempotencyKey: "51111111-2222-4333-8444-555555555555",
        }),
      ),
      "ok",
    );
    const r = outboundDeps({
      dispatch: async () => {
        throw new LiveKitApiError(400, "bad");
      },
    });
    r.env["VOICE_AGENT_OUTBOUND_MAX_CONCURRENT"] = "1";
    assert.equal(code(await startOutboundAgentCall(r.deps, OUT)), "dispatch_rejected");
    r.deps.dispatch = async (p) => void r.dispatched.push(p);
    assert.equal(
      code(
        await startOutboundAgentCall(r.deps, {
          ...OUT,
          idempotencyKey: "61111111-2222-4333-8444-555555555555",
        }),
      ),
      "ok",
      "the failed row released its slot",
    );
  });
});

describe("F6-F8: lease completion, ringing ownership, expiry UX", () => {
  test("F7: only the job that claimed a ringing call can report its dial failed; unclaimed rows stay closable", async () => {
    const o = outboundDeps();
    const id = await placeOutbound(o);
    await claimOutboundCall(o.deps.session, {
      callId: id,
      roomName: outboundRoomName(id),
      jobId: "AJ_OWNER",
    });
    for (const jobId of [undefined, "AJ_OTHER"]) {
      await endSipSession(o.deps.session, {
        callId: id,
        reason: "dial_failed:spoofed",
        ...(jobId ? { jobId } : {}),
      });
      assert.equal(o.calls()[0]!["status"], "ringing", `refused for ${jobId ?? "no job id"}`);
    }
    await endSipSession(o.deps.session, {
      callId: id,
      reason: "dial_failed:busy",
      jobId: "AJ_OWNER",
    });
    assert.deepEqual(
      [o.calls()[0]!["status"], o.calls()[0]!["failure_reason"]],
      ["failed", "dial_failed:busy"],
    );
    // an unclaimed (initiated) row cannot be dialling: closable without a job id
    const u = outboundDeps();
    const uid = await placeOutbound(u);
    await endSipSession(u.deps.session, { callId: uid, reason: "dial_failed:no_outbound_trunk" });
    assert.equal(u.calls()[0]!["status"], "failed");
    // HTTP: the end endpoint accepts and validates jobId
    const h = httpDeps(o.deps.session, o.db);
    const bad = await handleSessionEnd(
      await signed(
        "/api/internal/voice-agent/session-end",
        { callId: id, reason: "x", jobId: "" },
        { nonce: "nonce-end-aaaaaaaaaaaa" },
      ),
      h,
    );
    assert.equal(bad.status, 400);
  });
  test("F8: replaying a request after the claim window reports 'expired', and never dispatches again", async () => {
    let attempts = 0;
    const o = outboundDeps({
      dispatch: async () => {
        attempts++;
        throw new TypeError("fetch failed");
      },
    });
    await startOutboundAgentCall(o.deps, OUT);
    assert.equal(attempts, 2);
    o.clock.ms += OUTBOUND_CLAIM_TTL_SECONDS * 1000;
    const late = await startOutboundAgentCall(o.deps, OUT);
    assert.deepEqual(late.ok && [late.status, late.replayed], ["expired", true]);
    assert.equal(attempts, 2);
  });
  test("F6: a stale holder finishing late cannot overwrite the new lease holder's billing state", async () => {
    const clock = { ms: T0 };
    let release!: () => void;
    let calls = 0;
    const s = sessionDeps({
      now: clockAt(clock),
      finalizeBilling: async (call, seconds) => {
        calls++;
        if (calls === 1) await new Promise<void>((r) => (release = r)); // holder A stalls
        s.billed.push({ id: call.id, seconds });
      },
    });
    await startSipSession(s.deps, {
      sipCallId: "SCL_F6",
      roomName: "r",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    });
    const a = completeSipCallFromLiveKit(s.deps, { sipCallId: "SCL_F6", seconds: 42 });
    await new Promise((r) => setImmediate(r));
    clock.ms += 11 * 60_000; // A's lease is now stale
    assert.equal(
      (await reconcileStaleSipCalls(s.deps)).billingRetried,
      1,
      "B takes over and bills",
    );
    const leaseB = (s.db.tables["call_logs"]![0]!["provider_metadata"] as Row)["billing_lease"];
    release();
    await a;
    const m = s.db.tables["call_logs"]![0]!["provider_metadata"] as Row;
    assert.equal(m["billing"], "done");
    assert.equal(m["billing_lease"], leaseB, "A's late write did not clobber B's state");
    assert.deepEqual(
      s.billed.map((b) => b.seconds),
      [42, 42],
      "both used the stored duration; the debit is idempotent per call",
    );
  });
});

describe("M-A: inbound number normalization (Indian formats only)", () => {
  test("supported Indian forms all normalize to +91XXXXXXXXXX", () => {
    for (const [raw, want] of [
      ["+918000000001", "+918000000001"],
      ["918000000001", "+918000000001"],
      ["08000000001", "+918000000001"],
      ["8000000001", "+918000000001"],
      ["+91 98765 43210", "+919876543210"],
      ["098765-43210", "+919876543210"],
      ["(080) 4000 1234", "+918040001234"],
      ["sip:+919876543210@sip.vobiz.ai", "+919876543210"],
      ["tel:09876543210", "+919876543210"],
      ["9198765432", "+919198765432"], // 10 digits: a national mobile number that happens to start with 91
    ] as const)
      assert.equal(normalizeInboundNumber(raw), want, raw);
  });
  test("invalid, ambiguous and unsupported inputs are refused, never guessed", () => {
    for (const raw of [
      "",
      "   ",
      null,
      undefined,
      "anonymous",
      "Restricted",
      "+91123456789", // +91 with a subscriber number starting 1
      "+9198765432", // +91 with 8 digits
      "+919876543210123", // too long
      "91987654321", // 11 digits starting 91: 91 + 9 digits, or something else? ambiguous
      "0091987654321", // international 00 prefix: not a supported form
      "18001234567", // toll-free / service code
      "1800123456",
      "0123456789", // national form must start 2-9
      "12345",
      "98765abc10",
      "x".repeat(80),
    ])
      assert.equal(normalizeInboundNumber(raw as string | null | undefined), null, String(raw));
  });
  test("other countries: valid E.164 kept unchanged; bare foreign digit strings are not reinterpreted", () => {
    assert.equal(normalizeInboundNumber("+14155550100"), "+14155550100");
    assert.equal(normalizeInboundNumber("+44 20 7946 0958"), "+442079460958");
    assert.equal(
      normalizeInboundNumber("14155550100"),
      null,
      "11 digits not starting 0: not assumed to be anything",
    );
  });
  test("session start resolves the business number from any supported carrier format; caller ID is normalized", async () => {
    for (const [called, caller, wantCaller] of [
      ["+918000000001", "+919876543210", "+919876543210"],
      ["918000000001", "919876543210", "+919876543210"],
      ["08000000001", "09876543210", "+919876543210"],
      ["8000000001", "9876543210", "+919876543210"],
      ["8000000001", "anonymous", null],
      ["8000000001", "+14155550100", "+14155550100"],
    ] as const) {
      const { deps, db } = sessionDeps();
      const r = await startSipSession(deps, {
        sipCallId: `SCL_${called}_${caller}`,
        roomName: "r",
        calledNumber: called,
        callerNumber: caller,
        direction: "inbound",
      });
      assert.equal(r.allowed, true, `${called} / ${caller}`);
      assert.equal(r.allowed && r.callerNumber, wantCaller, "caller ID handed to the agent");
      const row = db.tables["call_logs"]![0]!;
      assert.deepEqual([row["destination_number"], row["caller_number"]], [PN_A.e164, wantCaller]);
    }
  });
  test("an unsupported called number is an unknown number: denied, nothing written", async () => {
    for (const called of ["91800000000", "1800000001", "+918000000002"]) {
      const { deps, db } = sessionDeps();
      const r = await startSipSession(deps, {
        sipCallId: `SCL_U_${called}`,
        roomName: "r",
        calledNumber: called,
        callerNumber: null,
        direction: "inbound",
      });
      assert.deepEqual(r, { allowed: false, reason: "unknown_number", callId: null }, called);
      assert.equal(db.tables["call_logs"]!.length, 0);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Phase 2.9 + 2.11: independent maximum-duration backstop            */
/* ------------------------------------------------------------------ */

type LkParticipant = { identity: string; sipCallId?: string; kind?: string | number };
/**
 * A stand-in for LiveKit's RoomService twirp API (shapes of
 * livekit/livekit pkg/service/roomservice.go): ListParticipants on a missing
 * room -> empty list; DeleteRoom on a missing room -> 404 not_found;
 * ListRooms -> rooms with creationTime (seconds, int64 as string).
 * `hook` runs before each request (to interleave webhooks or move a clock).
 */
function fakeLiveKit(rooms: Record<string, LkParticipant[]>, created: Record<string, number> = {}) {
  const calls: Array<{ method: string; room: string; auth: string }> = [];
  const state = {
    mode: "up" as "up" | "down" | "hang",
    fail: {} as Record<string, number>,
    hook: null as null | ((method: string, room: string) => Promise<void> | void),
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const room = (JSON.parse(String(init.body)) as { room?: string }).room ?? "";
    calls.push({
      method,
      room,
      auth: String((init.headers as Record<string, string>)["authorization"]),
    });
    await state.hook?.(method, room);
    if (state.mode === "hang")
      return new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    if (state.mode === "down") return new Response('{"code":"unavailable"}', { status: 503 });
    if ((state.fail[method] ?? 0) > 0) {
      state.fail[method]!--;
      return new Response('{"code":"unavailable"}', { status: 503 });
    }
    if (method === "ListRooms")
      return Response.json({
        rooms: Object.keys(rooms).map((name) => ({
          name,
          numParticipants: rooms[name]!.length,
          creationTime: String(Math.floor((created[name] ?? T0 - 60 * MIN) / 1000)),
        })),
      });
    const r = rooms[room];
    if (method === "ListParticipants")
      return Response.json({
        participants: (r ?? []).map((p) => ({
          identity: p.identity,
          kind:
            p.kind ??
            (p.sipCallId ? "SIP" : p.identity.startsWith("agent-") ? "AGENT" : "STANDARD"),
          attributes: p.sipCallId ? { "sip.callID": p.sipCallId } : {},
        })),
      });
    if (method === "DeleteRoom") {
      if (!r)
        return new Response('{"code":"not_found","msg":"requested room does not exist"}', {
          status: 404,
        });
      delete rooms[room];
      return Response.json({});
    }
    return new Response("{}", { status: 400 });
  }) as unknown as typeof fetch;
  return { calls, state, fetchImpl, rooms };
}

const MIN = 60_000;
let roomSeq = 0;
function inboundCall(over: Row & { metaOver?: Row } = {}): Row {
  const n = ++roomSeq;
  const { metaOver, ...rest } = over;
  return {
    ...CALL_DEFAULTS,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    organization_id: "org-a",
    business_id: "biz-a",
    phone_number_id: "pn-a",
    provider: "livekit_sip",
    provider_call_id: `SCL_${n}`,
    direction: "inbound",
    caller_number: "+919876543210",
    destination_number: "+918000000001",
    status: "answered",
    started_at: new Date(T0 - 40 * MIN).toISOString(),
    answered_at: new Date(T0 - 40 * MIN).toISOString(),
    provider_metadata: {
      livekit_room: `call-_+919876543210_r${n}`,
      transport: "sip",
      max_call_seconds: 1800,
      max_call_source: "agreed",
      ...metaOver,
    },
    ...rest,
  };
}
const roomOf = (r: Row) => (r["provider_metadata"] as Row)["livekit_room"] as string;
/** The agent is gone; only the caller's SIP participant is left (the stranded case). */
const strandedRooms = (rows: Row[]) =>
  Object.fromEntries(
    rows.map((r) => [
      roomOf(r),
      [{ identity: `sip_${String(r["caller_number"])}`, sipCallId: String(r["provider_call_id"]) }],
    ]),
  );

function sweepHarness(
  rows: Row[],
  rooms: Record<string, LkParticipant[]> = strandedRooms(rows),
  created: Record<string, number> = {},
) {
  const clock = { ms: T0 };
  const s = sessionDeps({ now: clockAt(clock) });
  s.db.tables["call_logs"]!.push(...rows);
  const lk = fakeLiveKit(rooms, created);
  const errors: Array<[string, unknown]> = [];
  const warns: Array<[string, unknown]> = [];
  const sweepDeps = (over: Partial<RoomSweepDeps> = {}): RoomSweepDeps => ({
    db: s.deps.db,
    now: clockAt(clock),
    maxCallSeconds: 1800,
    livekit: {
      url: "wss://lk.livekit.cloud",
      apiKey: "APIkey",
      apiSecret: "secret-secret-secret-secret",
      fetchImpl: lk.fetchImpl,
      timeoutMs: 30,
    },
    ...over,
  });
  const capture = async <T>(f: () => Promise<T>) => {
    const oe = console.error;
    const ow = console.warn;
    console.error = (tag: unknown, x?: unknown) => void errors.push([String(tag), x]);
    console.warn = (tag: unknown, x?: unknown) => void warns.push([String(tag), x]);
    try {
      return await f();
    } finally {
      console.error = oe;
      console.warn = ow;
    }
  };
  const sweep = (over: Partial<RoomSweepDeps> = {}) =>
    capture(() => sweepOverdueSipRooms(sweepDeps(over)));
  const row = (id: unknown) => s.db.tables["call_logs"]!.find((r) => r["id"] === id)!;
  const m = (id: unknown) => row(id)["provider_metadata"] as Row;
  const deletes = () => lk.calls.filter((c) => c.method === "DeleteRoom");
  /** LiveKit's participant_left: the caller has left the room. */
  const webhook = (r: Row, seconds: number) => {
    const room = lk.rooms[roomOf(r)];
    if (room) lk.rooms[roomOf(r)] = room.filter((p) => p.sipCallId !== r["provider_call_id"]);
    return capture(() =>
      completeSipCallFromLiveKit(s.deps, { sipCallId: String(r["provider_call_id"]), seconds }),
    );
  };
  const tags = (list: Array<[string, unknown]>) => list.map(([t]) => t);
  return { s, clock, lk, sweep, row, m, deletes, errors, warns, webhook, capture, tags };
}

describe("F2: the maximum duration agreed per call", () => {
  const start = (s: ReturnType<typeof sessionDeps>, sipCallId: string, agentMax?: number) =>
    startSipSession(s.deps, {
      sipCallId,
      roomName: `call-_x_${sipCallId}`,
      calledNumber: PN_A.e164,
      callerNumber: "+919876543210",
      direction: "inbound",
      ...(agentMax !== undefined ? { agentMaxCallSeconds: agentMax } : {}),
    });
  const rowOf = (s: ReturnType<typeof sessionDeps>, sip: string) =>
    s.db.tables["call_logs"]!.find((r) => r["provider_call_id"] === sip)!;

  test("recorded at session start as min(klyro, agent) and returned to the agent", async () => {
    const s = sessionDeps({ maxCallSeconds: 1800 });
    const r = await start(s, "SCL_a", 900);
    assert.equal(r.allowed && r.maxCallSeconds, 900);
    assert.equal((rowOf(s, "SCL_a")["provider_metadata"] as Row)["max_call_seconds"], 900);
    assert.equal((rowOf(s, "SCL_a")["provider_metadata"] as Row)["max_call_source"], "agreed");
    const r2 = await start(s, "SCL_b", 3600);
    assert.equal(r2.allowed && r2.maxCallSeconds, 1800);
  });
  test("an older agent (no limit sent) is recorded with the 7200 s ceiling, so the sweep never cuts it short", async () => {
    const s = sessionDeps({ maxCallSeconds: 1800 });
    await start(s, "SCL_old");
    const m = rowOf(s, "SCL_old")["provider_metadata"] as Row;
    assert.equal(m["max_call_seconds"], 7200);
    assert.equal(m["max_call_source"], "legacy_agent");
  });
  test("a configuration change after the start never shortens the running call (retried start returns the recorded limit)", async () => {
    const s = sessionDeps({ maxCallSeconds: 1800 });
    await start(s, "SCL_c", 1800);
    s.deps.maxCallSeconds = 600;
    const again = await start(s, "SCL_c", 1800);
    assert.equal(again.allowed && again.maxCallSeconds, 1800);
    assert.equal((rowOf(s, "SCL_c")["provider_metadata"] as Row)["max_call_seconds"], 1800);
  });
  test("klyro's own limit: VOICE_AGENT_MAX_CALL_SECONDS parsing", () => {
    assert.equal(maxCallSecondsFromEnv(undefined), 1800);
    assert.equal(maxCallSecondsFromEnv("900"), 900);
    for (const bad of ["", "abc", "59", "7201", "900.5", "-1"])
      assert.equal(maxCallSecondsFromEnv(bad), 1800, bad);
  });
  test("HTTP: the agent's limit is validated (60..7200)", async () => {
    const s = sessionDeps();
    const db = s.db;
    const h = httpDeps(s.deps, db);
    const send = async (body: Row) =>
      handleSessionStart(await signed("/api/internal/voice-agent/session", body), h);
    const base = {
      sipCallId: "SCL_http",
      roomName: "call-_x_http",
      calledNumber: PN_A.e164,
      callerNumber: null,
      direction: "inbound",
    };
    assert.equal((await send({ ...base, maxCallSeconds: 30 })).status, 400);
    const ok = await send({ ...base, maxCallSeconds: 1200 });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as Row)["maxCallSeconds"], 1200);
  });
  test("sweep uses the per-call limit: 3600 s call at 40 min and a pre-2.11 row without a limit are left alone; a 1800 s call at 36 min is swept", async () => {
    const long = inboundCall({ metaOver: { max_call_seconds: 3600 } });
    const old = inboundCall({
      metaOver: { max_call_seconds: undefined, max_call_source: undefined },
    });
    const due = inboundCall({
      answered_at: new Date(T0 - 36 * MIN).toISOString(),
      started_at: new Date(T0 - 36 * MIN).toISOString(),
    });
    const h = sweepHarness([long, old, due]);
    const r = await h.sweep({ maxCallSeconds: 600 }); // klyro's current default plays no role
    assert.equal(r.roomsDeleted, 1);
    assert.deepEqual(
      h.deletes().map((c) => c.room),
      [roomOf(due)],
    );
    assert.equal(h.row(long["id"])["status"], "answered");
    assert.equal(h.row(old["id"])["status"], "answered");
  });
});

describe("F1: end reports are bound to the call; a connected agent blocks deletion", () => {
  const report = (s: ReturnType<typeof sessionDeps>, call: Row, over: Partial<Row> = {}) =>
    endSipSession(s.deps, { callId: String(call["id"]), reason: "goodbye", ...over } as never);

  test("a report naming another room or SIP call is refused and records nothing", async () => {
    const call = inboundCall({ answered_at: new Date(T0 - 5 * MIN).toISOString() });
    const h = sweepHarness([call]);
    const before = structuredClone(h.row(call["id"]));
    const r1 = await h.capture(() => report(h.s, call, { roomName: "call-_someone_else" }));
    const r2 = await h.capture(() => report(h.s, call, { sipCallId: "SCL_other" }));
    assert.deepEqual(
      [r1, r2],
      [
        { ok: false, reason: "binding_mismatch" },
        { ok: false, reason: "binding_mismatch" },
      ],
    );
    assert.deepEqual(h.row(call["id"]), before);
    assert.ok(h.tags(h.warns).includes("voice_agent:end_report_binding_mismatch"));
  });
  test("HTTP: a mismatching report answers 409", async () => {
    const call = inboundCall();
    const s = sessionDeps();
    s.db.tables["call_logs"]!.push(call);
    const body = { callId: call["id"], reason: "x", roomName: "call-_wrong" };
    const res = await handleSessionEnd(
      await signed("/api/internal/voice-agent/session-end", body),
      httpDeps(s.deps, s.db),
    );
    assert.equal(res.status, 409);
  });
  test("a matching report is recorded; an older agent's unbound report is recorded and marked unbound", async () => {
    const bound = inboundCall();
    const legacy = inboundCall();
    const h = sweepHarness([bound, legacy]);
    await h.capture(() =>
      report(h.s, bound, { roomName: roomOf(bound), sipCallId: bound["provider_call_id"] }),
    );
    await h.capture(() => report(h.s, legacy));
    assert.equal(h.m(bound["id"])["agent_ended_at"], new Date(T0).toISOString());
    assert.equal(h.m(bound["id"])["agent_end_unbound"], undefined);
    assert.equal(h.m(legacy["id"])["agent_end_unbound"], true);
    assert.ok(h.tags(h.warns).includes("voice_agent:end_report_unbound"));
  });
  test("premature end report while the agent and caller are still talking: nothing is deleted or closed; after the agent leaves the room is swept", async () => {
    const call = inboundCall({
      answered_at: new Date(T0 - 8 * MIN).toISOString(),
      started_at: new Date(T0 - 8 * MIN).toISOString(),
      metaOver: { agent_ended_at: new Date(T0 - 6 * MIN).toISOString() },
    });
    const rooms = {
      [roomOf(call)]: [
        { identity: "sip_caller", sipCallId: String(call["provider_call_id"]) },
        { identity: "agent-AJ_1" },
      ],
    };
    const h = sweepHarness([call], rooms);
    const r = await h.sweep();
    assert.equal(r.waitingForAgent, 1);
    assert.equal(h.deletes().length, 0);
    assert.equal(h.row(call["id"])["status"], "answered");
    assert.equal(h.m(call["id"])["room_sweep"], "waiting");
    // The agent leaves (its cleanup failed): the next check after the wait sweeps it.
    h.lk.rooms[roomOf(call)] = [
      { identity: "sip_caller", sipCallId: String(call["provider_call_id"]) },
    ];
    h.clock.ms += 5 * MIN + 1;
    const r2 = await h.sweep();
    assert.equal(r2.roomsDeleted, 1);
    assert.equal(h.row(call["id"])["status"], "completed");
    assert.equal(h.row(call["id"])["duration_seconds"], 120);
    assert.equal(h.row(call["id"])["ended_at"], new Date(T0 - 6 * MIN).toISOString());
  });
  test("an agent identified only by kind AGENT (or numeric 4) also blocks deletion", async () => {
    const a = inboundCall();
    const b = inboundCall();
    const rooms = {
      [roomOf(a)]: [
        { identity: "sip_1", sipCallId: String(a["provider_call_id"]) },
        { identity: "worker-x", kind: "AGENT" },
      ],
      [roomOf(b)]: [
        { identity: "sip_2", sipCallId: String(b["provider_call_id"]) },
        { identity: "worker-y", kind: 4 as never },
      ],
    };
    const h = sweepHarness([a, b], rooms);
    const r = await h.sweep();
    assert.equal(r.waitingForAgent, 2);
    assert.equal(h.deletes().length, 0);
  });
  test("an agent still connected long after the call's limit: never deleted, one 'agent_stuck' alert", async () => {
    const call = inboundCall({
      answered_at: new Date(T0 - 70 * MIN).toISOString(),
      started_at: new Date(T0 - 70 * MIN).toISOString(),
    });
    const rooms = {
      [roomOf(call)]: [
        { identity: "sip_caller", sipCallId: String(call["provider_call_id"]) },
        { identity: "agent-AJ_9" },
      ],
    };
    const h = sweepHarness([call], rooms);
    await h.sweep();
    h.clock.ms += 6 * MIN;
    await h.sweep();
    assert.equal(h.deletes().length, 0);
    assert.equal(h.row(call["id"])["status"], "answered");
    assert.equal(
      h.tags(h.errors).filter((t) => t === "voice_agent:room_sweep_agent_stuck").length,
      1,
    );
  });
});

describe("F7: verify first, close last; webhook races in every order", () => {
  test("a call within its limit is never touched", async () => {
    const live = inboundCall({
      answered_at: new Date(T0 - 34 * MIN).toISOString(),
      started_at: new Date(T0 - 34 * MIN).toISOString(),
    });
    const before = structuredClone(live);
    const h = sweepHarness([live]);
    const r = await h.sweep();
    assert.equal(r.examined, 0);
    assert.equal(
      r.orphanRoomsSkipped,
      1,
      "seen by the orphan check, which leaves active calls alone",
    );
    assert.equal(h.deletes().length, 0);
    assert.deepEqual(h.row(live["id"]), before);
  });
  test("agent crashed: verified, decision recorded, room deleted, THEN the row closed unbilled; the deletion's webhook bills nothing", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    const r = await h.sweep();
    assert.equal(r.closedNoAgentReport, 1);
    assert.equal(r.roomsDeleted, 1);
    assert.equal(h.row(call["id"])["status"], "failed");
    assert.equal(h.row(call["id"])["failure_reason"], "max_duration_exceeded");
    assert.equal(h.m(call["id"])["room_sweep"], "done");
    assert.deepEqual(
      h.lk.calls.filter((c) => c.room === roomOf(call)).map((c) => c.method),
      ["ListParticipants", "DeleteRoom"],
    );
    await h.webhook(call, 2400);
    await reconcileStaleSipCalls(h.s.deps);
    assert.deepEqual(h.s.billed, []);
  });
  test("invalid room name, mismatched room, unexpected participants: the row stays ACTIVE and nothing is deleted", async () => {
    const noRoom = inboundCall({ metaOver: { livekit_room: undefined } });
    const foreign = inboundCall({ metaOver: { livekit_room: "out-1" } });
    const other = inboundCall();
    const odd = inboundCall();
    const rooms = {
      [roomOf(other)]: [{ identity: "sip_x", sipCallId: "SCL_SOMEONE_ELSE" }],
      [roomOf(odd)]: [
        { identity: "sip_y", sipCallId: String(odd["provider_call_id"]) },
        { identity: "egress-1", kind: "EGRESS" },
      ],
    };
    const h = sweepHarness([noRoom, foreign, other, odd], rooms);
    const r = await h.sweep();
    assert.equal(r.invalidRoom, 2);
    assert.equal(r.mismatched, 2);
    assert.equal(h.deletes().length, 0);
    for (const x of [noRoom, foreign, other, odd]) {
      assert.equal(h.row(x["id"])["status"], "answered");
      assert.equal(h.row(x["id"])["ended_at"], null);
    }
    assert.ok(h.tags(h.errors).includes("voice_agent:room_sweep_mismatch"));
    assert.ok(h.tags(h.errors).includes("voice_agent:room_sweep_invalid_room"));
  });
  test("room deletion fails: the row is NOT marked ended (the room may still be up); decision kept; retried and closed after success", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    h.lk.state.fail["DeleteRoom"] = 1;
    await h.sweep();
    assert.equal(h.row(call["id"])["status"], "answered");
    assert.equal(h.row(call["id"])["ended_at"], null);
    assert.equal(h.m(call["id"])["room_sweep"], "retry");
    assert.deepEqual(h.m(call["id"])["room_sweep_close"], {
      status: "failed",
      reason: "max_duration_exceeded",
    });
    h.clock.ms += 5 * MIN;
    const r = await h.sweep();
    assert.equal(r.roomsDeleted, 1);
    assert.equal(h.row(call["id"])["status"], "failed");
    assert.equal(h.m(call["id"])["room_sweep"], "done");
  });
  test("order 1: LiveKit's webhook completes the call BEFORE the sweep: no deletion, billed from LiveKit", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    await h.webhook(call, 2000);
    const r = await h.sweep();
    assert.equal(h.deletes().length, 0);
    assert.equal(r.examined, 0);
    assert.deepEqual(h.s.billed, [{ id: call["id"], seconds: 2000 }]);
  });
  test("order 2: webhook between the claim and the decision: the decision write loses, the room is NOT deleted", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    h.lk.state.hook = async (method) => {
      if (method === "ListParticipants") await h.webhook(call, 2000);
    };
    const r = await h.sweep();
    // The caller has left, so the room is seen empty: nothing to delete.
    assert.equal(r.roomsGone, 1);
    assert.equal(h.deletes().length, 0);
    assert.equal(h.row(call["id"])["status"], "completed");
    assert.deepEqual(h.s.billed, [{ id: call["id"], seconds: 2000 }]);
  });
  test("order 2b: the call completes between the verification and the decision: the decision write loses ('superseded'), no deletion by the row sweep", async () => {
    const call = inboundCall();
    const h = sweepHarness([call], strandedRooms([call]), { [roomOf(call)]: T0 + 25 * MIN }); // too young for the orphan check
    // LiveKit completes the call while the listing still shows the caller.
    h.lk.state.hook = async (method) => {
      if (method === "ListParticipants" && h.row(call["id"])["status"] === "answered")
        await completeSipCallFromLiveKit(h.s.deps, {
          sipCallId: String(call["provider_call_id"]),
          seconds: 2000,
        });
    };
    const r = await h.sweep();
    assert.equal(r.superseded, 1);
    assert.equal(h.deletes().length, 0);
    assert.equal(h.m(call["id"])["room_sweep"], "superseded");
    assert.deepEqual(h.s.billed, [{ id: call["id"], seconds: 2000 }]);
  });
  test("order 3: webhook between the decision and the deletion (A): the webhook applies the decision, unbilled; one close", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    h.lk.state.hook = async (method) => {
      if (method === "DeleteRoom") await h.webhook(call, 2400);
    };
    const r = await h.sweep();
    assert.equal(r.roomsDeleted, 1);
    assert.equal(h.row(call["id"])["status"], "failed");
    assert.equal(h.row(call["id"])["failure_reason"], "max_duration_exceeded");
    assert.equal(h.m(call["id"])["room_sweep"], "done");
    assert.deepEqual(h.s.billed, []);
  });
  test("order 3 (B): webhook between the decision and the deletion bills ONCE with the agent-reported duration, never LiveKit's", async () => {
    const call = inboundCall({
      answered_at: new Date(T0 - 14 * MIN).toISOString(),
      started_at: new Date(T0 - 14 * MIN).toISOString(),
      metaOver: { agent_ended_at: new Date(T0 - 10 * MIN).toISOString() },
    });
    const h = sweepHarness([call]);
    h.lk.state.hook = async (method) => {
      if (method === "DeleteRoom") await h.webhook(call, 840);
    };
    await h.sweep();
    h.clock.ms += 15 * MIN;
    await reconcileStaleSipCalls(h.s.deps);
    assert.deepEqual(h.s.billed, [{ id: call["id"], seconds: 240 }]);
    assert.equal(h.row(call["id"])["status"], "completed");
    assert.equal(h.m(call["id"])["billing"], "done");
  });
  test("order 4: webhook after the deletion and the close: nothing more happens", async () => {
    const call = inboundCall({
      answered_at: new Date(T0 - 14 * MIN).toISOString(),
      started_at: new Date(T0 - 14 * MIN).toISOString(),
      metaOver: { agent_ended_at: new Date(T0 - 10 * MIN).toISOString() },
    });
    const h = sweepHarness([call]);
    await h.sweep();
    assert.equal(h.row(call["id"])["status"], "completed");
    assert.equal(h.m(call["id"])["billing"], "retry");
    await h.webhook(call, 840);
    h.clock.ms += 15 * MIN;
    await reconcileStaleSipCalls(h.s.deps);
    assert.deepEqual(h.s.billed, [{ id: call["id"], seconds: 240 }]);
  });
  test("closed rows without LiveKit's confirmation: room swept, billing untouched", async () => {
    const fromReport = inboundCall({
      status: "completed",
      ended_at: new Date(T0 - 20 * MIN).toISOString(),
      duration_seconds: 300,
      metaOver: {
        billing: "done",
        billing_source: "agent_report",
        billing_lease: new Date(T0 - 20 * MIN).toISOString(),
      },
    });
    const endMissing = inboundCall({
      status: "failed",
      failure_reason: "livekit_end_event_missing",
      answered_at: new Date(T0 - 200 * MIN).toISOString(),
      started_at: new Date(T0 - 200 * MIN).toISOString(),
      ended_at: new Date(T0 - 15 * MIN).toISOString(),
    });
    const h = sweepHarness([fromReport, endMissing]);
    const r = await h.sweep();
    assert.equal(r.roomsDeleted, 2);
    assert.equal(h.m(fromReport["id"])["billing"], "done");
    assert.equal(h.row(fromReport["id"])["duration_seconds"], 300);
    assert.deepEqual(h.s.billed, []);
  });
  test("already-ended and out-of-scope calls are never touched", async () => {
    const byWebhook = inboundCall({
      status: "completed",
      ended_at: new Date(T0 - 20 * MIN).toISOString(),
      metaOver: { billing: "done", billing_source: "livekit_webhook" },
    });
    const outbound = inboundCall({ direction: "outbound" });
    const old = inboundCall({
      answered_at: new Date(T0 - 26 * 3_600_000).toISOString(),
      started_at: new Date(T0 - 26 * 3_600_000).toISOString(),
    });
    const before = structuredClone([byWebhook, outbound, old]);
    const h = sweepHarness([byWebhook, outbound, old], {});
    const r = await h.sweep();
    assert.equal(r.examined, 0);
    assert.deepEqual(
      [byWebhook, outbound, old].map((x) => h.row(x["id"])),
      before,
    );
  });
  test("concurrent sweeps and duplicate cron runs: one claim, one deletion; the repeat run does nothing", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    const [a, b] = await Promise.all([h.sweep(), h.sweep()]);
    assert.equal(a.roomsDeleted + b.roomsDeleted, 1);
    assert.equal(a.lostRace + b.lostRace, 1);
    const n = h.deletes().length;
    const again = await h.sweep();
    assert.equal(again.examined, 0);
    assert.equal(h.deletes().length, n);
    assert.equal(n, 1);
  });
});

describe("F3: database errors are errors, not 'nothing to do'", () => {
  test("a failing selection throws DbError (the route answers 500); nothing is touched", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    h.s.db.faults.fn = (_t, op) =>
      op === "select" ? { message: "canceling statement due to statement timeout" } : null;
    await assert.rejects(
      h.sweep(),
      (e) => e instanceof DbError && /statement timeout/.test(e.message),
    );
    assert.equal(h.row(call["id"])["status"], "answered");
    assert.equal(h.deletes().length, 0);
  });
  test("a failing write is counted and logged as a database error (not a lost race); the run fails (500) but other rows proceed", async () => {
    const a = inboundCall();
    const b = inboundCall();
    const h = sweepHarness([a, b]);
    let n = 0;
    h.s.db.faults.fn = (_t, op) =>
      op === "update" && n++ === 0 ? { message: "permission denied" } : null;
    const r = await h.sweep();
    assert.equal(r.dbErrors, 1);
    assert.equal(r.lostRace, 0);
    assert.equal(r.roomsDeleted, 1);
    assert.equal(sweepFailed(r), true);
    assert.ok(h.tags(h.errors).includes("voice_agent:room_sweep_db_error"));
  });
});

describe("F5/F8: budgets, cancellation, retries and a single alert", () => {
  test("bounded work per run: at most 5 rows; the rest deferred", async () => {
    const rows = Array.from({ length: ROOM_SWEEP_MAX_ROWS_PER_RUN + 2 }, () => inboundCall());
    const h = sweepHarness(rows);
    const r = await h.sweep();
    assert.equal(r.examined, ROOM_SWEEP_MAX_ROWS_PER_RUN);
    assert.equal(r.deferred, 2);
    assert.ok(r.subrequests <= 45, `subrequests ${r.subrequests}`);
    assert.equal((await h.sweep()).roomsDeleted, 2);
  });
  test("subrequest and time budgets stop claiming new rows", async () => {
    const rows = Array.from({ length: 4 }, () => inboundCall());
    const h = sweepHarness(rows);
    const small = await h.sweep({ budget: { subrequests: 16 } });
    assert.equal(small.budgetExhausted, true);
    assert.ok(small.examined < 4 && small.subrequests <= 16, JSON.stringify(small));
    const h2 = sweepHarness(
      rows.map((r) => inboundCall({ metaOver: { livekit_room: roomOf(r) } })),
    );
    h2.lk.state.hook = () => void (h2.clock.ms += 7000); // each LiveKit request takes 7 s
    const slow = await h2.sweep({ budget: { runMs: 18_000 } });
    assert.equal(slow.budgetExhausted, true);
    assert.ok(slow.examined <= 2, JSON.stringify(slow));
  });
  test("lease records the claim time, not the run start", async () => {
    const a = inboundCall();
    const b = inboundCall();
    const h = sweepHarness([a, b]);
    h.lk.state.fail["DeleteRoom"] = 2;
    h.lk.state.hook = () => void (h.clock.ms += 1000);
    await h.sweep();
    assert.notEqual(h.m(a["id"])["room_sweep_lease"], h.m(b["id"])["room_sweep_lease"]);
  });
  test("a run cancelled after the claim: the abandoned lease counts as a failed attempt; failures never skip or double-count", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    // Simulate cancellation: every write after the claim fails.
    let writes = 0;
    h.s.db.faults.fn = (_t, op) =>
      op === "update" && writes++ > 0 ? { message: "aborted" } : null;
    await h.sweep();
    assert.equal(h.m(call["id"])["room_sweep"], "pending");
    assert.equal(h.m(call["id"])["room_sweep_failures"], 0);
    h.s.db.faults.fn = null;
    h.lk.state.mode = "down";
    h.clock.ms += 1 * MIN;
    assert.equal((await h.sweep()).examined, 0, "a fresh lease is never taken over");
    h.clock.ms += 2 * MIN;
    await h.sweep();
    // abandoned (+1), then this attempt failed (+1)
    assert.equal(h.m(call["id"])["room_sweep_failures"], 2);
  });
  test("prolonged LiveKit outage: exponential backoff capped at 1 h, ONE alert, retries continue and succeed after recovery", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    h.lk.state.mode = "down";
    const nextGaps: number[] = [];
    for (let i = 0; i < 9; i++) {
      await h.sweep();
      const next = Date.parse(String(h.m(call["id"])["room_sweep_next_at"]));
      nextGaps.push(next - h.clock.ms);
      h.clock.ms = next + 1;
    }
    assert.deepEqual(
      nextGaps.map((g) => g / MIN),
      [5, 10, 20, 40, 60, 60, 60, 60, 60],
    );
    assert.equal(ROOM_SWEEP_BACKOFF_MAX_MS, 60 * MIN);
    assert.equal(h.m(call["id"])["room_sweep_failures"], 9);
    assert.equal(
      h.tags(h.errors).filter((t) => t === "voice_agent:room_sweep_failed").length,
      1,
      `alert after ${ROOM_SWEEP_ALERT_AFTER_FAILURES} failures, once`,
    );
    assert.equal(h.row(call["id"])["status"], "answered", "never closed while the room may be up");
    h.lk.state.mode = "up";
    await h.sweep();
    assert.equal(h.m(call["id"])["room_sweep"], "done");
    assert.equal(h.row(call["id"])["status"], "failed");
  });
  test("LiveKit never answers: the request is aborted and retried later", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    h.lk.state.mode = "hang";
    const r = await h.sweep();
    assert.equal(r.retryScheduled, 1);
    assert.match(
      String(h.m(call["id"])["room_sweep_error"]),
      /^0: livekit ListParticipants timed out/,
    );
  });
  test("a row still unresolved near the end of the 24 h window is marked expired with an alert", async () => {
    const call = inboundCall({
      answered_at: new Date(T0 - 23.5 * 3_600_000).toISOString(),
      started_at: new Date(T0 - 23.5 * 3_600_000).toISOString(),
      metaOver: {
        room_sweep: "retry",
        room_sweep_kind: "A",
        room_sweep_failures: 20,
        room_sweep_alerted: true,
        room_sweep_next_at: new Date(T0 - MIN).toISOString(),
      },
    });
    const h = sweepHarness([call]);
    const r = await h.sweep();
    assert.equal(r.expired, 1);
    assert.equal(h.m(call["id"])["room_sweep"], "expired");
    assert.ok(h.tags(h.errors).includes("voice_agent:room_sweep_expired"));
  });
  test("without LiveKit credentials nothing is claimed (route 503)", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    const r = await h.sweep({ livekit: null });
    assert.equal(r.unconfigured, true);
    assert.equal(h.row(call["id"])["status"], "answered");
  });
});

describe("F6: writers never overwrite each other's metadata", () => {
  test("billing finishing during the sweep cannot undo the sweep's recorded outcome; billed once", async () => {
    const call = inboundCall({
      answered_at: new Date(T0 - 14 * MIN).toISOString(),
      started_at: new Date(T0 - 14 * MIN).toISOString(),
      metaOver: { agent_ended_at: new Date(T0 - 10 * MIN).toISOString() },
    });
    const h = sweepHarness([call]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.s.deps.finalizeBilling = async (c, seconds) => {
      await gate;
      h.s.billed.push({ id: c.id, seconds });
    };
    let hook: Promise<unknown> = Promise.resolve();
    h.lk.state.hook = (method) => {
      if (method === "DeleteRoom") hook = h.webhook(call, 840);
    };
    await h.sweep();
    release();
    await hook;
    h.clock.ms += 15 * MIN;
    await reconcileStaleSipCalls(h.s.deps);
    assert.equal(h.m(call["id"])["room_sweep"], "done");
    assert.equal(h.m(call["id"])["billing"], "done");
    assert.deepEqual(h.s.billed, [{ id: call["id"], seconds: 240 }]);
  });
  test("an end report merged after the sweep claimed the row keeps the sweep's keys", async () => {
    const call = inboundCall({
      answered_at: new Date(T0 - 8 * MIN).toISOString(),
      metaOver: { room_sweep: "waiting", room_sweep_kind: "A", room_sweep_lease: "L1" },
    });
    const h = sweepHarness([call]);
    await h.capture(() =>
      endSipSession(h.s.deps, {
        callId: String(call["id"]),
        reason: "bye",
        roomName: roomOf(call),
        sipCallId: String(call["provider_call_id"]),
      }),
    );
    assert.equal(h.m(call["id"])["room_sweep"], "waiting");
    assert.equal(h.m(call["id"])["room_sweep_lease"], "L1");
    assert.equal(typeof h.m(call["id"])["agent_ended_at"], "string");
  });
});

describe("F4: orphan rooms (no active answered row)", () => {
  const sip = (id: string) => [{ identity: `sip_${id}`, sipCallId: id }];
  test("unknown number (no row) and a refused call (row never answered): deleted once 10 min old and agent-less", async () => {
    const refused = inboundCall({
      status: "failed",
      failure_reason: "billing_blocked",
      answered_at: null,
      ended_at: new Date(T0 - 20 * MIN).toISOString(),
    });
    const rooms = {
      "call-_+919999999999_unknown": sip("SCL_unknown"),
      [roomOf(refused)]: sip(String(refused["provider_call_id"])),
    };
    const h = sweepHarness([refused], rooms, {
      "call-_+919999999999_unknown": T0 - 15 * MIN,
      [roomOf(refused)]: T0 - 20 * MIN,
    });
    const r = await h.sweep();
    assert.equal(r.orphanRoomsDeleted, 2);
    assert.equal(Object.keys(h.lk.rooms).length, 0);
    assert.equal(h.row(refused["id"])["status"], "failed", "the row is not changed");
    assert.ok(h.tags(h.warns).includes("voice_agent:orphan_room_swept"));
  });
  test("never deleted: rooms with an agent, young rooms, rooms of active calls, non-call rooms, rooms with non-SIP participants, rooms another row names", async () => {
    const active = inboundCall({
      answered_at: new Date(T0 - 12 * MIN).toISOString(),
      started_at: new Date(T0 - 12 * MIN).toISOString(),
      metaOver: { max_call_seconds: 3600 }, // still within its limit for the whole test
    });
    const elsewhere = inboundCall({
      status: "failed",
      failure_reason: "billing_blocked",
      answered_at: null,
      ended_at: new Date(T0 - 20 * MIN).toISOString(),
      metaOver: { livekit_room: "call-_x_original" },
    });
    const old = T0 - 30 * MIN;
    const rooms: Record<string, LkParticipant[]> = {
      "call-_a_agent": [...sip("SCL_o1"), { identity: "agent-AJ_2" }],
      "call-_b_young": sip("SCL_o2"),
      [roomOf(active)]: sip(String(active["provider_call_id"])),
      "support-room": sip("SCL_o3"),
      "call-_c_egress": [...sip("SCL_o4"), { identity: "egress", kind: "EGRESS" }],
      "call-_d_other": sip(String(elsewhere["provider_call_id"])),
    };
    const h = sweepHarness([active, elsewhere], rooms, {
      "call-_a_agent": old,
      "call-_b_young": T0 + 25 * MIN, // < 10 min old at every run below
      [roomOf(active)]: old,
      "support-room": old,
      "call-_c_egress": old,
      "call-_d_other": old,
    });
    for (let i = 0; i < 6; i++) {
      await h.sweep();
      h.clock.ms += 5 * MIN; // rotation: every eligible room is examined
    }
    for (const room of ["call-_a_agent", "call-_c_egress", "call-_d_other"])
      assert.ok(
        h.lk.calls.some((c) => c.method === "ListParticipants" && c.room === room),
        `examined ${room}`,
      );
    assert.equal(h.deletes().length, 0);
    assert.ok(
      !h.lk.calls.some((c) => c.method === "ListParticipants" && c.room === "support-room"),
    );
    assert.ok(h.tags(h.errors).includes("voice_agent:orphan_room_mismatch"));
  });
  test("ListRooms is called with a roomList-only token", async () => {
    const h = sweepHarness([], {});
    await h.sweep();
    const list = h.lk.calls.find((c) => c.method === "ListRooms")!;
    const claims = JSON.parse(
      Buffer.from(list.auth.slice("Bearer ".length).split(".")[1]!, "base64url").toString(),
    ) as { video: Row };
    assert.deepEqual(claims.video, { roomList: true });
  });
});

describe("F13: LiveKit URL validation and least-privilege tokens", () => {
  const KEY = "APIkey";
  const SECRET_LK = "lk-secret-0123456789abcdefghijklmnop";
  const claimsOf = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as {
      video: Record<string, unknown>;
      exp: number;
      nbf: number;
    };

  test("accepted: *.livekit.cloud over TLS, LIVEKIT_ALLOWED_HOSTS (exact), loopback for local development", () => {
    assert.equal(livekitApiBase("wss://proj.livekit.cloud"), "https://proj.livekit.cloud");
    assert.equal(livekitApiBase("https://proj.livekit.cloud:443/"), "https://proj.livekit.cloud");
    assert.equal(livekitApiBase("ws://localhost:7880"), "http://localhost:7880");
    assert.equal(livekitApiBase("ws://127.0.0.1:7880"), "http://127.0.0.1:7880");
    const allowed = allowedLiveKitHosts(" lk.internal.example ,bad host,, ");
    assert.deepEqual(allowed, ["lk.internal.example"]);
    assert.equal(
      livekitApiBase("wss://lk.internal.example", allowed),
      "https://lk.internal.example",
    );
  });

  const REJECTED = [
    "ws://proj.livekit.cloud", // plaintext to a remote host
    "http://proj.livekit.cloud",
    "ftp://proj.livekit.cloud",
    "wss://evil.example",
    "wss://livekit.cloud", // apex is not a project host
    "wss://proj.livekit.cloud.evil.example",
    "wss://evillivekit.cloud",
    "wss://user:pw@proj.livekit.cloud",
    "wss://proj.livekit.cloud/twirp",
    "wss://proj.livekit.cloud/?x=1",
    "wss://proj.livekit.cloud/#f",
    "ws://lk.internal.example", // allowed host, but plaintext
    "not a url",
  ];
  test("rejected: insecure schemes, foreign or look-alike hosts, credentials, paths, queries", () => {
    for (const url of REJECTED)
      assert.throws(
        () => livekitApiBase(url, ["lk.internal.example"]),
        (e) => e instanceof LiveKitConfigError,
        url,
      );
  });

  test("no request and no token ever leave for a rejected URL (all four API calls); errors never carry the secret", async () => {
    for (const url of REJECTED) {
      let sent = 0;
      const fetchImpl = (async () => {
        sent++;
        return new Response("{}");
      }) as unknown as typeof fetch;
      const p = {
        url,
        apiKey: KEY,
        apiSecret: SECRET_LK,
        fetchImpl,
        allowedHosts: ["lk.internal.example"],
      };
      for (const call of [
        () => listRoomParticipants({ ...p, room: "call-_a" }),
        () => deleteLiveKitRoom({ ...p, room: "call-_a" }),
        () => listLiveKitRooms(p),
        () => createAgentDispatch({ ...p, room: "out-x", agentName: "a", metadata: "{}" }),
      ])
        await assert.rejects(
          call(),
          (e) => e instanceof LiveKitConfigError && !String(e.message).includes(SECRET_LK),
          url,
        );
      assert.equal(sent, 0, url);
    }
  });

  test("a refused URL is a definite (rejected) dispatch failure: nothing was sent", () => {
    assert.equal(classifyDispatchError(new LiveKitConfigError("x")), "rejected");
    assert.equal(classifyDispatchError(new LiveKitApiError(0, "timeout")), "unknown");
  });

  test("grants: delete = { roomCreate } only (what LiveKit requires; nothing narrower exists), 30 s; list rooms = { roomList }, 30 s; participants = roomAdmin for ONE room", async () => {
    const del = claimsOf(
      await roomDeleteToken({ apiKey: KEY, apiSecret: SECRET_LK, room: "call-_a" }),
    );
    assert.deepEqual(del.video, { roomCreate: true });
    assert.ok(del.exp - del.nbf <= 35);
    const list = claimsOf(await roomListToken({ apiKey: KEY, apiSecret: SECRET_LK }));
    assert.deepEqual(list.video, { roomList: true });
    assert.ok(list.exp - list.nbf <= 35);
    const admin = claimsOf(
      await roomAdminToken({ apiKey: KEY, apiSecret: SECRET_LK, room: "call-_a" }),
    );
    assert.deepEqual(admin.video, { roomAdmin: true, room: "call-_a" });
  });

  test("the room sweep refuses an insecure LiveKit URL: nothing claimed, nothing sent, route 503", async () => {
    const call = inboundCall();
    const h = sweepHarness([call]);
    for (const url of ["ws://proj.livekit.cloud", "wss://evil.example"]) {
      const r = await h.sweep({
        livekit: { url, apiKey: KEY, apiSecret: SECRET_LK, fetchImpl: h.lk.fetchImpl },
      });
      assert.equal(r.unconfigured, true, url);
    }
    assert.equal(h.lk.calls.length, 0);
    assert.equal(h.row(call["id"])["status"], "answered");
    assert.ok(
      h.errors.some(
        ([t, x]) =>
          t === "voice_agent:room_sweep_unconfigured" &&
          (x as Row)["reason"] === "livekit_url_rejected" &&
          !JSON.stringify(x).includes(SECRET_LK),
      ),
    );
  });
});

describe("F14: voice cron routes: route-specific credential, replay protection, limits, no leaks", () => {
  const VOICE = "voice-cron-secret-0123456789abcdefghijklmnop";
  const OLD = "voice-cron-old-secret-0123456789abcdefghijkl";
  const LOVABLE = "lovable-cron-secret-0123456789abcdefghijklmn";
  const NOW = 1_793_600_000;
  function harness(env: Record<string, string | undefined> = { VOICE_AGENT_CRON_SECRET: VOICE }) {
    const claimed = new Set<string>();
    const claims: string[] = [];
    const fails = createFailureCounter(VOICE_AGENT_LIMITS.cron.limit, 60, {
      now: () => NOW * 1000,
    });
    const runs = new Map<string, number>();
    const logs: string[] = [];
    let legacyCalls = 0;
    const deps: CronAuthDeps = {
      env: (n) => env[n],
      nowSeconds: () => NOW,
      claimOnce: async (provider, id) => {
        claims.push(`${provider}:${id}`);
        if (claimed.has(id)) return false;
        claimed.add(id);
        return true;
      },
      limiter: {
        authFailureBudget: (_s, ip) => fails.peek(sourceKey(ip)),
        recordAuthFailure: (_s, ip) => fails.record(sourceKey(ip)),
        shared: async (scope, key) => {
          const n = (runs.get(`${scope}:${key}`) ?? 0) + 1;
          runs.set(`${scope}:${key}`, n);
          return n <= VOICE_AGENT_LIMITS.cron_run.limit
            ? { allowed: true, retryAfterSeconds: 0 }
            : { allowed: false, retryAfterSeconds: 60 };
        },
      },
      legacyAuth: async (req) => {
        legacyCalls++;
        return req.headers.get("authorization") === `Bearer ${LOVABLE}`
          ? null
          : new Response("Unauthorized", { status: 401 });
      },
    };
    const call = async (
      route: VoiceCronRoute,
      headers: Record<string, string>,
      ip = "198.51.100.7",
    ) => {
      const ow = console.warn;
      const oe = console.error;
      console.warn = (...a: unknown[]) => void logs.push(JSON.stringify(a));
      console.error = (...a: unknown[]) => void logs.push(JSON.stringify(a));
      try {
        return await authenticateVoiceCron(
          new Request(`https://klyro.example/api/public/cron/${route}`, {
            method: "POST",
            headers: { "cf-connecting-ip": ip, ...headers },
          }),
          route,
          deps,
        );
      } finally {
        console.warn = ow;
        console.error = oe;
      }
    };
    const signed = async (route: VoiceCronRoute, ts = NOW, secret = VOICE) => ({
      "x-voice-cron-timestamp": String(ts),
      "x-voice-cron-signature": await signCronRequest(secret, route, ts),
    });
    return { call, signed, claims, logs, legacy: () => legacyCalls };
  }
  const status = (r: Awaited<ReturnType<ReturnType<typeof harness>["call"]>>) =>
    r.ok ? 200 : r.response.status;

  test("signed request: accepted once; the same signature again (replay) is refused", async () => {
    const h = harness();
    const hdr = await h.signed("sweep-sip-rooms");
    const first = await h.call("sweep-sip-rooms", hdr);
    assert.deepEqual(first, { ok: true, mode: "signed" });
    assert.equal(status(await h.call("sweep-sip-rooms", hdr)), 401);
    assert.deepEqual(h.claims.filter((c) => c.startsWith(CRON_REPLAY_PROVIDER)).length, 2);
  });
  test("a signature for one route is refused on the other (route-specific)", async () => {
    const h = harness();
    assert.equal(
      status(await h.call("sweep-sip-rooms", await h.signed("reconcile-sip-calls"))),
      401,
    );
  });
  test("stale and future timestamps (outside ±300 s), malformed and incomplete signatures are refused", async () => {
    const h = harness();
    for (const ts of [NOW - 301, NOW + 301])
      assert.equal(
        status(await h.call("sweep-sip-rooms", await h.signed("sweep-sip-rooms", ts))),
        401,
      );
    assert.equal(
      status(await h.call("sweep-sip-rooms", { "x-voice-cron-timestamp": String(NOW) })),
      401,
    );
    assert.equal(
      status(
        await h.call("sweep-sip-rooms", {
          "x-voice-cron-timestamp": String(NOW),
          "x-voice-cron-signature": "zz",
        }),
      ),
      401,
    );
    assert.equal(status(await h.call("sweep-sip-rooms", {})), 401, "missing credentials");
    assert.equal(h.claims.length, 0, "only valid signatures are ever stored");
  });
  test("route-scoped bearer: valid for its route only; the shared LOVABLE_CRON_SECRET no longer opens voice routes", async () => {
    const h = harness();
    const sweepToken = await cronBearerToken(VOICE, "sweep-sip-rooms");
    assert.deepEqual(await h.call("sweep-sip-rooms", { authorization: `Bearer ${sweepToken}` }), {
      ok: true,
      mode: "bearer",
    });
    assert.equal(
      status(await h.call("reconcile-sip-calls", { authorization: `Bearer ${sweepToken}` })),
      401,
    );
    assert.equal(
      status(await h.call("sweep-sip-rooms", { authorization: `Bearer ${LOVABLE}` })),
      401,
    );
    assert.equal(
      status(await h.call("sweep-sip-rooms", { authorization: `Bearer ${VOICE}` })),
      401,
      "raw secret is not a token",
    );
    assert.equal(h.legacy(), 0);
  });
  test("VOICE_AGENT_CRON_REQUIRE_SIGNED=true refuses bearer tokens", async () => {
    const h = harness({ VOICE_AGENT_CRON_SECRET: VOICE, VOICE_AGENT_CRON_REQUIRE_SIGNED: "true" });
    const t = await cronBearerToken(VOICE, "sweep-sip-rooms");
    assert.equal(status(await h.call("sweep-sip-rooms", { authorization: `Bearer ${t}` })), 401);
    assert.equal(status(await h.call("sweep-sip-rooms", await h.signed("sweep-sip-rooms"))), 200);
  });
  test("rotation: the previous secret is still accepted", async () => {
    const h = harness({ VOICE_AGENT_CRON_SECRET: VOICE, VOICE_AGENT_CRON_SECRET_PREVIOUS: OLD });
    assert.equal(
      status(await h.call("sweep-sip-rooms", await h.signed("sweep-sip-rooms", NOW, OLD))),
      200,
    );
  });
  test("without VOICE_AGENT_CRON_SECRET: the previous shared-secret check still applies (not weakened), with a warning", async () => {
    const h = harness({});
    assert.deepEqual(await h.call("sweep-sip-rooms", { authorization: `Bearer ${LOVABLE}` }), {
      ok: true,
      mode: "legacy",
    });
    assert.equal(status(await h.call("sweep-sip-rooms", { authorization: "Bearer nope" })), 401);
    assert.ok(h.logs.some((l) => l.includes("voice_agent:cron_legacy_auth")));
  });
  test("a too-short secret fails closed (500) without echoing it", async () => {
    const h = harness({ VOICE_AGENT_CRON_SECRET: "short" });
    const r = await h.call("sweep-sip-rooms", await h.signed("sweep-sip-rooms", NOW, "short"));
    assert.equal(status(r), 500);
    assert.ok(!r.ok && !(await r.response.text()).includes("short"));
  });
  test("failed-auth budget per client: 10 counted failures, then 429; clock-skew failures are not counted", async () => {
    const h = harness();
    for (let i = 0; i < 12; i++)
      await h.call("sweep-sip-rooms", await h.signed("sweep-sip-rooms", NOW - 400), "203.0.113.9");
    assert.equal(
      status(await h.call("sweep-sip-rooms", { authorization: "Bearer x" }, "203.0.113.9")),
      401,
    );
    for (let i = 0; i < 9; i++)
      await h.call("sweep-sip-rooms", { authorization: "Bearer x" }, "203.0.113.9");
    assert.equal(
      status(await h.call("sweep-sip-rooms", { authorization: "Bearer x" }, "203.0.113.9")),
      429,
    );
    // another client is unaffected
    assert.equal(
      status(await h.call("sweep-sip-rooms", await h.signed("sweep-sip-rooms"), "192.0.2.1")),
      200,
    );
  });
  test("authenticated runs are limited per route (6/min): a leaked credential cannot hammer LiveKit or the database", async () => {
    const h = harness();
    const t = await cronBearerToken(VOICE, "sweep-sip-rooms");
    const codes: number[] = [];
    for (let i = 0; i < 8; i++)
      codes.push(status(await h.call("sweep-sip-rooms", { authorization: `Bearer ${t}` })));
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429, 429]);
  });
  test("nothing secret leaks into responses or logs", async () => {
    const h = harness();
    const hdr = await h.signed("sweep-sip-rooms");
    const token = await cronBearerToken(VOICE, "reconcile-sip-calls");
    const bodies: string[] = [];
    for (const headers of [
      hdr,
      hdr, // replay
      { authorization: `Bearer ${token}` }, // wrong route
      { authorization: `Bearer ${LOVABLE}` },
      {
        "x-voice-cron-timestamp": String(NOW - 999),
        "x-voice-cron-signature": hdr["x-voice-cron-signature"],
      },
    ]) {
      const r = await h.call("sweep-sip-rooms", headers);
      if (!r.ok) bodies.push(await r.response.text());
    }
    const all = [...bodies, ...h.logs].join("\n");
    for (const secret of [VOICE, LOVABLE, token, hdr["x-voice-cron-signature"]])
      assert.ok(!all.includes(secret), "leaked a credential");
    assert.ok(bodies.every((b) => b === '{"error":"unauthorized"}'));
  });
  test("replay records of cron runs are pruned after 24 h with the agent request nonces", async () => {
    const s = sessionDeps();
    const old = new Date(Date.parse("2026-11-02T04:30:00Z") - 25 * 3_600_000).toISOString();
    s.db.tables["webhook_events"]!.push(
      { provider: CRON_REPLAY_PROVIDER, event_id: "a", created_at: old },
      { provider: "voice_agent_request", event_id: "b", created_at: old },
      { provider: "livekit", event_id: "c", created_at: old },
    );
    await pruneVoiceAgentNonces(s.deps, { olderThanHours: 24 });
    assert.deepEqual(
      s.db.tables["webhook_events"]!.map((r) => r["provider"]),
      ["livekit"],
    );
  });
});
