import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { ConversationStats } from "./conversation-counter.ts";

type Row = {
  completed_seconds: number | string;
  active_calls: number | string;
  active_elapsed_seconds: number | string;
};

/**
 * public_conversation_stats() (migration 20261130090000): one row of three
 * aggregates across every organization. The only thing the public endpoint
 * ever returns; no call, tenant or number is read here.
 */
export async function loadConversationStats(
  db: SupabaseClient<Database>,
): Promise<ConversationStats> {
  const rpc = db.rpc.bind(db) as unknown as (
    fn: string,
  ) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
  const { data, error } = await rpc("public_conversation_stats");
  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row) throw new Error("public_conversation_stats returned no row");
  // bigint arrives as a string from PostgREST.
  return {
    completedSeconds: Number(row.completed_seconds),
    activeCalls: Number(row.active_calls),
    activeElapsedSeconds: Number(row.active_elapsed_seconds),
  };
}

/**
 * Visitors never reach the database directly: one read serves everyone for
 * `ttlMs` (per Worker instance), and a failed refresh keeps serving the last
 * good value.
 * shortcut: per-instance cache and a full sum on refresh; move to a rolled-up
 * total table when call_logs gets large enough that the sum shows in query times.
 */
export function cachedStatsLoader(
  load: () => Promise<ConversationStats>,
  ttlMs: number,
  now: () => number = Date.now,
) {
  let value: ConversationStats | null = null;
  let at = 0;
  let inflight: Promise<ConversationStats> | null = null;
  return async (): Promise<ConversationStats> => {
    if (value && now() - at < ttlMs) return value;
    inflight ??= load()
      .then((v) => {
        value = v;
        at = now();
        return v;
      })
      .finally(() => {
        inflight = null;
      });
    try {
      return await inflight;
    } catch (err) {
      if (value) return value;
      throw err;
    }
  };
}
