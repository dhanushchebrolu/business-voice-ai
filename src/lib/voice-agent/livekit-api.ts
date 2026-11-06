/**
 * The LiveKit server API calls klyro makes, implemented with Web Crypto +
 * fetch (no Node SDK in the Worker bundle), matching livekit-server-sdk 2.x:
 *
 *   POST {https host}/twirp/livekit.AgentDispatchService/CreateDispatch
 *     token video.roomAdmin for the room; body {"room","agentName","metadata"}
 *   POST {https host}/twirp/livekit.RoomService/ListParticipants
 *     token video.roomAdmin for the room; body {"room"}
 *   POST {https host}/twirp/livekit.RoomService/DeleteRoom
 *     token video.roomCreate (LiveKit checks this grant; it is not
 *     room-scoped); body {"room"}
 *   POST {https host}/twirp/livekit.RoomService/ListRooms
 *     token video.roomList; body {} (orphan-room sweep)
 *
 * Tokens and request shapes are cross-checked against livekit-server-sdk's
 * own TokenVerifier and RoomServiceClient in
 * services/voice-agent/tests/outbound-dispatch.spec.ts.
 */

const enc = new TextEncoder();

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface TokenParams {
  apiKey: string;
  apiSecret: string;
  room: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}

/** Short-lived (60 s) server token allowed to administer exactly one room. */
export async function roomAdminToken(p: TokenParams): Promise<string> {
  return signServerToken(p, { roomAdmin: true, room: p.room });
}

/**
 * Token for DeleteRoom: exactly the grant LiveKit requires and nothing else.
 * LiveKit's DeleteRoom checks roomCreate (open-source server
 * pkg/service/roomservice.go: EnsureCreatePermission); no narrower or
 * room-scoped grant is accepted for it, and livekit-server-sdk sends the
 * same single grant (RoomServiceClient.deleteRoom: { roomCreate: true }).
 * The grant is project-wide, so: 30 s lifetime, minted per request, only
 * after the URL passed livekitApiBase, and only for a room name the caller
 * bound to a specific call (room-sweep.server.ts).
 */
export async function roomDeleteToken(p: TokenParams): Promise<string> {
  return signServerToken({ ...p, ttlSeconds: p.ttlSeconds ?? 30 }, { roomCreate: true });
}

/** Short-lived (30 s) token for ListRooms (roomList grant only). */
export async function roomListToken(p: Omit<TokenParams, "room">): Promise<string> {
  return signServerToken({ ...p, room: "", ttlSeconds: p.ttlSeconds ?? 30 }, { roomList: true });
}

async function signServerToken(p: TokenParams, video: Record<string, unknown>): Promise<string> {
  const now = p.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: p.apiKey,
      sub: "klyro",
      nbf: now - 5,
      exp: now + (p.ttlSeconds ?? 60),
      video,
    }),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(p.apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

/** A LiveKit URL klyro refuses to send credentials to (F13). Never contains a token. */
export class LiveKitConfigError extends Error {}

/** Hosts allowed in addition to *.livekit.cloud: LIVEKIT_ALLOWED_HOSTS (comma-separated, exact). */
export function allowedLiveKitHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+$/.test(h) && h.includes("."));
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The https origin klyro may send a LiveKit server token to (F13), or
 * LiveKitConfigError. Checked BEFORE any token is minted or sent:
 *   - scheme wss:// or https:// (TLS). ws:// / http:// only to a loopback
 *     host (local development), never across a network;
 *   - host: a subdomain of livekit.cloud, a host listed in
 *     LIVEKIT_ALLOWED_HOSTS (self-hosted LiveKit), or loopback;
 *   - no credentials, path, query or fragment in the URL.
 */
