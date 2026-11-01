/**
 * Verifies a LiveKit server webhook, exactly as livekit-server-sdk 2.19.2's
 * WebhookReceiver does (read from the package source):
 *   - the `Authorization` header is a JWT signed HS256 with the LiveKit API
 *     secret, issuer = the API key, `exp` required;
 *   - its `sha256` claim equals base64(SHA-256(raw body)).
 * Implemented on Web Crypto so it runs in the Worker without the SDK.
 *
 * LiveKit webhooks are the SIGNED record of what happened on the SIP leg
 * (participant joined/left, room finished). Vobiz SIP-trunk webhooks are
 * documented as unsigned, so they are never used as proof of a call.
 */

const enc = new TextEncoder();

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export type LiveKitWebhookFailure =
  | "not_configured"
  | "missing_auth"
  | "malformed_token"
  | "bad_alg"
  | "bad_signature"
  | "bad_issuer"
  | "expired"
  | "not_yet_valid"
  | "missing_exp"
  | "body_mismatch"
  | "bad_json";

export interface LiveKitWebhookEvent {
  event: string;
  id?: string;
  createdAt?: string | number;
  room?: { name?: string; sid?: string };
  participant?: {
    sid?: string;
    identity?: string;
    kind?: string | number;
    joinedAt?: string | number;
    attributes?: Record<string, string>;
  };
}

export async function verifyLiveKitWebhook(p: {
  apiKey: string | undefined;
  apiSecret: string | undefined;
  authorization: string | null;
  body: string;
  nowSeconds?: number;
  clockToleranceSeconds?: number;
}): Promise<
  { ok: true; event: LiveKitWebhookEvent } | { ok: false; reason: LiveKitWebhookFailure }
> {
  if (!p.apiKey || !p.apiSecret) return { ok: false, reason: "not_configured" };
  if (!p.authorization) return { ok: false, reason: "missing_auth" };
  const token = p.authorization.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_token" };
  const [h, c, s] = parts as [string, string, string];
  let header: { alg?: string };
  let claims: { iss?: string; exp?: number; nbf?: number; sha256?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(c)));
  } catch {
    return { ok: false, reason: "malformed_token" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "bad_alg" };
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(p.apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = b64urlToBytes(s);
  } catch {
    return { ok: false, reason: "malformed_token" };
  }
  const valid = await crypto.subtle.verify("HMAC", key, sig, enc.encode(`${h}.${c}`));
  if (!valid) return { ok: false, reason: "bad_signature" };
  if (claims.iss !== p.apiKey) return { ok: false, reason: "bad_issuer" };
  const now = p.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tol = p.clockToleranceSeconds ?? 10;
  if (typeof claims.exp !== "number") return { ok: false, reason: "missing_exp" };
  if (now > claims.exp + tol) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && now + tol < claims.nbf)
    return { ok: false, reason: "not_yet_valid" };
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(p.body)));
  if (claims.sha256 !== bytesToB64(digest)) return { ok: false, reason: "body_mismatch" };
  try {
    return { ok: true, event: JSON.parse(p.body) as LiveKitWebhookEvent };
  } catch {
    return { ok: false, reason: "bad_json" };
  }
}

/** LiveKit's SIP participant attributes (names from @livekit/agents / server SDK source). */
export const SIP_ATTR = {
  callId: "sip.callID",
  callerNumber: "sip.phoneNumber",
  trunkPhoneNumber: "sip.trunkPhoneNumber",
  trunkId: "sip.trunkID",
  callStatus: "sip.callStatus",
  ruleId: "sip.ruleID",
} as const;

/** Seconds a participant was in the room, from LiveKit's own timestamps. */
export function participantSeconds(event: LiveKitWebhookEvent): number {
  const toSec = (v: string | number | undefined) => (v === undefined ? NaN : Number(v));
  const joined = toSec(event.participant?.joinedAt);
  const left = toSec(event.createdAt);
  if (!Number.isFinite(joined) || !Number.isFinite(left) || left < joined) return 0;
  return Math.round(left - joined);
}
