/**
 * Server-side abuse protection for the unauthenticated public assistant
 * endpoints (publicChat, publicVoiceTurn — see public-assistant.functions.ts).
 * Every call there triggers a real, billed Sarvam API request, so this must
 * run before that call, entirely server-side, and never depend on anything
 * the browser controls.
 *
 * `createRateLimiter` is pure/injectable (see rate-limit.server.test.ts) —
 * only `SupabaseRateLimitStore` below touches the network/database, using
 * `public.increment_rate_limit()` (migration 20260905090000) as the shared,
 * atomic, cross-isolate counter. This repository has no Cloudflare KV
 * namespace or Durable Object binding configured, so an in-memory counter
 * would reset independently per Worker isolate and not actually bound
 * abuse in production — Postgres is the safest mechanism already available
 * here. If a KV/Durable Object binding is added later, swap the store
 * implementation to remove the extra DB round-trip; until then this is the
 * production mechanism, not a placeholder.
 */
import { getRequest } from "@tanstack/react-start/server";
import { createHash } from "crypto";

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  /** Atomically increments the counter for (key, windowStart) and returns the new count. */
  increment(key: string, windowStart: number): Promise<number>;
}

/**
 * Builds a fixed-window rate limiter against an injectable store. Pure
 * aside from calling `store.increment`, so tests can supply an in-memory
 * fake instead of hitting Postgres.
 */
export function createRateLimiter(store: RateLimitStore, limit: number, windowSeconds: number) {
  return async function checkRateLimit(clientKey: string): Promise<RateLimitDecision> {
    const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
    let count: number;
    try {
      count = await store.increment(clientKey, windowStart);
    } catch (error) {
      // Fail closed: this gate protects a real, billed API call, so a
      // broken store must not silently become "no rate limit at all."
      console.error("rate_limit:store_failed", error);
      return { allowed: false, retryAfterSeconds: windowSeconds };
    }
    return {
      allowed: count <= limit,
      retryAfterSeconds: count <= limit ? 0 : windowSeconds,
    };
  };
}

class SupabaseRateLimitStore implements RateLimitStore {
  private readonly scope: string;

  constructor(scope: string) {
    this.scope = scope;
  }

  async increment(key: string, windowStart: number): Promise<number> {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.rpc("increment_rate_limit", {
      _key: `${this.scope}:${key}`,
      _window_start: new Date(windowStart * 1000).toISOString(),
    });
    if (error) throw error;
    return data as number;
  }
}

/** Stable-but-not-reversible-in-practice per-visitor key, derived from IP only. */
export function getClientIdentity(): string {
  let request: Request | null = null;
  try {
    request = getRequest();
  } catch {
    request = null;
  }
  const ip =
    request?.headers.get("cf-connecting-ip") ??
    request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  return createHash("sha256").update(ip).digest("hex");
}

const WINDOW_SECONDS = 600; // 10 minutes
const CHAT_LIMIT = 20;
// Voice turns cost more (STT + LLM + TTS per call), so a tighter limit.
const VOICE_LIMIT = 8;

export const checkChatRateLimit = createRateLimiter(
  new SupabaseRateLimitStore("chat"),
  CHAT_LIMIT,
  WINDOW_SECONDS,
);
export const checkVoiceRateLimit = createRateLimiter(
  new SupabaseRateLimitStore("voice"),
  VOICE_LIMIT,
  WINDOW_SECONDS,
);
