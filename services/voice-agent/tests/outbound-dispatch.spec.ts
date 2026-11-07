import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RoomServiceClient, TokenVerifier } from "livekit-server-sdk";
// klyro's side (Worker code, Web Crypto only), checked against LiveKit's own SDK.
import {
  LiveKitApiError,
  createAgentDispatch,
  deleteLiveKitRoom,
  listLiveKitRooms,
  listRoomParticipants,
  livekitHttpUrl,
  roomAdminToken,
} from "../../../src/lib/voice-agent/livekit-api.ts";
import {
  dialOutbound,
  effectiveMaxCallSeconds,
  parseOutboundDispatch,
  type DialOptions,
} from "../src/agent/call.ts";
import { claimOutbound, type OutboundClaim } from "../src/backend/klyro-backend.ts";
import { KlyroClient, KlyroError } from "../src/backend/klyro-client.ts";
import { loadConfig } from "../src/runtime/config.ts";
import { CallTelemetry } from "../src/runtime/telemetry.ts";

const KEY = "APIdevkey";
const SECRET = "dev-secret-0123456789abcdefghijklmnop";
const CALL = "11111111-1111-4111-8111-111111111111";

describe("klyro -> LiveKit agent dispatch", () => {
  test("klyro's room-admin token is accepted by livekit-server-sdk's TokenVerifier, scoped to one room", async () => {
    const token = await roomAdminToken({ apiKey: KEY, apiSecret: SECRET, room: `out-${CALL}` });
    const claims = await new TokenVerifier(KEY, SECRET).verify(token);
    assert.equal(claims.video?.roomAdmin, true);
    assert.equal(claims.video?.room, `out-${CALL}`);
    await assert.rejects(
      new TokenVerifier(KEY, "another-secret-0123456789abcdefghij").verify(token),
    );
    await assert.rejects(new TokenVerifier("otherkey", SECRET).verify(token));
  });
  test("an expired token is rejected by LiveKit's verifier", async () => {
    const token = await roomAdminToken({
      apiKey: KEY,
      apiSecret: SECRET,
      room: "r",
      nowSeconds: Math.floor(Date.now() / 1000) - 3600,
    });
    await assert.rejects(new TokenVerifier(KEY, SECRET).verify(token));
  });
  test("CreateDispatch request: twirp path, bearer token, body {room, agentName, metadata}", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ id: "AD_123" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await createAgentDispatch({
      url: "wss://dev.livekit.cloud/",
      apiKey: KEY,
      apiSecret: SECRET,
      room: "out-x",
      agentName: "clickai-receptionist",
      metadata: '{"outboundCallLogId":"x"}',
      fetchImpl,
    });
    assert.deepEqual(r, { dispatchId: "AD_123" });
    assert.equal(
      seen[0]!.url,
      "https://dev.livekit.cloud/twirp/livekit.AgentDispatchService/CreateDispatch",
    );
    const headers = seen[0]!.init.headers as Record<string, string>;
    assert.match(headers["authorization"]!, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), {
      room: "out-x",
      agentName: "clickai-receptionist",
      metadata: '{"outboundCallLogId":"x"}',
    });
    const claims = await new TokenVerifier(KEY, SECRET).verify(
      headers["authorization"]!.slice("Bearer ".length),
    );
    assert.equal(claims.video?.room, "out-x");
  });
  test("non-2xx is an error carrying the status, never the credentials", async () => {
    const fetchImpl = (async () =>
      new Response('{"code":"unauthenticated","msg":"invalid token"}', {
        status: 401,
      })) as unknown as typeof fetch;
    await assert.rejects(
      createAgentDispatch({
        url: "wss://x.livekit.cloud",
        apiKey: KEY,
        apiSecret: SECRET,
        room: "r",
        agentName: "a",
        metadata: "{}",
        fetchImpl,
      }),
      (e) => e instanceof LiveKitApiError && e.status === 401 && !e.message.includes(SECRET),
    );
    assert.equal(livekitHttpUrl("ws://localhost:7880"), "http://localhost:7880");
  });
});

