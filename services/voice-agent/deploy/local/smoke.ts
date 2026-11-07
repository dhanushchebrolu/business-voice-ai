/**
 * Live smoke test for the LOCAL self-hosted stack (deploy/docker-compose.dev.yml).
 *
 *   cd services/voice-agent && npm run local:smoke               # infrastructure checks
 *   cd services/voice-agent && npm run local:smoke -- --sip-call # + a local SIP call
 *
 * Reads deploy/local/.env (or LOCAL_ENV_FILE). Starts a FAKE klyro on
 * 0.0.0.0:8790 that verifies, with klyro's own code (src/lib/voice-agent/),
 * the LiveKit webhook signatures and the agent's HMAC-signed requests, and
 * refuses every call (allowed: false), so no booking/billing path runs and
 * the agent never starts a conversation: no Sarvam STT/TTS/LLM request is
 * made by this test. Nothing here touches Vobiz, Supabase or Cloudflare.
 *
 * --sip-call creates a per-run test trunk + dispatch rule
 * ("clickai-local-smoke-<runId>-…", never a production name) and sends a SIP
 * INVITE from this host to 127.0.0.1:5060. Before creating anything it
 * requires evidence that the server is local (deploy/local/smoke-lib.ts:
 * loopback URL, init-env.sh key id, a webhook for this run's room received
 * here, no production SIP object on the server); cleanup deletes only the
 * ids this run created. That proves SIP -> room -> agent dispatch -> signed
 * klyro request locally. It is NOT a Vobiz call: real PSTN calls need a
 * public endpoint (LOCAL_LIVEKIT.md, "Real Vobiz calls").
 *
 * Prints no secret. Exit code 0 = all checks passed.
 */
import { createServer, type IncomingMessage } from "node:http";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccessToken, AgentDispatchClient, RoomServiceClient, SipClient } from "livekit-server-sdk";
import {
  assertLocalTarget,
  assertWebhookProof,
  missingWebhookEvents,
  newRunId,
  preflight,
  selectRunRoom,
  smokeNames,
  SmokeSipRun,
} from "./smoke-lib.ts";

const here = dirname(fileURLToPath(import.meta.url));

/*
 * klyro's own verifiers (src/lib/voice-agent/), loaded at run time. They are
 * type-checked by the app's TypeScript (5.7+ Uint8Array generics), not by
 * this package's older compiler, so the specifier is computed.
 */
