import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { PermanentJobError, type QueueStore } from "./queue.server.ts";
import type { JobHandler } from "./runner.server.ts";
import type { ReconcileDeps } from "../sarvam-reconciliation.server.ts";

/**
 * Job kinds and their handlers. Deliberately absent: payment expiry (payment
 * enforcement is unchanged); a job of an unknown kind is dead-lettered, never run.
 *
 *   campaign.dispatch       dial due contacts of running campaigns (once a
 *                           minute); runs only when CAMPAIGN_DISPATCH_ENABLED=true
 *   sweep.sarvam_reconcile  find unresolved Sarvam outbound calls, enqueue one
 *                           sarvam.reconcile_call each (at most hourly per call);
 *                           flag single calls Sarvam never confirmed as outcome_unknown
 *   sarvam.reconcile_call   read Sarvam's attempt, resolve only a final outcome
 *   sweep.call_finalization find calls whose billing/campaign finalization is
 *                           due, enqueue one call.finalize each
 *   call.finalize           finalize one call (idempotent, leased in SQL)
 *   sweep.call_outcome_reconcile  record end-of-call outcomes Sarvam's on-end
 *                           tool never delivered, from the stored call-end
 *                           webhook (idempotent; see call-outcome-reconciliation)
 *   sweep.call_variable_retention  clear stored final agent variables once the
 *                           recovery window (and outbound finalization) is over
 *   jobs.prune              delete succeeded jobs older than 7 days
 */

// The runner times a job out at 20 s and one Sarvam start request can take 15 s,
// so new contacts are claimed only in the first few seconds of the job.
// shortcut: caps throughput at a few dials a minute; give dispatch its own job timeout before large campaigns.
export const CAMPAIGN_DISPATCH_CLAIM_WINDOW_MS = 3_000;

/** Outbound dialling is opt-in: only an explicit "true" turns campaign dispatch on. */
export function campaignDispatchEnabled(): boolean {
  return process.env["CAMPAIGN_DISPATCH_ENABLED"]?.trim().toLowerCase() === "true";
}

const RECONCILE_MIN_AGE_MS = 15 * 60 * 1000;
const RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 100;

export interface HandlerDeps {
  supabaseAdmin: SupabaseClient<Database>;
  store: QueueStore;
  now?: () => Date;
  /** Sarvam lookups and resolution; default to the real adapter / resolution path. */
  reconcile?: ReconcileDeps;
  finalize?: (callId: string) => Promise<{ state: string; error?: string }>;
  /** Stored call-variable expiry; defaults to expireCallVariables. */
  expireVariables?: (now: Date) => Promise<Record<string, unknown>>;
  /** End-of-call outcome recovery; defaults to reconcileCallOutcomes. */
  reconcileOutcomes?: (now: Date) => Promise<Record<string, unknown>>;
  /** Campaign dispatcher; defaults to dispatchDueCampaigns. */
  dispatchCampaigns?: (options: { deadline: number }) => Promise<Record<string, unknown>>;
}

const hourBucket = (d: Date) => d.toISOString().slice(0, 13);

async function defaultReconcileDeps(
  supabaseAdmin: SupabaseClient<Database>,
): Promise<ReconcileDeps> {
  const { getTelephonyAdapter } = await import("@/lib/telephony.server");
  const { SarvamTelephonyAdapter } = await import("@/lib/telephony/sarvam-provider.server");
  const { resolveUnknownSarvamCall } = await import("@/lib/sarvam-call-resolution.server");
  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter || !(adapter instanceof SarvamTelephonyAdapter))
    throw new Error("Sarvam is not configured on this server.");
  return {
    findAttempt: (appId, attemptId, since, until) =>
      adapter.findAttempt(appId, attemptId, since, until),
    resolve: (input) =>
      resolveUnknownSarvamCall(supabaseAdmin, {
        callId: input.callId,
        resolution: "placed",
        outcome: input.outcome,
        durationSeconds: input.durationSeconds,
        attemptId: input.attemptId,
        // Checked programmatically: Sarvam's own attempt record says it is final.
        confirmedCheckedInSarvam: true,
      }),
  };
}

