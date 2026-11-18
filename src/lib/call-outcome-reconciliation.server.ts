import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { finalCallVariables } from "./call-variables.ts";
import {
  checkInboundAdmission,
  type AdmissionInput,
  type AdmissionResult,
} from "./sarvam-inbound-admission.server.ts";
import {
  completeDueLead,
  recordCallOutcome,
  type AgentApiDeps,
  type AuthenticatedIntegration,
} from "./sarvam-agent-api.server.ts";

/**
 * Recovers end-of-call outcomes Sarvam's on-end tool (record_call_outcome)
 * never delivered — a timeout, a 5xx, a dropped connection — without
 * assuming Sarvam retries it.
 *
 * Source: the inbound call-end webhook, a separate delivery that ClickAI
 * already stores (call_logs, with the call's final agent variables). Any
 * completed Sarvam inbound call that has final variables but no call_outcome
 * row is replayed through recordCallOutcome — the same idempotent path the
 * tool uses — with the caller number ClickAI recorded from the webhook.
 *
 * Idempotent: the outcome row is once per (integration, interaction)
 * (idx_sarvam_agent_events_one_outcome), the call's lead has a deterministic
 * id (a repeat finds it), and lead suppression is a repeatable update. A late
 * tool call after a recovery simply finds the outcome and returns duplicate.
 *
 * Second phase (outbox): an outcome row whose due lead (detail.lead) was never
 * saved — the process stopped between the two writes — is completed here,
 * whether the row came from the tool or from a recovery.
 *
 * Contact-wide do-not-call is NOT applied here: an inbound caller's identity
 * is unverified. Outbound campaign opt-outs reach contacts.opted_out through
 * call finalization (apply_call_campaign_outcome), which has its own sweep.
 */

type Admin = SupabaseClient<Database>;

export const OUTCOME_RECONCILE_MIN_AGE_MS = 10 * 60 * 1000; // give the tool call time to land first
export const OUTCOME_RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const OUTCOME_RECONCILE_LIMIT = 100;
/** Pages per phase per run (keyset by id), so every eligible row in the window is reached. */
export const OUTCOME_RECONCILE_MAX_PAGES = 50;
/** Evenly spaced starting ids; the start moves one step per five-minute run. */
export const OUTCOME_RECONCILE_ROTATION_POINTS = 64;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Where this run starts reading, in id order: one of
 * OUTCOME_RECONCILE_ROTATION_POINTS evenly spaced ids, advancing one step per
 * five-minute run. Each run reads ids after the start, then wraps around to
 * the ids up to it, within its page budget. So even when more rows are
 * eligible than one run can read, every row is read within
 * OUTCOME_RECONCILE_ROTATION_POINTS runs (about 5 hours 20 minutes), provided
 * the window holds at most ROTATION_POINTS x budget rows (320,000 at the
 * defaults). Deterministic: the start depends only on the run's time.
 */
export function reconcileRotationStart(now: Date): string {
  const step =
    Math.floor(now.getTime() / RECONCILE_INTERVAL_MS) % OUTCOME_RECONCILE_ROTATION_POINTS;
  const firstByte = Math.floor((step * 256) / OUTCOME_RECONCILE_ROTATION_POINTS);
  return `${firstByte.toString(16).padStart(2, "0")}000000-0000-0000-0000-000000000000`;
}

/**
 * Reads rows in keyset pages by id (unique), starting after `start` and
 * wrapping around to the rows up to it, until `maxPages` pages are read or no
 * rows are left. `fetch` returns one page: ids greater than `after` (when
 * set) and at most `upTo` (when set), in id order, at most `limit` rows.
 */
async function rotatingPages<T extends { id: string }>(
  start: string,
  limit: number,
  maxPages: number,
  fetch: (after: string | null, upTo: string | null) => Promise<T[]>,
  onPage: (rows: T[]) => Promise<void>,
): Promise<void> {
  let pages = 0;
  for (const [first, upTo] of [
    [start, null],
    [null, start],
  ] as const) {
    let after: string | null = first;
    while (pages < maxPages) {
      const rows = await fetch(after, upTo);
      pages++;
      if (rows.length > 0) await onPage(rows);
      if (rows.length < limit) break;
      after = rows[rows.length - 1]!.id;
    }
  }
}

export interface OutcomeReconcileSummary {
  candidates: number;
  recorded: number;
  duplicates: number;
  noIntegration: number;
  /** Calls or due leads skipped: workspace not admitted, or the check failed. */
  notAdmitted: number;
  /** Due leads (outbox entries) completed by this run. */
  leadsCompleted: number;
  errors: number;
}