interface KlyroVerifiers {
  verifyLiveKitWebhook(p: {
    apiKey: string;
    apiSecret: string;
    authorization: string | null;
    body: string;
  }): Promise<
    { ok: true; event: { event: string; room?: { name?: string } } } | { ok: false; reason: string }
  >;
  verifySignedRequest(p: {
    secrets: { current: string };
    method: string;
    path: string;
    body: string;
    header: (name: string) => string | null;
    claimNonce: (keyId: string, nonce: string, ts: number) => Promise<boolean>;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
}
const klyroLib = join(here, "../../../../src/lib/voice-agent");
const { verifyLiveKitWebhook } = (await import(join(klyroLib, "livekit-webhook.ts"))) as Pick<
  KlyroVerifiers,
  "verifyLiveKitWebhook"
>;
const { verifySignedRequest } = (await import(join(klyroLib, "internal-auth.ts"))) as Pick<
  KlyroVerifiers,
  "verifySignedRequest"
>;
const SIP_CALL = process.argv.includes("--sip-call");
const HTTP = "http://127.0.0.1:7880";
const WS = "ws://127.0.0.1:7880";
const AGENT_HEALTH = "http://127.0.0.1:8081";
const FAKE_KLYRO_PORT = Number(process.env["SMOKE_KLYRO_PORT"] ?? 8790);
/** Per-run names, room prefix and fictitious test number for --sip-call. */
const RUN = smokeNames(newRunId());
const TEST_NUMBER = RUN.number;
const CALLER_NUMBER = "+919000000001";
/** Source of SIP packets as the SIP container sees them (Docker's bridge gateways). */
const SIP_SOURCE_CIDR = process.env["SMOKE_SIP_SOURCE_CIDR"] ?? "172.16.0.0/12";

/* ---------------- env ---------------- */
function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}
const envFile = process.env["LOCAL_ENV_FILE"] ?? join(here, ".env");
const env = loadEnv(envFile);
const KEY = env["LIVEKIT_API_KEY"] ?? "";
const SECRET = env["LIVEKIT_API_SECRET"] ?? "";
const HMAC = env["VOICE_AGENT_HMAC_SECRET"] ?? "";
const AGENT = env["AGENT_NAME"] || "clickai-receptionist";
if (!KEY || !SECRET || !HMAC) {
  console.error(
    `missing LIVEKIT_API_KEY / LIVEKIT_API_SECRET / VOICE_AGENT_HMAC_SECRET in ${envFile}`,
  );
  process.exit(2);
}
try {
  assertLocalTarget({ url: HTTP, apiKey: KEY });
} catch (e) {
  console.error(`refusing to run: ${(e as Error).message}`);
  process.exit(2);
}

/* ---------------- reporting ---------------- */
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
function report(check: string, ok: boolean, detail = "") {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check}${detail ? `  (${detail})` : ""}`);
}
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    report(name, true, (await fn()) ?? "");
  } catch (e) {
    report(name, false, (e as Error).message);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/* ---------------- fake klyro ---------------- */
const webhooks: Array<{ event: string; ok: boolean; reason?: string; room?: string }> = [];
const internal: Array<{
  path: string;
  ok: boolean;
  reason?: string;
  body: Record<string, unknown>;
}> = [];
const nonces = new Set<string>();
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
const fakeKlyro = createServer(async (req, res) => {
  const body = await readBody(req);
  const path = req.url ?? "";
  if (path === "/api/public/webhooks/livekit") {
    const v = await verifyLiveKitWebhook({
      apiKey: KEY,
      apiSecret: SECRET,
      authorization: req.headers["authorization"] ?? null,
      body,
    });
    webhooks.push(
      v.ok
        ? { event: v.event.event, ok: true, room: v.event.room?.name }
        : { event: "?", ok: false, reason: v.reason },
    );
    res.writeHead(v.ok ? 200 : 401).end();
    return;
  }
  if (path.startsWith("/api/internal/voice-agent/")) {
    const v = await verifySignedRequest({
      secrets: { current: HMAC },
      method: req.method ?? "POST",
      path,
      body,
      header: (n) => (req.headers[n.toLowerCase()] as string | undefined) ?? null,
      claimNonce: async (k, n) =>
        nonces.has(`${k}:${n}`) ? false : (nonces.add(`${k}:${n}`), true),
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* recorded as empty */
    }
    internal.push({ path, ok: v.ok, ...(v.ok ? {} : { reason: v.reason }), body: parsed });
    if (!v.ok)
      return void res
        .writeHead(401, { "content-type": "application/json" })
        .end('{"error":"unauthorized"}');
    // Refuse every call: the agent ends it without a conversation.
    const reply = path.endsWith("/session")
      ? { allowed: false, reason: "local_smoke_refusal", callId: null }
      : { ok: true };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    return;
  }
  res.writeHead(404).end();
});

/* ---------------- SIP (UDP) ---------------- */
function sipRequest(lines: string[], body = "") {
  return [...lines, `Content-Length: ${Buffer.byteLength(body)}`, "", body].join("\r\n");
}
function sipOptions(): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = createSocket("udp4");
    const t = setTimeout(() => (s.close(), reject(new Error("no SIP response to OPTIONS"))), 5000);
    s.on("message", (m) => (clearTimeout(t), s.close(), resolve(m.toString().split("\r\n")[0]!)));
    s.bind(0, "127.0.0.1", () => {
      const p = s.address().port;
      const tag = randomBytes(4).toString("hex");
      const msg = sipRequest([
        "OPTIONS sip:ping@127.0.0.1:5060 SIP/2.0",
        `Via: SIP/2.0/UDP 127.0.0.1:${p};branch=z9hG4bK${tag};rport`,
        "Max-Forwards: 70",
        `From: <sip:smoke@127.0.0.1>;tag=${tag}`,
        "To: <sip:ping@127.0.0.1>",
        `Call-ID: ${tag}@127.0.0.1`,
        "CSeq: 1 OPTIONS",
      ]);
      s.send(msg, 5060, "127.0.0.1");
    });
  });
}

interface CallResult {
  statuses: string[];
  answered: boolean;
  byeReceived: boolean;
  callId: string;
}
/** One INVITE: waits for a final answer, ACKs a 200, sends silence, waits for the far end's BYE. */
function sipCall(timeoutMs: number): Promise<CallResult> {
  return new Promise((resolve) => {
    const s = createSocket("udp4");
    const rtp = createSocket("udp4");
    const callId = `${randomBytes(8).toString("hex")}@127.0.0.1`;
    const fromTag = randomBytes(4).toString("hex");
    const r: CallResult = { statuses: [], answered: false, byeReceived: false, callId };
    let rtpTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      clearInterval(rtpTimer);
      s.close();
      rtp.close();
      resolve(r);
    };
    const t = setTimeout(finish, timeoutMs);
    rtp.bind(0, "127.0.0.1", () =>
      s.bind(0, "127.0.0.1", () => {
        const p = s.address().port;
        const sdp = [
          "v=0",
          "o=- 1 1 IN IP4 127.0.0.1",
          "s=clickai-local-smoke",
          "c=IN IP4 127.0.0.1",
          "t=0 0",
          `m=audio ${rtp.address().port} RTP/AVP 0 101`,
          "a=rtpmap:0 PCMU/8000",
          "a=rtpmap:101 telephone-event/8000",
          "a=sendrecv",
          "",
        ].join("\r\n");
        const head = (method: string, cseq: number, branch: string, toTag = "") => [
          `${method} sip:${TEST_NUMBER}@127.0.0.1:5060 SIP/2.0`,
          `Via: SIP/2.0/UDP 127.0.0.1:${p};branch=z9hG4bK${branch};rport`,
          "Max-Forwards: 70",
          `From: <sip:${CALLER_NUMBER}@127.0.0.1>;tag=${fromTag}`,
          `To: <sip:${TEST_NUMBER}@127.0.0.1>${toTag ? `;tag=${toTag}` : ""}`,
          `Call-ID: ${callId}`,
          `CSeq: ${cseq} ${method}`,
          `Contact: <sip:smoke@127.0.0.1:${p}>`,
        ];
        s.on("message", (m) => {
          const text = m.toString();
          const first = text.split("\r\n")[0]!;
          if (first.startsWith("SIP/2.0 ")) {
            r.statuses.push(first.slice(8));
            if (first.startsWith("SIP/2.0 200") && /CSeq:\s*1 INVITE/i.test(text) && !r.answered) {
              r.answered = true;
              const toTag = /^To:.*;tag=([^;\r\n]+)/im.exec(text)?.[1] ?? "";
              s.send(
                sipRequest(head("ACK", 1, randomBytes(4).toString("hex"), toTag)),
                5060,
                "127.0.0.1",
              );
              // 20 ms of PCMU silence every 20 ms to the address in the answer.
              const ip = /^c=IN IP4 (\S+)/m.exec(text)?.[1];
              const port = Number(/^m=audio (\d+)/m.exec(text)?.[1]);
              if (ip && port) {
                let seq = 0;
                const ssrc = randomBytes(4).readUInt32BE(0);
                rtpTimer = setInterval(() => {
                  const pkt = Buffer.alloc(12 + 160, 0xff);
                  pkt[0] = 0x80;
                  pkt[1] = 0;
                  pkt.writeUInt16BE(seq++ & 0xffff, 2);
                  pkt.writeUInt32BE((seq * 160) >>> 0, 4);
                  pkt.writeUInt32BE(ssrc, 8);
                  rtp.send(pkt, port, ip);
                }, 20);
              }
            } else if (/^SIP\/2\.0 [3-6]\d\d/.test(first) && /CSeq:\s*1 INVITE/i.test(text)) {
              s.send(sipRequest(head("ACK", 1, randomBytes(4).toString("hex"))), 5060, "127.0.0.1");
              clearTimeout(t);
              finish();
            }
            return;
          }
          if (first.startsWith("BYE ")) {
            r.byeReceived = true;
            // 200 OK to the BYE: echo its Via/From/To/Call-ID/CSeq.
            const keep = text.split("\r\n").filter((l) => /^(Via|From|To|Call-ID|CSeq):/i.test(l));
            s.send(sipRequest(["SIP/2.0 200 OK", ...keep]), 5060, "127.0.0.1");
            clearTimeout(t);
            setTimeout(finish, 300);
          }
        });
        s.send(
          sipRequest(
            [...head("INVITE", 1, randomBytes(4).toString("hex")), "Content-Type: application/sdp"],
            sdp,
          ),
          5060,
          "127.0.0.1",
        );
      }),
    );
  });
}

/* ---------------- main ---------------- */
const rooms = new RoomServiceClient(HTTP, KEY, SECRET);
const dispatch = new AgentDispatchClient(HTTP, KEY, SECRET);
const AGENT_KIND = 4; // livekit.ParticipantInfo.Kind.AGENT
const SIP_KIND = 3; // livekit.ParticipantInfo.Kind.SIP

await new Promise<void>((r) => fakeKlyro.listen(FAKE_KLYRO_PORT, "0.0.0.0", r));
console.log(
  `fake klyro listening on 0.0.0.0:${FAKE_KLYRO_PORT} (env: ${envFile}, secrets not printed)`,
);

await check("LiveKit HTTP health (GET /)", async () => {
  const r = await fetch(`${HTTP}/`);
  if (!r.ok) throw new Error(`status ${r.status}`);
  return `status ${r.status}`;
});
await check("LiveKit API with the configured key (ListRooms)", async () => {
  const list = await rooms.listRooms();
  return `${list.length} rooms`;
});
await check("LiveKit API refuses a wrong secret", async () => {
  const bad = new RoomServiceClient(HTTP, KEY, randomBytes(32).toString("hex"));
  try {
    await bad.listRooms();
  } catch (e) {
    return `refused: ${(e as Error).message.slice(0, 60)}`;
  }
  throw new Error("a wrong secret was accepted");
});
await check("LiveKit WebSocket signalling (join, receive server message)", async () => {
  const room = `smoke-ws-${randomBytes(3).toString("hex")}`;
  const at = new AccessToken(KEY, SECRET, { identity: "smoke-ws", ttl: 60 });
  at.addGrant({ roomJoin: true, room });
  const token = await at.toJwt();
  const v = await fetch(`${HTTP}/rtc/validate?access_token=${token}`);
  if (!v.ok) throw new Error(`/rtc/validate status ${v.status}`);
  const bytes = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`${WS}/rtc?access_token=${token}&auto_subscribe=1&protocol=15`);
    ws.binaryType = "arraybuffer";
    const t = setTimeout(() => (ws.close(), reject(new Error("no message within 10 s"))), 10_000);
    ws.onmessage = (m) => {
      clearTimeout(t);
      ws.close();
      resolve((m.data as ArrayBuffer).byteLength ?? 0);
    };
    ws.onerror = () => (clearTimeout(t), reject(new Error("websocket error")));
  });
  await rooms.deleteRoom(room).catch(() => {});
  return `validate 200, first server message ${bytes} bytes`;
});
await check("Redis is not reachable from the host", async () => {
  const reachable = await new Promise<boolean>((resolve) => {
    const c = connect({ host: "127.0.0.1", port: 6379 });
    c.setTimeout(2000);
    c.on("connect", () => (c.destroy(), resolve(true)));
    c.on("error", () => resolve(false));
    c.on("timeout", () => (c.destroy(), resolve(false)));
  });
  if (reachable) throw new Error("127.0.0.1:6379 accepted a connection");
  return "127.0.0.1:6379 refused";
});
await check("SIP service answers OPTIONS on 127.0.0.1:5060/udp", async () => sipOptions());
await check("Agent health (GET :8081/)", async () => {
  const r = await fetch(`${AGENT_HEALTH}/`);
  if (!r.ok) throw new Error(`status ${r.status}`);
  return `status ${r.status}`;
});
// Health endpoint only; registration itself is proven by the dispatch check.
await check("Agent worker health endpoint names the agent", async () => {
  const r = await fetch(`${AGENT_HEALTH}/worker`);
  const text = await r.text();
  if (!r.ok || !text.includes(AGENT)) throw new Error(`status ${r.status}`);
  return `${AGENT}`;
});
let dispatchRoom: string | null = null;
await check("Agent dispatch: explicit dispatch puts an AGENT participant in the room", async () => {
  const room = `smoke-dispatch-${RUN.runId}`;
  dispatchRoom = room;
  await rooms.createRoom({ name: room, emptyTimeout: 60 });
  await dispatch.createDispatch(room, AGENT, { metadata: "{}" });
  const p = await until(
    async () => (await rooms.listParticipants(room)).find((x) => Number(x.kind) === AGENT_KIND),
    30_000,
    "the agent to join",
  );
  await rooms.deleteRoom(room).catch(() => {});
  return `identity ${p.identity}`;
});
const REQUIRED_EVENTS = ["room_started", "participant_joined", "room_finished"];
await check("Webhooks: this run's room events, signed by LiveKit, verified by klyro", async () => {
  if (!dispatchRoom) throw new Error("no dispatch room (dispatch check failed)");
  const room = dispatchRoom;
  await until(
    async () => missingWebhookEvents(webhooks, room, REQUIRED_EVENTS).length === 0,
    15_000,
    `webhooks ${REQUIRED_EVENTS.join(", ")} for ${room}`,
  ).catch(() => {
    throw new Error(
      `missing for ${room}: ${missingWebhookEvents(webhooks, room, REQUIRED_EVENTS).join(", ")}`,
    );
  });
  const bad = webhooks.filter((w) => !w.ok);
  if (bad.length) throw new Error(`${bad.length} rejected: ${bad.map((b) => b.reason).join(",")}`);
  return `${REQUIRED_EVENTS.join(", ")} for ${room}; ${webhooks.length} verified, 0 rejected`;
});

if (SIP_CALL) {
  const sip = new SipClient(HTTP, KEY, SECRET);
  let run: SmokeSipRun | null = null;
  await check("Local target proven; per-run SIP trunk + dispatch rule created", async () => {
    assertWebhookProof(webhooks, dispatchRoom);
    const stale = await preflight(sip, RUN);
    const r = new SmokeSipRun(sip, RUN);
    run = r;
    await r.setup({ allowedAddresses: [SIP_SOURCE_CIDR], agentName: AGENT });
    return `${RUN.trunk} / ${RUN.rule}, number ${TEST_NUMBER}${stale.length ? `; stale smoke objects left untouched: ${stale.length}` : ""}`;
  });
  try {
    if (run) await sipChecks();
  } finally {
    const r = run as SmokeSipRun | null;
    if (r) {
      const res = await r.cleanup();
      report(
        "Cleanup: only this run's trunk and dispatch rule deleted",
        res.failed.length === 0 && res.deleted.length === 2,
        [...res.deleted, ...res.skipped, ...res.failed].join("; "),
      );
    }
  }
}

async function sipChecks() {
  const before = internal.length;
  let call: CallResult | null = null;
  let callRoom = "";
  await check("Local SIP INVITE: answered, room created, SIP + AGENT participants", async () => {
    const pending = sipCall(60_000);
    const roomName = await until(
      async () =>
        selectRunRoom(
          (await rooms.listRooms()).map((r) => r.name),
          RUN.roomPrefix,
        ),
      20_000,
      `a ${RUN.roomPrefix}* room`,
    );
    const room = { name: roomName };
    callRoom = roomName;
    const kinds = await until(
      async () => {
        const ps = await rooms.listParticipants(room.name);
        const k = ps.map((x) => Number(x.kind));
        return k.includes(SIP_KIND) && k.includes(AGENT_KIND) ? k : null;
      },
      20_000,
      "SIP and AGENT participants",
    ).catch(async () => (await rooms.listParticipants(room.name)).map((x) => Number(x.kind)));
    call = await pending;
    if (!call.answered) throw new Error(`not answered: ${call.statuses.join(" | ")}`);
    if (!(kinds.includes(SIP_KIND) && kinds.includes(AGENT_KIND)))
      throw new Error(`participant kinds seen: ${kinds.join(",")}`);
    const sipP = (await rooms.listParticipants(room.name).catch(() => [])).find(
      (x) => Number(x.kind) === SIP_KIND,
    );
    if (sipP && sipP.attributes["sip.trunkPhoneNumber"] !== TEST_NUMBER)
      throw new Error(`SIP participant dialled ${sipP.attributes["sip.trunkPhoneNumber"]}`);
    return `${room.name}; SIP: ${call.statuses.join(" | ")}`;
  });
  await check(
    "Agent -> klyro: signed session request (HMAC verified) for the dialled number",
    async () => {
      const s = await until(
        async () => internal.slice(before).find((i) => i.path.endsWith("/session")),
        15_000,
        "the agent's session request",
      );
      if (!s.ok) throw new Error(`signature rejected: ${s.reason}`);
      if (s.body["calledNumber"] !== TEST_NUMBER)
        throw new Error(`calledNumber ${String(s.body["calledNumber"])}`);
      if (s.body["roomName"] !== callRoom)
        throw new Error(`roomName ${String(s.body["roomName"])}`);
      return `calledNumber ${TEST_NUMBER}, callerNumber ${String(s.body["callerNumber"])}, room ${callRoom}`;
    },
  );
  await check("Refused call is ended by the agent (BYE / room removed)", async () => {
    const gone = await until(
      async () => !(await rooms.listRooms()).some((r) => r.name === callRoom),
      30_000,
      "the call room to close",
    ).catch(() => false);
    const c = call as CallResult | null;
    if (!c?.byeReceived && !gone) throw new Error("no BYE and the room is still open");
    return `BYE received: ${c?.byeReceived}, room closed: ${Boolean(gone)}`;
  });
  if (callRoom) await rooms.deleteRoom(callRoom).catch(() => {});
}

fakeKlyro.close();
const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed${SIP_CALL ? "" : " (run with --sip-call for the local SIP call)"}`,
);
process.exit(failed.length ? 1 : 0);