export function buildJobHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const { supabaseAdmin, store } = deps;
  const now = () => deps.now?.() ?? new Date();

  return {
    "campaign.dispatch": async () => {
      if (!campaignDispatchEnabled()) return { skipped: "disabled" };
      // The global outbound kill switch stops campaign dialling as well.
      const { outboundCallingDisabled } = await import("../outbound-eligibility.server.ts");
      if (outboundCallingDisabled()) return { skipped: "outbound_disabled" };
      const dispatch =
        deps.dispatchCampaigns ??
        (async (options: { deadline: number }) => {
          const { dispatchDueCampaigns } = await import("../campaign-dispatch.server.ts");
          return (await dispatchDueCampaigns(options)) as unknown as Record<string, unknown>;
        });
      // Per-campaign failures are in the summary; the job itself succeeds, so
      // nothing is re-run before the next minute's dispatch.
      return dispatch({ deadline: now().getTime() + CAMPAIGN_DISPATCH_CLAIM_WINDOW_MS });
    },

    "sweep.sarvam_reconcile": async () => {
      const t = now();
      const { data, error } = await supabaseAdmin
        .from("call_logs")
        .select("id, organization_id")
        .eq("provider", "sarvam")
        .eq("direction", "outbound")
        .in("status", ["initiated", "outcome_unknown"])
        .not("provider_call_id", "is", null)
        .lt("started_at", new Date(t.getTime() - RECONCILE_MIN_AGE_MS).toISOString())
        .gt("started_at", new Date(t.getTime() - RECONCILE_MAX_AGE_MS).toISOString())
        .order("started_at", { ascending: true })
        .limit(SWEEP_LIMIT);
      if (error) throw error;
      let enqueued = 0;
      for (const call of data ?? []) {
        const r = await store.enqueue({
          kind: "sarvam.reconcile_call",
          payload: { callId: call.id },
          idempotencyKey: `sarvam.reconcile_call:${call.id}:${hourBucket(t)}`,
          organizationId: call.organization_id,
          maxAttempts: 3,
        });
        if (r.created) enqueued++;
      }
      // Starts Sarvam never confirmed have nothing to reconcile against; flag them instead.
      const { flagStartsWithoutAttempt, releaseOrphanedCampaignClaims } =
        await import("../sarvam-reconciliation.server.ts");
      const unconfirmed = await flagStartsWithoutAttempt(supabaseAdmin, t);
      const releasedClaims = await releaseOrphanedCampaignClaims(supabaseAdmin, t);
      return { candidates: data?.length ?? 0, enqueued, unconfirmed, releasedClaims };
    },

    "sarvam.reconcile_call": async (job) => {
      const callId = (job.payload as { callId?: unknown })?.callId;
      if (typeof callId !== "string") throw new PermanentJobError("payload.callId is required");
      const { reconcileSarvamCall } = await import("../sarvam-reconciliation.server.ts");
      const reconcileDeps = deps.reconcile ?? (await defaultReconcileDeps(supabaseAdmin));
      const result = await reconcileSarvamCall(supabaseAdmin, callId, reconcileDeps);
      if (result.state === "resolved")
        console.info("jobs:sarvam_call_reconciled", { callId, outcome: result.outcome });
      return result as unknown as Record<string, unknown>;
    },

    "sweep.call_finalization": async () => {
      const t = now();
      const { data, error } = await supabaseAdmin
        .from("call_logs")
        .select("id, organization_id, finalization_attempts")
        .eq("finalization_state", "pending")
        .lte("finalization_next_at", t.toISOString())
        .order("finalization_next_at", { ascending: true })
        .limit(SWEEP_LIMIT);
      if (error) throw error;
      let enqueued = 0;
      for (const call of data ?? []) {
        const r = await store.enqueue({
          kind: "call.finalize",
          payload: { callId: call.id },
          idempotencyKey: `call.finalize:${call.id}:${call.finalization_attempts}`,
          organizationId: call.organization_id,
          maxAttempts: 3,
        });
        if (r.created) enqueued++;
      }
      return { candidates: data?.length ?? 0, enqueued };
    },

    "call.finalize": async (job) => {
      const callId = (job.payload as { callId?: unknown })?.callId;
      if (typeof callId !== "string") throw new PermanentJobError("payload.callId is required");
      const finalize =
        deps.finalize ??
        (async (id: string) => {
          const { finalizeTerminalCall } = await import("@/lib/telephony/call-finalization.server");
          return finalizeTerminalCall(supabaseAdmin, id);
        });
      const result = await finalize(callId);
      // A failed finalization keeps its own state on the call for operators;
      // "skipped" means another holder's lease is live or it is already done.
      return {
        state: result.state,
        ...("error" in result && result.error ? { error: result.error } : {}),
      };
    },

    "sweep.call_outcome_reconcile": async () => {
      const reconcile =
        deps.reconcileOutcomes ??
        (async (at: Date) => {
          const { reconcileCallOutcomes } =
            await import("../call-outcome-reconciliation.server.ts");
          return (await reconcileCallOutcomes(supabaseAdmin, { now: at })) as unknown as Record<
            string,
            unknown
          >;
        });
      return reconcile(now());
    },

    "sweep.call_variable_retention": async () => {
      const expire =
        deps.expireVariables ??
        (async (at: Date) => {
          const { expireCallVariables } = await import("../call-variable-retention.server.ts");
          return (await expireCallVariables(supabaseAdmin, { now: at })) as unknown as Record<
            string,
            unknown
          >;
        });
      return expire(now());
    },

    "jobs.prune": async () => {
      const { data, error } = await supabaseAdmin.rpc("prune_jobs", {});
      if (error) throw error;
      return { removed: data ?? 0 };
    },
  };
}
