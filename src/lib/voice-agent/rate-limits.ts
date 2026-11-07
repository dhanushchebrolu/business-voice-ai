/**
 * Rate limits for the voice-agent routes (internal API, LiveKit webhook,
 * outbound start and claim). Two layers:
 *
 *  1. Failed-authentication budget per source, in memory, no I/O.
 *     Signatures are verified FIRST (one HMAC; cheap). A request with a
 *     valid signature is never refused by this layer, whatever its source's
 *     budget, so a misbehaving neighbour behind the same NAT (or another
 *     LiveKit customer sharing LiveKit's egress) cannot lock out the agent
 *     or our webhooks. Only failures that mean "this sender cannot
 *     authenticate" are counted (COUNTED_*_FAILURES); time-only failures
 *     (clock skew: "stale", "expired", "not_yet_valid") and a missing server
 *     configuration are not held against the source. A source over its
 *     budget gets 429 instead of 401 for further INVALID requests; there is
 *     no bypass for an invalid signature. Sources are grouped as IPv4 /32 and
 *     IPv6 /64; memory is bounded (MAX_TRACKED_SOURCES, oldest evicted).
 *     Per Worker isolate, best effort: volumetric floods are the Cloudflare
 *     WAF rule's job (STAGING.md §7).
 *  2. After authentication: a shared limit in Postgres
 *     (public.increment_rate_limit, the same atomic counter the public
 *     assistant and Sarvam context endpoints already use; no new
 *     migration). It is keyed by what a leaked agent key or a runaway
 *     caller would multiply: the call (tool / session-end / claim), the
 *     called number (session start), the organization and the user
 *     (outbound). It fails closed, like the existing limiter.
 *
 * A 429 is always returned before any replay claim, call row or billing
 * step, so the sender can retry later.
 */
import type { RateLimitDecision } from "../rate-limit.server.ts";

export type { RateLimitDecision };

export type PreAuthScope = "internal" | "webhook" | "cron";
export type SharedScope =
  | "session_start"
  | "tool"
  | "session_end"
  | "outbound_claim"
  | "outbound_org"
  | "outbound_user"
  | "cron_run";

export const VOICE_AGENT_LIMITS: Record<
  PreAuthScope | SharedScope,
  { limit: number; windowSeconds: number }
> = {
  // Failed authentications per source per minute (per isolate).
  internal: { limit: 30, windowSeconds: 60 },
  webhook: { limit: 30, windowSeconds: 60 },
  // Voice cron routes: only the scheduler calls them.
  cron: { limit: 10, windowSeconds: 60 },
  // Per called number: more new calls than this to one business number a
  // minute is not a receptionist workload.
  session_start: { limit: 30, windowSeconds: 60 },
  // Per call: a normal booking uses 2-6 tool calls in total.
  tool: { limit: 60, windowSeconds: 60 },
  session_end: { limit: 10, windowSeconds: 60 },
  // Per call: one claim plus a few retries of the same job.
  outbound_claim: { limit: 10, windowSeconds: 60 },
  // Outbound calls cost money per minute.
  outbound_org: { limit: 10, windowSeconds: 60 },
  outbound_user: { limit: 5, windowSeconds: 60 },
  // Per voice cron route: the schedules need 1 run / 5 min (sweep) and
  // 1 / 15 min (reconcile); this bounds the database and LiveKit load a
  // leaked cron credential could cause.
  cron_run: { limit: 6, windowSeconds: 60 },
};

export const MAX_TRACKED_SOURCES = 10_000;

/** internal-auth.ts failures counted against the source ("stale" = clock skew is not). */
export const COUNTED_INTERNAL_FAILURES: ReadonlySet<string> = new Set([
  "missing_headers",
  "unknown_key",
  "bad_timestamp",
  "bad_nonce",
  "body_too_large",
  "bad_signature",
  "replayed",
]);
/** livekit-webhook.ts failures counted against the source (time-only failures are not). */
export const COUNTED_WEBHOOK_FAILURES: ReadonlySet<string> = new Set([
  "missing_auth",
  "malformed_token",
  "bad_alg",
  "bad_signature",
  "bad_issuer",
  "missing_exp",
  "body_mismatch",
  "bad_json",
  "body_too_large",
]);

export interface VoiceAgentLimiter {
  /** No I/O. allowed=false when this source used up its failed-auth budget.
   *  Consulted only for requests that already FAILED verification. */
  authFailureBudget(scope: PreAuthScope, clientIp: string): RateLimitDecision;
  /** Count one failed authentication for this source. */
  recordAuthFailure(scope: PreAuthScope, clientIp: string): void;
  shared(scope: SharedScope, key: string): Promise<RateLimitDecision>;
}

