/**
 * Route-specific authentication for the voice-agent cron routes
 * (Phase 2.12, F14):
 *   POST /api/public/cron/reconcile-sip-calls
 *   POST /api/public/cron/sweep-sip-rooms
 *
 * Secret: VOICE_AGENT_CRON_SECRET (>= 32 chars), plus
 * VOICE_AGENT_CRON_SECRET_PREVIOUS during a rotation. It is NOT the shared
 * LOVABLE_CRON_SECRET: once it is set, LOVABLE_CRON_SECRET no longer opens
 * these routes. Two ways to present it:
 *
 *  1. Signed (preferred; replay-protected):
 *       X-Voice-Cron-Timestamp: <unix seconds>
 *       X-Voice-Cron-Signature: hex(HMAC-SHA256(secret,
 *           "v1\n" + timestamp + "\nPOST\n/api/public/cron/<route>"))
 *     Accepted within ±300 s of klyro's clock, ONCE (the signature is
 *     claimed in webhook_events, provider "voice_agent_cron"; a replay in
 *     the window is refused). The signature names the route, so it cannot
 *     be used on the other route. scripts/staging/schedule-cron.sql signs
 *     with pgcrypto.
 *  2. Route-scoped bearer (for a scheduler that can only send fixed
 *     headers): Authorization: Bearer hex(HMAC-SHA256(secret,
 *     "v1\nbearer\n/api/public/cron/<route>")). Different per route; no
 *     replay protection (the routes are idempotent and rate-limited).
 *     Disabled with VOICE_AGENT_CRON_REQUIRE_SIGNED=true.
 *
 * Without VOICE_AGENT_CRON_SECRET the routes keep the previous behaviour
 * (LOVABLE_CRON_SECRET bearer via authenticateCronRequest), with a warning
 * on every run; production must set it (RUNBOOK.md).
 *
 * Abuse limits: failed authentications count against the client IP
 * (10/min per isolate, then 429; clock-skew rejections are not counted),
 * and authenticated runs are limited per route (6/min, shared in Postgres).
 * Responses and logs never contain a secret, token, signature or header.
 */
import { clientIp, tooManyRequests, type VoiceAgentLimiter } from "./rate-limits.ts";

export type VoiceCronRoute = "reconcile-sip-calls" | "sweep-sip-rooms";
export const CRON_SIGNATURE_WINDOW_SECONDS = 300;
export const CRON_REPLAY_PROVIDER = "voice_agent_cron";
const MIN_SECRET_LENGTH = 32;

export interface CronAuthDeps {
  env: (name: string) => string | undefined;
  nowSeconds: () => number;
  /** Atomically records an id; false when it was already recorded (replay). */
  claimOnce: (provider: string, id: string, payload: Record<string, unknown>) => Promise<boolean>;
  limiter: VoiceAgentLimiter;
  /** The pre-2.12 shared-secret check (LOVABLE_CRON_SECRET), used only when no voice secret is set. */
  legacyAuth: (request: Request) => Promise<Response | null>;
}

export type CronAuthResult =
  { ok: true; mode: "signed" | "bearer" | "legacy" } | { ok: false; response: Response };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

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

/** Constant-time comparison of two strings of possibly different length. */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const cronPath = (route: VoiceCronRoute) => `/api/public/cron/${route}`;
export const signedMessage = (route: VoiceCronRoute, ts: string) =>
  `v1\n${ts}\nPOST\n${cronPath(route)}`;
export const bearerMessage = (route: VoiceCronRoute) => `v1\nbearer\n${cronPath(route)}`;

/** The signature a scheduler sends (exported for the scheduler docs and tests). */
export const signCronRequest = (secret: string, route: VoiceCronRoute, ts: number) =>
  hmacHex(secret, signedMessage(route, String(ts)));
/** The route-scoped bearer token for a scheduler that cannot sign. */
export const cronBearerToken = (secret: string, route: VoiceCronRoute) =>
  hmacHex(secret, bearerMessage(route));

