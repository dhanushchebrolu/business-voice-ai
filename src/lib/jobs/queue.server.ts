import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

/**
 * Client for the durable job queue (migration 20261111090200): every call is
 * one of the queue's SQL functions, which own idempotency, leasing, fencing,
 * backoff and dead-lettering. Nothing here reimplements those rules.
 */

export type Job = Database["public"]["Tables"]["jobs"]["Row"];

export interface EnqueueInput {
  kind: string;
  payload?: Record<string, unknown>;
  /** Same key → same job, however many times it is enqueued. */
  idempotencyKey: string;
  organizationId?: string | null;
  runAt?: Date;
  maxAttempts?: number;
}

export interface QueueStore {
  enqueue(input: EnqueueInput): Promise<{ id: string; created: boolean }>;
  claim(worker: string, limit: number, leaseSeconds: number): Promise<Job[]>;
  complete(id: string, worker: string, result: Record<string, unknown> | null): Promise<boolean>;
  /** "queued" (will retry), "dead" (dead-lettered) or "not_owner" (lease lost). */
  fail(id: string, worker: string, error: string, retryable: boolean): Promise<string>;
}

export function supabaseQueueStore(supabaseAdmin: SupabaseClient<Database>): QueueStore {
  return {
    async enqueue(input) {
      const { data, error } = await supabaseAdmin.rpc("enqueue_job", {
        _kind: input.kind,
        _payload: (input.payload ?? {}) as Json,
        _idempotency_key: input.idempotencyKey,
        ...(input.organizationId ? { _organization_id: input.organizationId } : {}),
        ...(input.runAt ? { _run_at: input.runAt.toISOString() } : {}),
        ...(input.maxAttempts ? { _max_attempts: input.maxAttempts } : {}),
      });
      if (error) throw error;
      const row = data?.[0];
      if (!row) throw new Error("enqueue_job returned nothing");
      return { id: row.id, created: row.created };
    },
    async claim(worker, limit, leaseSeconds) {
      const { data, error } = await supabaseAdmin.rpc("claim_jobs", {
        _worker: worker,
        _limit: limit,
        _lease_seconds: leaseSeconds,
      });
      if (error) throw error;
      return data ?? [];
    },
    async complete(id, worker, result) {
      const { data, error } = await supabaseAdmin.rpc("complete_job", {
        _id: id,
        _worker: worker,
        ...(result ? { _result: result as Json } : {}),
      });
      if (error) throw error;
      return data === true;
    },
    async fail(id, worker, message, retryable) {
      const { data, error } = await supabaseAdmin.rpc("fail_job", {
        _id: id,
        _worker: worker,
        _error: message,
        _retryable: retryable,
      });
      if (error) throw error;
      return String(data);
    },
  };
}

/** A failure that retrying cannot fix (bad payload, missing row): dead-letter immediately. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
