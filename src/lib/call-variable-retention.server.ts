import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { OUTCOME_RECONCILE_MAX_AGE_MS } from "./call-outcome-reconciliation.server.ts";
import {
  RAW_PROVIDER_METADATA_MARKERS,
  sanitizeProviderMetadata,
} from "./telephony/webhook-correlation.server.ts";

/**
 * Clears a Sarvam call's stored final agent variables
 * (call_logs.final_agent_variables) once nothing can still need them. Only
 * that one column is set to NULL: the call log, its transcript and summary,
 * outcome rows (sarvam_agent_events), leads, audit records and opt-out state
 * (contacts.opted_out, campaign_contacts) are never touched.
 *
 * Never early:
 *   - inbound: only after the end-of-call recovery window
 *     (OUTCOME_RECONCILE_MAX_AGE_MS, seven days) plus a grace period, so the
 *     five-minute reconciliation has had every chance to record the outcome;
 *   - outbound: additionally only once finalization is done
 *     (finalization_state = 'done'); a pending or failed finalization keeps
 *     them for its retry.
 *
 * Idempotent and safe to run concurrently: it selects candidates, then clears
 * them with the same conditions re-checked in the UPDATE, so overlapping runs
 * clear each row at most once and never anything newer than the cutoff.
 *
 * The same job also sanitizes provider_metadata on older Sarvam call logs
 * written before it was restricted to identifiers (the raw webhook payload:
 * every agent variable, the transcript, both phone numbers and, outbound,
 * ClickAI's webhook token). Only rows that still carry a raw-payload marker
 * are touched, and each is rewritten to the allowlist
 * (sanitizeProviderMetadata: interaction_id, recording_url, app_id,
 * late_provider_report) only if it has not changed since it was read
 * (updated_at), so a concurrent writer is never overwritten.
 */

type Admin = SupabaseClient<Database>;

/** One hour after the recovery window closes, so the last sweeps of the window have run. */
export const CALL_VARIABLE_RETENTION_GRACE_MS = 60 * 60 * 1000;
export const CALL_VARIABLE_RETENTION_MS =
  OUTCOME_RECONCILE_MAX_AGE_MS + CALL_VARIABLE_RETENTION_GRACE_MS;
export const CALL_VARIABLE_RETENTION_BATCH = 200;

export interface CallVariableRetentionSummary {
  inboundCleared: number;
  outboundCleared: number;
  /** Older call logs whose provider_metadata was reduced to its identifiers. */
  metadataSanitized: number;
}

/** PostgREST filter: provider_metadata still holds any raw-payload key. */
const RAW_METADATA_FILTER = RAW_PROVIDER_METADATA_MARKERS.map(
  (key) => `provider_metadata->${key}.not.is.null`,
).join(",");

async function sanitizeMetadataBatch(admin: Admin, cutoff: string, limit: number): Promise<number> {
  const { data: rows, error } = await admin
    .from("call_logs")
    .select("id, updated_at, provider_metadata")
    .eq("provider", "sarvam")
    .lt("ended_at", cutoff)
    .or(RAW_METADATA_FILTER)
    .order("ended_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  let sanitized = 0;
  for (const row of rows ?? []) {
    const { data: updated, error: updateError } = await admin
      .from("call_logs")
      .update({ provider_metadata: sanitizeProviderMetadata(row.provider_metadata) as never })
      .eq("id", row.id)
      .eq("updated_at", row.updated_at) // unchanged since read: never overwrite a concurrent write
      .select("id");
    if (updateError) throw updateError;
    sanitized += updated?.length ?? 0;
  }
  return sanitized;
}

async function clearBatch(
  admin: Admin,
  direction: "inbound" | "outbound",
  cutoff: string,
  limit: number,
): Promise<number> {
  let candidatesQuery = admin
    .from("call_logs")
    .select("id")
    .eq("provider", "sarvam")
    .eq("direction", direction)
    .not("final_agent_variables", "is", null)
    .lt("ended_at", cutoff);
  if (direction === "outbound") candidatesQuery = candidatesQuery.eq("finalization_state", "done");
  const { data: candidates, error } = await candidatesQuery
    .order("ended_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  const ids = (candidates ?? []).map((c) => c.id);
  if (ids.length === 0) return 0;

  // The same conditions again, so a row that changed meanwhile is left alone.
  let clearQuery = admin
    .from("call_logs")
    .update({ final_agent_variables: null })
    .in("id", ids)
    .eq("provider", "sarvam")
    .eq("direction", direction)
    .not("final_agent_variables", "is", null)
    .lt("ended_at", cutoff);
  if (direction === "outbound") clearQuery = clearQuery.eq("finalization_state", "done");
  const { data: cleared, error: clearError } = await clearQuery.select("id");
  if (clearError) throw clearError;
  return cleared?.length ?? 0;
}

export async function expireCallVariables(
  admin: Admin,
  options: { now?: Date; limit?: number } = {},
): Promise<CallVariableRetentionSummary> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - CALL_VARIABLE_RETENTION_MS).toISOString();
  const limit = options.limit ?? CALL_VARIABLE_RETENTION_BATCH;
  return {
    inboundCleared: await clearBatch(admin, "inbound", cutoff, limit),
    outboundCleared: await clearBatch(admin, "outbound", cutoff, limit),
    metadataSanitized: await sanitizeMetadataBatch(admin, cutoff, limit),
  };
}