export async function authenticateVoiceCron(
  request: Request,
  route: VoiceCronRoute,
  deps: CronAuthDeps,
): Promise<CronAuthResult> {
  const ip = clientIp(request);
  /** Rejects; counts the failure unless it is only clock skew. */
  const reject = (reason: string, counted = true): CronAuthResult => {
    const budget = deps.limiter.authFailureBudget("cron", ip);
    if (!budget.allowed) return { ok: false, response: tooManyRequests(budget) };
    if (counted) deps.limiter.recordAuthFailure("cron", ip);
    // Never log header values, tokens or signatures.
    console.warn("voice_agent:cron_auth_failed", { route, reason });
    return { ok: false, response: json(401, { error: "unauthorized" }) };
  };
  const ranOk = async (mode: "signed" | "bearer" | "legacy"): Promise<CronAuthResult> => {
    const limit = await deps.limiter.shared("cron_run", route);
    if (!limit.allowed) {
      console.warn("voice_agent:cron_rate_limited", { route });
      return { ok: false, response: tooManyRequests(limit) };
    }
    return { ok: true, mode };
  };

  const current = deps.env("VOICE_AGENT_CRON_SECRET");
  const previous = deps.env("VOICE_AGENT_CRON_SECRET_PREVIOUS");
  if (!current) {
    const legacy = await deps.legacyAuth(request);
    if (legacy) {
      // Count failures here too; keep the legacy response (no detail).
      const budget = deps.limiter.authFailureBudget("cron", ip);
      if (!budget.allowed) return { ok: false, response: tooManyRequests(budget) };
      if (legacy.status === 401) deps.limiter.recordAuthFailure("cron", ip);
      console.warn("voice_agent:cron_auth_failed", { route, reason: "legacy_rejected" });
      return { ok: false, response: legacy };
    }
    console.warn("voice_agent:cron_legacy_auth", { route });
    return ranOk("legacy");
  }
  if (current.length < MIN_SECRET_LENGTH || (previous && previous.length < MIN_SECRET_LENGTH)) {
    console.error("voice_agent:cron_misconfigured", { route, reason: "secret_too_short" });
    return { ok: false, response: json(500, { error: "server_misconfigured" }) };
  }
  const secrets = previous ? [current, previous] : [current];

  const ts = request.headers.get("x-voice-cron-timestamp");
  const sig = request.headers.get("x-voice-cron-signature");
  if (ts !== null || sig !== null) {
    if (!ts || !sig) return reject("incomplete_signature");
    if (!/^\d{1,12}$/.test(ts)) return reject("bad_timestamp");
    if (!/^[0-9a-f]{64}$/.test(sig)) return reject("bad_signature");
    if (Math.abs(deps.nowSeconds() - Number(ts)) > CRON_SIGNATURE_WINDOW_SECONDS)
      return reject("stale", false);
    let valid = false;
    for (const s of secrets)
      if (safeEqual(await hmacHex(s, signedMessage(route, ts)), sig)) valid = true;
    if (!valid) return reject("bad_signature");
    // Only a VALID signature is ever stored, so the table cannot be filled by guessing.
    const fresh = await deps.claimOnce(CRON_REPLAY_PROVIDER, `${route}:${sig}`, {
      route,
      timestamp: Number(ts),
    });
    if (!fresh) return reject("replayed");
    return ranOk("signed");
  }

  if (deps.env("VOICE_AGENT_CRON_REQUIRE_SIGNED") === "true") return reject("signature_required");
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") ?? "");
  if (!m) return reject("missing_or_malformed_token");
  let valid = false;
  for (const s of secrets) if (safeEqual(await cronBearerToken(s, route), m[1]!)) valid = true;
  if (!valid) return reject("bad_token");
  return ranOk("bearer");
}

/** Production wiring (lazy, server-only). */
export async function defaultCronAuthDeps(): Promise<CronAuthDeps> {
  const [{ supabaseAdmin }, { defaultVoiceAgentLimiter }, { authenticateCronRequest }] =
    await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("./rate-limits.ts"),
      import("@/integrations/supabase/cron-auth"),
    ]);
  return {
    env: (n) => process.env[n],
    nowSeconds: () => Math.floor(Date.now() / 1000),
    claimOnce: async (provider, id, payload) => {
      const { error } = await supabaseAdmin.from("webhook_events").insert({
        provider,
        event_id: id,
        event_type: "cron",
        payload: payload as never,
        processed_at: new Date().toISOString(),
      });
      if (!error) return true;
      if ((error as { code?: string }).code === "23505") return false;
      throw error;
    },
    limiter: await defaultVoiceAgentLimiter(),
    legacyAuth: authenticateCronRequest,
  };
}
