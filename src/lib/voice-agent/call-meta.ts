/**
 * Shared, dependency-free helpers for the voice-agent call row
 * (call_logs, provider "livekit_sip") used by the session/billing code
 * (sessions.server.ts) and the room sweep (room-sweep.server.ts).
 *
 * Optimistic concurrency on provider_metadata (Phase 2.11, F6). Several
 * writers rewrite the whole JSON object from a copy they read earlier:
 * billing (billing, billing_lease, billing_source), the agent's end report
 * (agent_ended_at) and the room sweep (room_sweep*). Each such write is
 * conditional on EVERY key that any of those writers changes still having
 * the value it read (GUARDED_META_KEYS), so a write based on a stale copy
 * matches no row instead of silently undoing another writer's change; the
 * writer then re-reads and retries (mergeCallMeta). Under PostgreSQL's READ
 * COMMITTED, a concurrent UPDATE re-evaluates its WHERE clause against the
 * committed row, so exactly one of two racing conditional writes wins
 * (verified in supabase/migrations/voice_agent_room_sweep.pg.test.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type Client = SupabaseClient<Database>;
export type CallLog = Database["public"]["Tables"]["call_logs"]["Row"];
export type CallUpdate = Database["public"]["Tables"]["call_logs"]["Update"];
export type Meta = Record<string, unknown>;

/** Statuses of a call that has not ended (call_logs_status_check). */
export const ACTIVE_STATUSES = ["initiated", "ringing", "answered", "in_progress"];

/** Upper bound of any call duration klyro accepts or bills (seconds). */
export const MAX_CALL_SECONDS_CEILING = 7200;
/** klyro's default maximum call duration (VOICE_AGENT_MAX_CALL_SECONDS). */
export const DEFAULT_MAX_CALL_SECONDS = 1800;

/** klyro's maximum call duration: VOICE_AGENT_MAX_CALL_SECONDS (60..7200, default 1800). */
export function maxCallSecondsFromEnv(value: string | undefined): number {
  const n = Number(value);
  return value && Number.isInteger(n) && n >= 60 && n <= MAX_CALL_SECONDS_CEILING
    ? n
    : DEFAULT_MAX_CALL_SECONDS;
}

/** A valid duration limit (integer seconds in 60..7200), or null. */
export function validMaxCallSeconds(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 60 && v <= MAX_CALL_SECONDS_CEILING
    ? v
    : null;
}

export const meta = (row: { provider_metadata?: unknown } | null | undefined): Meta =>
  row?.provider_metadata &&
  typeof row.provider_metadata === "object" &&
  !Array.isArray(row.provider_metadata)
    ? { ...(row.provider_metadata as Meta) }
    : {};

/** provider_metadata keys written by more than one writer (see header). */
export const GUARDED_META_KEYS = [
  "billing",
  "billing_lease",
  "agent_ended_at",
  "room_sweep",
  "room_sweep_lease",
] as const;

/** A PostgREST call that returned an error (as opposed to matching no row). */
export class DbError extends Error {
  readonly op: string;
  constructor(op: string, message: string) {
    super(`${op}: ${message}`.slice(0, 300));
    this.op = op;
  }
}

/** Throws DbError when PostgREST reported an error; returns the data otherwise. */
export function checked<T>(op: string, r: { data: T; error?: { message?: string } | null }): T {
  if (r.error) throw new DbError(op, r.error.message ?? "unknown database error");
  return r.data;
}

type Filterable = {
  eq: (k: string, v: unknown) => Filterable;
  is: (k: string, v: null) => Filterable;
  in: (k: string, v: unknown[]) => Filterable;
  select: (cols: string) => PromiseLike<{ data: unknown; error?: { message?: string } | null }>;
};

/** Adds "each guarded key still has the value in `m`" to an UPDATE's WHERE clause. */
export function guardMeta<Q>(q: Q, m: Meta): Q {
  let out = q as unknown as Filterable;
  for (const k of GUARDED_META_KEYS) {
    const v = m[k];
    out =
      typeof v === "string"
        ? out.eq(`provider_metadata->>${k}`, v)
        : out.is(`provider_metadata->>${k}`, null);
  }
  return out as unknown as Q;
}

/**
 * One conditional UPDATE of `row` as read: matches only while the guarded
 * metadata keys are unchanged, and either the call is still active
 * (requireActive) or its status is unchanged. Returns the updated row, or
 * null on a conflict (another writer changed the row first). Throws DbError
 * on a database error.
 */
export async function casUpdateCall(
  db: Client,
  row: CallLog,
  update: CallUpdate,
  opts: { requireActive?: boolean; op?: string } = {},
): Promise<CallLog | null> {
  let q = db.from("call_logs").update(update).eq("id", row.id) as unknown as Filterable;
  q = opts.requireActive
    ? q.in("status", ACTIVE_STATUSES).is("ended_at", null)
    : q.eq("status", row.status);
  q = guardMeta(q, meta(row));
  const data = checked(opts.op ?? "call_logs.cas_update", await q.select("*"));
  return (data as CallLog[] | null)?.[0] ?? null;
}

export async function readCall(
  db: Client,
  id: string,
  op = "call_logs.read",
): Promise<CallLog | null> {
  const r = await db.from("call_logs").select("*").eq("id", id).maybeSingle();
  return checked(op, r as { data: CallLog | null; error?: { message?: string } | null });
}

/**
 * Read-modify-write of one call row with retries on conflict. `build` sees
 * the CURRENT row and returns the update to apply, or null to give up (the
 * precondition no longer holds). Returns the updated row, or null.
 */
export async function mergeCall(
  db: Client,
  id: string,
  build: (fresh: CallLog) => { update: CallUpdate; requireActive?: boolean } | null,
  op: string,
  tries = 3,
): Promise<CallLog | null> {
  for (let i = 0; i < tries; i++) {
    const fresh = await readCall(db, id, `${op}.read`);
    if (!fresh) return null;
    const plan = build(fresh);
    if (!plan) return null;
    const done = await casUpdateCall(db, fresh, plan.update, {
      ...(plan.requireActive ? { requireActive: true } : {}),
      op,
    });
    if (done) return done;
  }
  return null;
}