/** Client IP as Cloudflare reports it. Never x-forwarded-for (caller-controlled). */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  // IPv4-mapped / embedded tail (e.g. ::ffff:1.2.3.4)
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((x) => x > 255)) return null;
    s =
      s.slice(0, s.length - v4[0].length) +
      ((o[0]! << 8) | o[1]!).toString(16) +
      ":" +
      ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x === "" ? [] : x.split(":"));
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

/**
 * The unit a sender is counted by: IPv4 address, or IPv6 /64 (an
 * IPv4-mapped IPv6 address counts as its IPv4 address). Anything
 * unparseable is one shared "unknown" bucket.
 */
export function sourceKey(ip: string): string {
  const t = ip.trim();
  const m4 = t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) return m4.slice(1).every((x) => Number(x) <= 255) ? `v4:${t}` : "unknown";
  if (!t.includes(":")) return "unknown";
  const g = expandIpv6(t);
  if (!g) return "unknown";
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
    return `v4:${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  return `v6:${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

/**
 * Bounded per-key failure counter (fixed window per key). peek() never
 * changes state; record() counts. When full, the OLDEST tracked key is
 * evicted: memory stays bounded and nobody is refused because of it.
 */
export function createFailureCounter(
  limit: number,
  windowSeconds: number,
  opts: { now?: () => number; maxKeys?: number } = {},
) {
  const now = opts.now ?? (() => Date.now());
  const maxKeys = opts.maxKeys ?? MAX_TRACKED_SOURCES;
  const entries = new Map<string, { start: number; count: number }>();
  const windowMs = windowSeconds * 1000;
  const live = (key: string, t: number) => {
    const e = entries.get(key);
    if (e && t - e.start >= windowMs) {
      entries.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    peek(key: string): RateLimitDecision {
      const t = now();
      const e = live(key, t);
      if (!e || e.count < limit) return { allowed: true, retryAfterSeconds: 0 };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((e.start + windowMs - t) / 1000)),
      };
    },
    record(key: string): void {
      const t = now();
      const e = live(key, t);
      if (e) {
        e.count++;
        return;
      }
      while (entries.size >= maxKeys) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(key, { start: t, count: 1 });
    },
    size: () => entries.size,
  };
}

/** Module-level so the counters live as long as the isolate. */
const failureCounters: Record<PreAuthScope, ReturnType<typeof createFailureCounter>> = {
  internal: createFailureCounter(
    VOICE_AGENT_LIMITS.internal.limit,
    VOICE_AGENT_LIMITS.internal.windowSeconds,
  ),
  webhook: createFailureCounter(
    VOICE_AGENT_LIMITS.webhook.limit,
    VOICE_AGENT_LIMITS.webhook.windowSeconds,
  ),
  cron: createFailureCounter(VOICE_AGENT_LIMITS.cron.limit, VOICE_AGENT_LIMITS.cron.windowSeconds),
};

export function tooManyRequests(d: RateLimitDecision): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(Math.max(1, d.retryAfterSeconds)),
    },
  });
}

/** Postgres key for a shared scope. Matches VOICE_AGENT_RATE_LIMIT_KEY_PATTERN. */
export const sharedLimitKey = (scope: SharedScope, key: string) => `voice_agent_${scope}:${key}`;

/** Production limiter: in-memory failure budgets + Postgres shared counters (lazy, server-only). */
export async function defaultVoiceAgentLimiter(): Promise<VoiceAgentLimiter> {
  const { createRateLimiter } = await import("../rate-limit.server.ts");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const shared = new Map<SharedScope, (key: string) => Promise<RateLimitDecision>>();
  const limiterFor = (scope: SharedScope) => {
    let l = shared.get(scope);
    if (!l) {
      l = createRateLimiter(
        {
          async increment(key, windowStart) {
            const { data, error } = await supabaseAdmin.rpc("increment_rate_limit", {
              _key: sharedLimitKey(scope, key),
              _window_start: new Date(windowStart * 1000).toISOString(),
            });
            if (error) throw error;
            return data as number;
          },
        },
        VOICE_AGENT_LIMITS[scope].limit,
        VOICE_AGENT_LIMITS[scope].windowSeconds,
      );
      shared.set(scope, l);
    }
    return l;
  };
  return {
    authFailureBudget: (scope, ip) => failureCounters[scope].peek(sourceKey(ip)),
    recordAuthFailure: (scope, ip) => failureCounters[scope].record(sourceKey(ip)),
    shared: (scope, key) => limiterFor(scope)(key),
  };
}
