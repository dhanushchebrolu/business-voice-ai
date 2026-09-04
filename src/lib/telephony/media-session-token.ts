import { createHmac, timingSafeEqual } from "crypto";

/**
 * Opaque, signed, short-lived media-session token.
 *
 * Exotel's Voicebot Applet lets a call-flow forward a handful of custom
 * parameters on its WSS URL (documented limit: 3 parameters, 256 characters
 * total — see PHASE_D1_EXOTEL_FINAL_REPORT.md §7), so this is deliberately
 * one compact opaque string, never raw tenant/organization/database IDs
 * (spec §7/§24: "Do not allow `?organization_id=some-id` to authorize a
 * media session").
 *
 * This token is a *second factor*, layered on top of — never a replacement
 * for — cross-checking the connecting call against `call_logs` in the
 * database (see exotel-provider.ts's `openMediaBridge`). A media session is
 * only ever accepted when BOTH checks pass. If a given Exotel account's
 * call-flow cannot be configured to pass a custom parameter (unverified
 * without a live account — see the report), the CallSid-against-`call_logs`
 * check alone remains the mandatory baseline; this token narrows the
 * window further where available.
 */

export interface MediaSessionTokenPayload {
  callId: string;
  providerCallId: string;
  organizationId: string;
  /** Unix seconds. */
  exp: number;
}

function secret(): string {
  const key = process.env["MEDIA_SESSION_TOKEN_SECRET"];
  if (!key) throw new Error("MEDIA_SESSION_TOKEN_SECRET is not configured.");
  return key;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

export function mintMediaSessionToken(payload: MediaSessionTokenPayload): string {
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const signature = base64url(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${signature}`;
}

export type MediaSessionTokenResult =
  | { ok: true; payload: MediaSessionTokenPayload }
  | { ok: false; reason: "malformed" | "invalid_signature" | "expired" | "not_configured" };

export function verifyMediaSessionToken(token: string): MediaSessionTokenResult {
  let key: string;
  try {
    key = secret();
  } catch {
    return { ok: false, reason: "not_configured" };
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, signature] = parts;

  const expected = base64url(createHmac("sha256", key).update(body).digest());
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let payload: MediaSessionTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as MediaSessionTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.callId !== "string" ||
    typeof payload.providerCallId !== "string" ||
    typeof payload.organizationId !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}