export function livekitApiBase(url: string, allowedHosts: readonly string[] = []): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LiveKitConfigError("LIVEKIT_URL is not a valid URL");
  }
  const host = u.hostname.toLowerCase();
  const loopback = LOOPBACK.has(host);
  const tls = u.protocol === "wss:" || u.protocol === "https:";
  const plain = u.protocol === "ws:" || u.protocol === "http:";
  if (!tls && !(plain && loopback))
    throw new LiveKitConfigError(
      plain
        ? "LIVEKIT_URL must use wss:// (plain ws:// is only allowed for localhost)"
        : "LIVEKIT_URL must use wss:// or https://",
    );
  if (u.username || u.password)
    throw new LiveKitConfigError("LIVEKIT_URL must not contain credentials");
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash)
    throw new LiveKitConfigError("LIVEKIT_URL must not contain a path, query or fragment");
  const cloud = host.endsWith(".livekit.cloud") && host.length > ".livekit.cloud".length;
  if (!cloud && !loopback && !allowedHosts.includes(host))
    throw new LiveKitConfigError(
      `LIVEKIT_URL host ${host} is not *.livekit.cloud or listed in LIVEKIT_ALLOWED_HOSTS`,
    );
  return `${tls ? "https:" : "http:"}//${u.host}`;
}

/** wss://x.livekit.cloud -> https://x.livekit.cloud (ws -> http only for local dev). No validation: see livekitApiBase. */
export function livekitHttpUrl(url: string): string {
  return url.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "");
}

export class LiveKitApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * What a failed CreateDispatch tells us. "rejected": LiveKit answered with a
 * definite 4xx (bad token, unknown agent, invalid request): no job exists
 * and none will. Anything else (timeout, network error, 408, 429, 5xx) is
 * "unknown": the dispatch may or may not exist, so the call must be treated
 * as possibly in progress, never as failed.
 */
export function classifyDispatchError(err: unknown): "rejected" | "unknown" {
  // Refused before anything was sent: no dispatch exists.
  if (err instanceof LiveKitConfigError) return "rejected";
  if (err instanceof LiveKitApiError) {
    const s = err.status;
    if (s >= 400 && s < 500 && s !== 408 && s !== 429) return "rejected";
  }
  return "unknown";
}

export async function createAgentDispatch(p: {
  url: string;
  apiKey: string;
  apiSecret: string;
  room: string;
  agentName: string;
  metadata: string;
  fetchImpl?: typeof fetch;
  /** LIVEKIT_ALLOWED_HOSTS (see livekitApiBase). */
  allowedHosts?: readonly string[];
  timeoutMs?: number;
}): Promise<{ dispatchId: string | null }> {
  const base = livekitApiBase(p.url, p.allowedHosts); // before any token exists
  const token = await roomAdminToken({ apiKey: p.apiKey, apiSecret: p.apiSecret, room: p.room });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), p.timeoutMs ?? 8000);
  try {
    const res = await (p.fetchImpl ?? fetch)(
      `${base}/twirp/livekit.AgentDispatchService/CreateDispatch`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ room: p.room, agentName: p.agentName, metadata: p.metadata }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      // Twirp error bodies carry a code/msg, never a credential; keep it short.
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new LiveKitApiError(res.status, `livekit dispatch failed (${res.status}) ${text}`);
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { dispatchId: body.id ?? null };
  } finally {
    clearTimeout(timer);
  }
}

interface LiveKitCallParams {
  url: string;
  apiKey: string;
  apiSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Called once per HTTP request (subrequest accounting). */
  onRequest?: () => void;
  /** LIVEKIT_ALLOWED_HOSTS (see livekitApiBase). */
  allowedHosts?: readonly string[];
}
interface RoomCallParams extends LiveKitCallParams {
  room: string;
}

/**
 * One RoomService twirp call with a hard timeout. Returns the parsed body,
 * or "not_found" when LiveKit answers 404 (twirp code not_found: the room no
 * longer exists). Any other failure throws LiveKitApiError; status 0 means
 * no answer (timeout or network), which callers treat as retryable.
 */