const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** The organization's active agent integration, as the tool endpoint would see it. */
async function integrationFor(
  admin: Admin,
  organizationId: string,
  now: Date,
): Promise<AuthenticatedIntegration | null> {
  const { data: row, error } = await admin
    .from("sarvam_agent_integrations")
    .select("id, organization_id, agent_config_id, status, expires_at, test_caller_numbers")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return null;
  const { data: agent, error: agentError } = await admin
    .from("agent_configs")
    .select("organization_id, business_id")
    .eq("id", row.agent_config_id)
    .maybeSingle();
  if (agentError) throw agentError;
  if (!agent || agent.organization_id !== row.organization_id) return null;
  return {
    integrationId: row.id,
    organizationId: row.organization_id,
    agentConfigId: row.agent_config_id,
    businessId: agent.business_id,
    testCallerNumbers: row.test_caller_numbers ?? [],
  };
}

type AdmissionCheck = (admin: Admin, input: AdmissionInput) => Promise<AdmissionResult>;

export async function reconcileCallOutcomes(
  admin: Admin,
  options: {
    now?: Date;
    limit?: number;
    /** The inbound admission gate; defaults to the one the tool endpoint uses. */
    admission?: AdmissionCheck;
    /** Page budget per phase per run (default OUTCOME_RECONCILE_MAX_PAGES). */
    maxPages?: number;
  } = {},
): Promise<OutcomeReconcileSummary> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? OUTCOME_RECONCILE_LIMIT;
  const summary: OutcomeReconcileSummary = {
    candidates: 0,
    recorded: 0,
    duplicates: 0,
    noIntegration: 0,
    notAdmitted: 0,
    leadsCompleted: 0,
    errors: 0,
  };
  const admission = options.admission ?? checkInboundAdmission;
  const integrations = new Map<string, AuthenticatedIntegration | null>();
  const admitted = new Map<string, boolean>();
  /**
   * The workspace's integration, and whether it passes the same inbound
   * admission gate the tool endpoint enforces — checked once per workspace per
   * run. A denied or erroring check skips that workspace's calls this run;
   * nothing is written, so they stay eligible for a later run in the window.
   */
  const authFor: AuthFor = async (organizationId) => {
    if (!integrations.has(organizationId))
      integrations.set(organizationId, await integrationFor(admin, organizationId, now));
    const auth = integrations.get(organizationId) ?? null;
    if (!auth) return { auth: null, admitted: false };
    if (!admitted.has(organizationId)) {
      let ok = false;
      try {
        const result = await admission(admin, {
          organizationId: auth.organizationId,
          agentConfigId: auth.agentConfigId,
        });
        ok = result.admitted;
      } catch {
        ok = false;
      }
      admitted.set(organizationId, ok);
    }
    return { auth, admitted: admitted.get(organizationId)! };
  };
  const deps: AgentApiDeps = { supabaseAdmin: admin, now: () => now };
  const paging = {
    start: reconcileRotationStart(now),
    limit,
    maxPages: options.maxPages ?? OUTCOME_RECONCILE_MAX_PAGES,
  };
  await recoverMissingOutcomes(admin, now, paging, summary, authFor, deps);
  await completeDueLeads(admin, now, paging, summary, authFor, deps);
  return summary;
}

type Paging = { start: string; limit: number; maxPages: number };

type AuthFor = (
  organizationId: string,
) => Promise<{ auth: AuthenticatedIntegration | null; admitted: boolean }>;

type CallRow = {
  id: string;
  organization_id: string;
  provider_call_id: string | null;
  caller_number: string | null;
  final_agent_variables: unknown;
};

async function recoverMissingOutcomes(
  admin: Admin,
  now: Date,
  paging: Paging,
  summary: OutcomeReconcileSummary,
  authFor: AuthFor,
  deps: AgentApiDeps,
): Promise<void> {
  await rotatingPages<CallRow>(
    paging.start,
    paging.limit,
    paging.maxPages,
    async (after, upTo) => {
      let query = admin
        .from("call_logs")
        .select("id, organization_id, provider_call_id, caller_number, final_agent_variables")
        .eq("provider", "sarvam")
        .eq("direction", "inbound")
        .eq("status", "completed")
        .not("provider_call_id", "is", null)
        .not("final_agent_variables", "is", null)
        .lt("ended_at", new Date(now.getTime() - OUTCOME_RECONCILE_MIN_AGE_MS).toISOString())
        .gt("ended_at", new Date(now.getTime() - OUTCOME_RECONCILE_MAX_AGE_MS).toISOString());
      if (after) query = query.gt("id", after);
      if (upTo) query = query.lte("id", upTo);
      const { data, error } = await query.order("id", { ascending: true }).limit(paging.limit);
      if (error) throw error;
      return (data ?? []) as CallRow[];
    },
    (calls) => recoverPage(admin, calls, summary, authFor, deps),
  );
}

