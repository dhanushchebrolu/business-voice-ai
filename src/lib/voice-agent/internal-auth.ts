/**
 * Authentication for requests from the LiveKit voice-agent service
 * (services/voice-agent) to klyro's internal voice-agent API.
 *
 * The agent runs outside Cloudflare (a long-running Node process), so it
 * reaches klyro over the public internet. Every request is signed:
 *
 *   x-clickai-key-id      which shared secret signed it ("current"/"previous",
 *                         so the secret can be rotated without downtime)
 *   x-clickai-timestamp   unix seconds; rejected outside ±MAX_SKEW_SECONDS
 *   x-clickai-nonce       random 16–64 chars [A-Za-z0-9_-]; each nonce is
 *                         accepted once (the caller supplies the replay store)
 *   x-clickai-signature   "v1=" + hex HMAC-SHA256(secret, canonical string)
 *
 *   canonical = "v1\n" + timestamp + "\n" + nonce + "\n" + METHOD + "\n" +
 *               path(+query) + "\n" + hex SHA-256(body)
 *
 * Pure Web Crypto, no server imports: the same code verifies in the Worker
 * and is mirrored byte-for-byte by the agent's signer (cross-tested in
 * services/voice-agent/tests/klyro-client.spec.ts).
 */

export const MAX_SKEW_SECONDS = 60;
export const MAX_BODY_BYTES = 64 * 1024;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export type KeyId = "current" | "previous";

export interface SignedHeaders {
  "x-clickai-key-id": KeyId;
  "x-clickai-timestamp": string;
  "x-clickai-nonce": string;
  "x-clickai-signature": string;
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(body: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(body)));
}

export function canonicalString(p: {
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  bodyHash: string;
}): string {
  return ["v1", p.timestamp, p.nonce, p.method.toUpperCase(), p.path, p.bodyHash].join("\n");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time comparison of two hex strings of equal expected length. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signRequest(p: {
  secret: string;
  keyId: KeyId;
  method: string;
  path: string;
  body: string;
  nowSeconds?: number;
  nonce?: string;
}): Promise<SignedHeaders> {
  const timestamp = String(p.nowSeconds ?? Math.floor(Date.now() / 1000));
  const nonce = p.nonce ?? crypto.randomUUID().replace(/-/g, "");
  const bodyHash = await sha256Hex(p.body);
  const sig = await hmacHex(
    p.secret,
    canonicalString({ timestamp, nonce, method: p.method, path: p.path, bodyHash }),
  );
  return {
    "x-clickai-key-id": p.keyId,
    "x-clickai-timestamp": timestamp,
    "x-clickai-nonce": nonce,
    "x-clickai-signature": `v1=${sig}`,
  };
}

export type VerifyFailure =
  | "not_configured"
  | "missing_headers"
  | "unknown_key"
  | "bad_timestamp"
  | "stale"
  | "bad_nonce"
  | "body_too_large"
  | "bad_signature"
  | "replayed";

export type VerifyResult =
  { ok: true; keyId: KeyId; nonce: string } | { ok: false; reason: VerifyFailure };

/**
 * Verifies a signed request. `claimNonce` must atomically record the nonce
 * and return false if it was already used (replay). It is only called
 * after the signature is valid, so unauthenticated traffic cannot fill the
 * replay store.
 */
export async function verifySignedRequest(p: {
  secrets: { current: string | undefined; previous?: string | undefined };
  method: string;
  path: string;
  body: string;
  header: (name: string) => string | null;
  nowSeconds?: number;
  claimNonce: (keyId: KeyId, nonce: string, timestamp: number) => Promise<boolean>;
  /** The route's body limit (default MAX_BODY_BYTES); session-end allows more (transcript). */
  maxBodyBytes?: number;
}): Promise<VerifyResult> {
  if (!p.secrets.current) return { ok: false, reason: "not_configured" };
  const keyId = p.header("x-clickai-key-id");
  const ts = p.header("x-clickai-timestamp");
  const nonce = p.header("x-clickai-nonce");
  const signature = p.header("x-clickai-signature");
  if (!keyId || !ts || !nonce || !signature) return { ok: false, reason: "missing_headers" };
  const secret =
    keyId === "current" ? p.secrets.current : keyId === "previous" ? p.secrets.previous : undefined;
  if (!secret) return { ok: false, reason: "unknown_key" };
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, reason: "bad_timestamp" };
  const now = p.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale" };
  if (!NONCE_RE.test(nonce)) return { ok: false, reason: "bad_nonce" };
  if (enc.encode(p.body).length > (p.maxBodyBytes ?? MAX_BODY_BYTES))
    return { ok: false, reason: "body_too_large" };
  if (!signature.startsWith("v1=")) return { ok: false, reason: "bad_signature" };
  const expected = await hmacHex(
    secret,
    canonicalString({
      timestamp: ts,
      nonce,
      method: p.method,
      path: p.path,
      bodyHash: await sha256Hex(p.body),
    }),
  );
  if (!timingSafeEqualHex(expected, signature.slice(3)))
    return { ok: false, reason: "bad_signature" };
  if (!(await p.claimNonce(keyId as KeyId, nonce, Number(ts))))
    return { ok: false, reason: "replayed" };
  return { ok: true, keyId: keyId as KeyId, nonce };
}