async function roomServiceCall(
  p: LiveKitCallParams,
  method: "ListParticipants" | "DeleteRoom" | "ListRooms",
  mint: () => Promise<string>,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | "not_found"> {
  const base = livekitApiBase(p.url, p.allowedHosts); // throws before a token is minted
  const token = await mint();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), p.timeoutMs ?? 5000);
  let res: Response;
  p.onRequest?.();
  try {
    res = await (p.fetchImpl ?? fetch)(`${base}/twirp/livekit.RoomService/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new LiveKitApiError(
      0,
      `livekit ${method} ${ctrl.signal.aborted ? "timed out" : "unreachable"}: ${String(e).slice(0, 120)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return "not_found";
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new LiveKitApiError(res.status, `livekit ${method} failed (${res.status}) ${text}`);
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export interface RoomParticipant {
  identity: string;
  /** LiveKit's `sip.callID` attribute; null for non-SIP participants (the agent). */
  sipCallId: string | null;
  /**
   * An agent participant: ParticipantInfo.kind AGENT (protobuf JSON name
   * "AGENT", or its number 4), or LiveKit Agents' identity prefix "agent-".
   */
  isAgent: boolean;
}

/** The room's participants, or "not_found" when the room no longer exists. */
export async function listRoomParticipants(
  p: RoomCallParams,
): Promise<RoomParticipant[] | "not_found"> {
  const body = await roomServiceCall(
    p,
    "ListParticipants",
    () => roomAdminToken({ apiKey: p.apiKey, apiSecret: p.apiSecret, room: p.room }),
    { room: p.room },
  );
  if (body === "not_found") return "not_found";
  const list = Array.isArray(body["participants"]) ? (body["participants"] as unknown[]) : [];
  return list.map((x) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const attrs = (
      o["attributes"] && typeof o["attributes"] === "object" ? o["attributes"] : {}
    ) as Record<string, unknown>;
    const sip = attrs["sip.callID"];
    const identity = typeof o["identity"] === "string" ? o["identity"] : "";
    const kind = o["kind"];
    return {
      identity,
      sipCallId: typeof sip === "string" && sip ? sip : null,
      isAgent: kind === "AGENT" || kind === 4 || identity.startsWith("agent-"),
    };
  });
}

/**
 * Deletes a room (every participant is disconnected; for a SIP participant
 * LiveKit's SIP service then ends the phone call). "not_found" = already gone.
 */
export async function deleteLiveKitRoom(p: RoomCallParams): Promise<"deleted" | "not_found"> {
  const body = await roomServiceCall(
    p,
    "DeleteRoom",
    () => roomDeleteToken({ apiKey: p.apiKey, apiSecret: p.apiSecret, room: p.room }),
    { room: p.room },
  );
  return body === "not_found" ? "not_found" : "deleted";
}

export interface LiveKitRoom {
  name: string;
  /** Room creation time (ms since epoch); null when LiveKit did not say. */
  createdAtMs: number | null;
  numParticipants: number;
}

/** All rooms of the project (RoomService/ListRooms). */
export async function listLiveKitRooms(p: LiveKitCallParams): Promise<LiveKitRoom[]> {
  const body = await roomServiceCall(
    p,
    "ListRooms",
    () => roomListToken({ apiKey: p.apiKey, apiSecret: p.apiSecret }),
    {},
  );
  if (body === "not_found") return [];
  const list = Array.isArray(body["rooms"]) ? (body["rooms"] as unknown[]) : [];
  return list.map((x) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    // protobuf JSON: int64 as string. creation_time_ms (newer servers) or
    // creation_time (seconds).
    const ms = Number(o["creationTimeMs"]);
    const s = Number(o["creationTime"]);
    return {
      name: typeof o["name"] === "string" ? o["name"] : "",
      createdAtMs:
        Number.isFinite(ms) && ms > 0 ? ms : Number.isFinite(s) && s > 0 ? s * 1000 : null,
      numParticipants: Number(o["numParticipants"]) || 0,
    };
  });
}