describe("agent: claim, then dial (H1/M3/M6)", () => {
  test("metadata carries only the row id; destination, caller ID and trunk in metadata are ignored", () => {
    assert.deepEqual(
      parseOutboundDispatch(
        JSON.stringify({
          outboundCallLogId: CALL,
          toNumber: "+911800000000",
          fromNumber: "+910000000000",
          outboundTrunkId: "ST_attacker",
        }),
      ),
      { outboundCallLogId: CALL },
    );
    for (const bad of ["{not json", "", "[]", "null", JSON.stringify({ outboundCallLogId: "x" })])
      assert.equal(parseOutboundDispatch(bad), null, bad);
  });

  function harness(
    over: { claim?: () => Promise<OutboundClaim>; dial?: () => Promise<unknown> } = {},
  ) {
    const posts: Array<{ url: string; body: unknown }> = [];
    const client = new KlyroClient({
      baseUrl: "https://k",
      secret: "s".repeat(32),
      retries: 0,
      fetchImpl: (async (url: string, init: RequestInit) => {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const dials: Array<[string, string, string, DialOptions]> = [];
    const claims: unknown[] = [];
    let roomDeleted = 0;
    const run = (opts: { noTrunk?: boolean } = {}) =>
      dialOutbound({
        dispatch: { outboundCallLogId: CALL },
        jobId: "AJ_1",
        trunkId: opts.noTrunk ? undefined : "ST_configured",
        roomName: `out-${CALL}`,
        maxCallSeconds: 1800,
        claim:
          over.claim ??
          (async (q) => {
            claims.push(q);
            return {
              ok: true,
              callId: CALL,
              toNumber: "+919876543210",
              fromNumber: "+918000000001",
            };
          }),
        dial: over.dial ?? (async (...a) => void dials.push(a)),
        deleteRoom: async () => void roomDeleted++,
        client,
        telemetry: new CallTelemetry({ callId: CALL, sipCallId: null, room: "r" }, () => undefined),
      });
    return { run, posts, dials, claims, roomDeleted: () => roomDeleted };
  }

  test("claims first (job id + room), then dials klyro's destination with klyro's caller ID via the CONFIGURED trunk", async () => {
    const h = harness();
    assert.deepEqual(await h.run(), {
      ok: true,
      toNumber: "+919876543210",
      fromNumber: "+918000000001",
    });
    assert.deepEqual(h.claims, [{ callId: CALL, roomName: `out-${CALL}`, jobId: "AJ_1" }]);
    const [trunk, to, room, opts] = h.dials[0]!;
    assert.deepEqual([trunk, to, room], ["ST_configured", "+919876543210", `out-${CALL}`]);
    assert.equal(opts.fromNumber, "+918000000001");
    assert.equal(opts.participantAttributes["clickai.callLogId"], CALL);
    assert.equal(h.posts.length + h.roomDeleted(), 0, "nothing reported, room kept");
  });
  test("claim refused (duplicate dispatch, expired, ended) or klyro unreachable: never dials, never touches the room", async () => {
    for (const err of [
      new KlyroError(409, "already_claimed", false),
      new KlyroError(0, "network", true),
    ]) {
      const h = harness({
        claim: async () => {
          throw err;
        },
      });
      const r = await h.run();
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.owned, false);
      assert.equal(h.dials.length, 0);
      assert.equal(h.roomDeleted(), 0, "the room may belong to the job that owns the call");
      assert.equal(h.posts.length, 0);
    }
  });
  test("a claim answer with invalid numbers is treated as a refusal", async () => {
    const h = harness({
      claim: async () => ({ ok: true, callId: CALL, toNumber: "123", fromNumber: "+918000000001" }),
    });
    assert.equal((await h.run()).ok, false);
    assert.equal(h.dials.length, 0);
  });
  test("failed dial: klyro is told (row closed, never billed) and the room is deleted (no stray SIP leg)", async () => {
    const h = harness({
      dial: async () => {
        throw Object.assign(new Error("486"), { code: "unavailable" });
      },
    });
    assert.deepEqual(await h.run(), { ok: false, reason: "dial_failed:unavailable", owned: true });
    assert.equal(h.posts[0]!.url, "https://k/api/internal/voice-agent/session-end");
    assert.deepEqual(h.posts[0]!.body, {
      callId: CALL,
      reason: "dial_failed:unavailable",
      jobId: "AJ_1",
    });
    assert.equal(h.roomDeleted(), 1);
  });
  test("no outbound trunk configured: never dials, reports the failure, deletes the room", async () => {
    const h = harness();
    assert.deepEqual(await h.run({ noTrunk: true }), {
      ok: false,
      reason: "dial_failed:no_outbound_trunk",
      owned: true,
    });
    assert.equal(h.dials.length, 0);
    assert.equal(h.posts.length, 1);
    assert.equal(h.roomDeleted(), 1);
  });
  test("claimOutbound posts to the signed claim endpoint and is retry-safe (idempotent)", async () => {
    const seen: string[] = [];
    let n = 0;
    const client = new KlyroClient({
      baseUrl: "https://k",
      secret: "s".repeat(32),
      retries: 2,
      fetchImpl: (async (url: string) => {
        seen.push(url);
        if (n++ === 0) return new Response("{}", { status: 503 });
        return new Response(
          JSON.stringify({
            ok: true,
            callId: CALL,
            toNumber: "+919876543210",
            fromNumber: "+918000000001",
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const r = await claimOutbound(client, { callId: CALL, roomName: `out-${CALL}`, jobId: "AJ_1" });
    assert.equal(r.toNumber, "+919876543210");
    assert.deepEqual(seen, [
      "https://k/api/internal/voice-agent/outbound-claim",
      "https://k/api/internal/voice-agent/outbound-claim",
    ]);
  });
  test("SIP_OUTBOUND_TRUNK_ID is optional configuration", () => {
    const base = {
      LIVEKIT_URL: "wss://example.livekit.cloud",
      LIVEKIT_API_KEY: "key",
      LIVEKIT_API_SECRET: "secret-secret-secret",
      SARVAM_API_KEY: "sk",
      KLYRO_BASE_URL: "https://klyro.example",
      VOICE_AGENT_HMAC_SECRET: "x".repeat(40),
      ANTHROPIC_API_KEY: "ak",
    };
    assert.equal(loadConfig(base).SIP_OUTBOUND_TRUNK_ID, undefined);
    assert.equal(
      loadConfig({ ...base, SIP_OUTBOUND_TRUNK_ID: "ST_abc" }).SIP_OUTBOUND_TRUNK_ID,
      "ST_abc",
    );
  });
});

describe("klyro room sweep requests match livekit-server-sdk's RoomServiceClient", () => {
  /** Captures what the official SDK sends (it uses the global fetch). */
  async function sdkRequest(run: (c: RoomServiceClient) => Promise<unknown>) {
    const seen: Array<{ url: string; body: unknown; auth: string }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: headers.get("authorization") ?? "",
      });
      return new Response(JSON.stringify({ participants: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await run(new RoomServiceClient("https://dev.livekit.cloud", KEY, SECRET));
    } finally {
      globalThis.fetch = orig;
    }
    return seen[0]!;
  }
  function ours() {
    const seen: Array<{ url: string; body: unknown; auth: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: (init.headers as Record<string, string>)["authorization"]!,
      });
      return new Response(JSON.stringify({ participants: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }
  const grants = async (auth: string) =>
    (await new TokenVerifier(KEY, SECRET).verify(auth.slice("Bearer ".length))).video;

  test("ListParticipants: same path and body; our token is valid and has the grants the SDK sends", async () => {
    const sdk = await sdkRequest((c) => c.listParticipants("call-_+91x_abc"));
    const o = ours();
    await listRoomParticipants({
      url: "wss://dev.livekit.cloud",
      apiKey: KEY,
      apiSecret: SECRET,
      room: "call-_+91x_abc",
      fetchImpl: o.fetchImpl,
    });
    assert.equal(o.seen[0]!.url, sdk.url);
    assert.deepEqual(o.seen[0]!.body, sdk.body);
    const [mine, theirs] = [await grants(o.seen[0]!.auth), await grants(sdk.auth)];
    assert.equal(mine?.roomAdmin, theirs?.roomAdmin);
    assert.equal(mine?.room, theirs?.room);
  });
  test("DeleteRoom: same path and body; our token carries roomCreate like the SDK's", async () => {
    const sdk = await sdkRequest((c) => c.deleteRoom("call-_+91x_abc"));
    const o = ours();
    assert.equal(
      await deleteLiveKitRoom({
        url: "wss://dev.livekit.cloud",
        apiKey: KEY,
        apiSecret: SECRET,
        room: "call-_+91x_abc",
        fetchImpl: o.fetchImpl,
      }),
      "deleted",
    );
    assert.equal(o.seen[0]!.url, sdk.url);
    assert.deepEqual(o.seen[0]!.body, sdk.body);
    assert.equal((await grants(sdk.auth))?.roomCreate, true);
    assert.equal((await grants(o.seen[0]!.auth))?.roomCreate, true);
  });
  test("ListRooms: same path and body as the SDK; our token carries roomList like the SDK's", async () => {
    const sdk = await sdkRequest((c) => c.listRooms());
    const o = ours();
    await listLiveKitRooms({
      url: "wss://dev.livekit.cloud",
      apiKey: KEY,
      apiSecret: SECRET,
      fetchImpl: o.fetchImpl,
    });
    assert.equal(o.seen[0]!.url, sdk.url);
    assert.deepEqual(o.seen[0]!.body, sdk.body);
    assert.equal((await grants(sdk.auth))?.roomList, true);
    assert.equal((await grants(o.seen[0]!.auth))?.roomList, true);
  });
  test("404 (twirp not_found) means the room is gone; 5xx and no answer are errors", async () => {
    const mk = (status: number) =>
      (async () => new Response('{"code":"x"}', { status })) as unknown as typeof fetch;
    const p = { url: "wss://x.livekit.cloud", apiKey: KEY, apiSecret: SECRET, room: "call-_a_b" };
    assert.equal(await deleteLiveKitRoom({ ...p, fetchImpl: mk(404) }), "not_found");
    assert.equal(await listRoomParticipants({ ...p, fetchImpl: mk(404) }), "not_found");
    await assert.rejects(
      deleteLiveKitRoom({ ...p, fetchImpl: mk(503) }),
      (e) => e instanceof LiveKitApiError && e.status === 503 && !e.message.includes(SECRET),
    );
    await assert.rejects(
      listRoomParticipants({
        ...p,
        timeoutMs: 20,
        fetchImpl: ((_u: string, init: RequestInit) =>
          new Promise((_, rej) =>
            init.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
          )) as unknown as typeof fetch,
      }),
      (e) => e instanceof LiveKitApiError && e.status === 0 && /timed out/.test(e.message),
    );
  });
});

describe("the agent never runs a call longer than klyro allows", () => {
  test("effective limit = min(agent MAX_CALL_SECONDS, klyro's); an invalid or missing klyro value is ignored", () => {
    assert.equal(effectiveMaxCallSeconds(1800, 900), 900);
    assert.equal(effectiveMaxCallSeconds(1800, 3600), 1800);
    assert.equal(effectiveMaxCallSeconds(1800, null), 1800);
    for (const bad of [0, 59, 12.5, Number.NaN])
      assert.equal(effectiveMaxCallSeconds(1800, bad), 1800);
  });
});