async function recoverPage(
  admin: Admin,
  calls: CallRow[],
  summary: OutcomeReconcileSummary,
  authFor: AuthFor,
  deps: AgentApiDeps,
): Promise<void> {
  // Calls whose outcome is already recorded (by the tool or an earlier run) are skipped.
  const { data: recorded, error: recordedError } = await admin
    .from("sarvam_agent_events")
    .select("organization_id, interaction_id")
    .eq("kind", "call_outcome")
    .in(
      "interaction_id",
      calls.map((c) => c.provider_call_id!),
    );
  if (recordedError) throw recordedError;
  const done = new Set((recorded ?? []).map((r) => `${r.organization_id}:${r.interaction_id}`));
  const missing = calls.filter((c) => !done.has(`${c.organization_id}:${c.provider_call_id}`));
  summary.candidates += missing.length;

  for (const call of missing) {
    try {
      const { auth, admitted } = await authFor(call.organization_id);
      if (!auth) {
        summary.noIntegration++;
        continue;
      }
      if (!admitted) {
        summary.notAdmitted++; // nothing written: still eligible on a later run
        continue;
      }
      const vars = finalCallVariables(call.final_agent_variables) ?? {};
      const result = await recordCallOutcome(deps, auth, call.provider_call_id!, {
        outcome: text(vars["call_outcome"], 100),
        summary: text(vars["call_summary"], 2000),
        customerName: text(vars["customer_name"], 200),
        callerNumber: call.caller_number ?? undefined,
        interest: text(vars["caller_interest"], 200),
        requestedSlot: text(vars["requested_slot"], 200),
        optedOut: vars["opted_out"],
        source: "reconciliation",
      });
      if (result.duplicate) summary.duplicates++;
      else summary.recorded++;
    } catch (err) {
      summary.errors++;
      console.error("call_outcome_reconcile:failed", call.id, (err as Error).message);
    }
  }
}

/**
 * Outcome rows (any source) whose due lead was never saved: save it now. The
 * query selects exactly those rows (detail.lead set, detail.lead_id not), read
 * with the same rotating keyset as the calls, so rows that keep failing never
 * crowd out newer due leads.
 */
async function completeDueLeads(
  admin: Admin,
  now: Date,
  paging: Paging,
  summary: OutcomeReconcileSummary,
  authFor: AuthFor,
  deps: AgentApiDeps,
): Promise<void> {
  type DueRow = {
    id: string;
    organization_id: string;
    integration_id: string;
    interaction_id: string | null;
    detail: unknown;
  };
  await rotatingPages<DueRow>(
    paging.start,
    paging.limit,
    paging.maxPages,
    async (after, upTo) => {
      let query = admin
        .from("sarvam_agent_events")
        .select("id, organization_id, integration_id, interaction_id, detail")
        .eq("kind", "call_outcome")
        .not("detail->lead", "is", null)
        .is("detail->lead_id", null)
        .not("interaction_id", "is", null)
        .gt("created_at", new Date(now.getTime() - OUTCOME_RECONCILE_MAX_AGE_MS).toISOString());
      if (after) query = query.gt("id", after);
      if (upTo) query = query.lte("id", upTo);
      const { data, error } = await query.order("id", { ascending: true }).limit(paging.limit);
      if (error) throw error;
      return (data ?? []) as DueRow[];
    },
    async (rows) => {
      for (const row of rows) {
        const detail = (row.detail ?? {}) as Record<string, unknown>;
        try {
          const { auth, admitted } = await authFor(row.organization_id);
          if (!auth) {
            summary.noIntegration++;
            continue;
          }
          if (!admitted) {
            summary.notAdmitted++;
            continue;
          }
          const leadId = await completeDueLead(deps, auth, {
            id: row.id,
            integration_id: row.integration_id,
            interaction_id: row.interaction_id!,
            detail,
          });
          if (leadId) summary.leadsCompleted++;
        } catch (err) {
          summary.errors++;
          console.error("call_outcome_reconcile:lead_failed", row.id, (err as Error).message);
        }
      }
    },
  );
}
