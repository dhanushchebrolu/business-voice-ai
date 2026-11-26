import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import type { ProvisionOrganizationResult } from "./provisioning-orchestrator.server.ts";
import { runProvisioningPipeline, type PipelineResult } from "./provisioning-pipeline.server.ts";
import {
  JOB_STEP_KEYS,
  MAX_AUTOMATIC_ATTEMPTS,
  backoffMs,
  beginStep,
  CUSTOMER_PROBLEM,
  CUSTOMER_RETRYING,
  classifyOutcome,
  endStep,
  sanitizeDiagnostic,
  type FailureCode,
  type JobStepKey,
  type StepStates,
} from "./voice-provisioning-job.ts";

/**
 * Persistent, resumable provisioning (provisioning_runs, migration
 * 20261114100000). Each organization has at most one active run
 * (pending/running/waiting), enforced by a partial unique index, so
 * duplicate payment events, a payment racing an admin retry, or two Worker
 * isolates can never provision the same organization twice in parallel.
 *
 * A run is claimed with a conditional update before any work starts; a run
 * already "running" is left alone unless it has not moved for
 * STALE_RUNNING_MS (a crashed attempt), in which case it is reclaimed.
 *
 * It is also the automated Voice AI provisioning JOB (migration
 * 20261203090000): per-step state (step_states, current_job_step,
 * last_checkpoint), failure code + retryability, bounded automatic retries
 * with backoff (pending + next_attempt_at = "retrying"), customer-safe
 * message, sanitized diagnostics and an event trail (provisioning_run_events).
 * The pipeline re-reads real provider/DB state every attempt, so resuming
 * "from the last checkpoint" never repeats or duplicates finished work.
 */

export type ProvisioningTrigger =
  "setup_fee" | "phone_service_fee" | "admin_retry" | "customer_activate";
export type ProvisioningRunStatus = "pending" | "running" | "waiting" | "succeeded" | "failed";

export const ACTIVE_RUN_STATUSES = ["pending", "running", "waiting"] as const;
export const STALE_RUNNING_MS = 10 * 60 * 1000;

type Admin = SupabaseClient<Database>;
export interface OrchestrateHooks {
  /** The pipeline reports each step as it starts; the job persists it. */
  onStep: (key: JobStepKey) => Promise<void>;
}
type Orchestrate = (
  admin: Admin,
  organizationId: string,
  hooks: OrchestrateHooks,
) => Promise<ProvisionOrganizationResult>;

export interface RunProvisioningInput {
  organizationId: string;
  trigger: ProvisioningTrigger;
  sourcePaymentId?: string | null;
  createdBy?: string | null;
  /** What the job was started for (default "<trigger>:<organization>"); kept for traceability. */
  idempotencyKey?: string;
  /** Admin retry: run now even if an automatic retry is scheduled for later. */
  force?: boolean;
}

export interface RunProvisioningResult {
  runId: string;
  /** false when another attempt holds the run (or a retry is scheduled); nothing was done. */
  claimed: boolean;
  status: ProvisioningRunStatus | "running";
  result: ProvisionOrganizationResult | null;
}

/** Maps the orchestrator's state onto the run lifecycle. */
export function runStatusFor(result: ProvisionOrganizationResult): ProvisioningRunStatus {
  if (result.state === "active") return "succeeded";
  if (
    result.state === "failed" ||
    result.state === "verification_failed" ||
    result.state === "manual_action_required"
  )
    return "failed";
  return "waiting";
}

async function findOrCreateActiveRun(admin: Admin, input: RunProvisioningInput): Promise<string> {
  const find = async () => {
    const { data, error } = await admin
      .from("provisioning_runs")
      .select("id")
      .eq("organization_id", input.organizationId)
      .in("status", [...ACTIVE_RUN_STATUSES])
      .maybeSingle();
    if (error) throw error;
    return data?.id ?? null;
  };

  const existing = await find();
  if (existing) return existing;

  const { data, error } = await admin
    .from("provisioning_runs")
    .insert({
      organization_id: input.organizationId,
      trigger: input.trigger,
      source_payment_id: input.sourcePaymentId ?? null,
      created_by: input.createdBy ?? null,
      idempotency_key: input.idempotencyKey ?? `${input.trigger}:${input.organizationId}`,
      status: "pending",
      attempts: 0,
    })
    .select("id")
    .single();
  if (!error) return data.id;
  // Lost a race with a concurrent caller: use the run it created.
  if ((error as { code?: string }).code === "23505") {
    const winner = await find();
    if (winner) return winner;
  }
  throw error;
}

/** Event trail; a failed write is logged, never allowed to break provisioning. */
async function addEvent(
  admin: Admin,
  run: { id: string; organizationId: string },
  event: string,
  step: string | null,
  detail?: Record<string, unknown>,
) {
  const { error } = await admin.from("provisioning_run_events").insert({
    run_id: run.id,
    organization_id: run.organizationId,
    step,
    event,
    detail: (detail ?? null) as Json | null,
  });
  if (error) console.error("provisioning_runs:event_write_failed", event, error.message);
}

const lastDoneStep = (states: StepStates): string | null =>
  [...JOB_STEP_KEYS].reverse().find((k) => states[k]?.status === "done") ?? null;

/**
 * What a waiting job is waiting ON, per customer: when the agent, the voice settings and the
 * tool-authentication confirmation last changed (database timestamps only, so no clock skew).
 * A run records the marker it saw BEFORE working, so a change made while it was running still
 * counts as news afterwards.
 */
async function changeMarks(admin: Admin, organizationIds: string[]) {
  const [agents, voices, confirms] = await Promise.all([
    admin
      .from("agent_configs")
      .select("organization_id, sarvam_app_id, updated_at")
      .in("organization_id", organizationIds),
    admin
      .from("agent_voice_language_settings")
      .select("organization_id, updated_at")
      .in("organization_id", organizationIds),
    admin
      .from("provisioning_run_events")
      .select("organization_id, created_at")
      .eq("event", "tool_auth_confirmed")
      .in("organization_id", organizationIds)
      .order("created_at", { ascending: false })
      // shortcut: one page; past 1000 confirmations among waiting customers, markers could disagree.
      .limit(1000),
  ]);
  for (const r of [agents, voices, confirms]) if (r.error) throw r.error;
  return new Map(
    organizationIds.map((org) => {
      const of = <T extends { organization_id: string }>(rows: T[] | null) =>
        (rows ?? []).filter((r) => r.organization_id === org);
      const agentRows = of(agents.data);
      const mark = [
        agentRows.map((r) => r.updated_at),
        of(voices.data).map((r) => r.updated_at),
        of(confirms.data).map((r) => r.created_at),
      ]
        .map((times) => times.sort().at(-1) ?? "")
        .join("|");
      return [org, { mark, registered: agentRows.some((r) => r.sarvam_app_id) }] as const;
    }),
  );
}

export async function runProvisioning(
  admin: Admin,
  input: RunProvisioningInput,
  orchestrate: Orchestrate = (a, org, hooks) =>
    runProvisioningPipeline(a, org, undefined, hooks.onStep),
  now: () => Date = () => new Date(),
): Promise<RunProvisioningResult> {
  const runId = await findOrCreateActiveRun(admin, input);

  const { data: current, error: readError } = await admin
    .from("provisioning_runs")
    .select(
      "id, status, attempts, updated_at, next_attempt_at, max_attempts, step_states, diagnostics",
    )
    .eq("id", runId)
    .single();
  if (readError) throw readError;

  const stale =
    current.status === "running" &&
    now().getTime() - new Date(current.updated_at).getTime() > STALE_RUNNING_MS;
  if (current.status === "running" && !stale) {
    return { runId, claimed: false, status: "running", result: null };
  }
  // A scheduled automatic retry waits for its time (only an admin retry jumps the queue).
  if (
    current.status === "pending" &&
    current.next_attempt_at &&
    new Date(current.next_attempt_at).getTime() > now().getTime() &&
    !input.force
  )
    return { runId, claimed: false, status: "pending", result: null };

  // Claim: only succeeds if nobody else changed the run since we read it.
  const { data: claimed, error: claimError } = await admin
    .from("provisioning_runs")
    .update({
      status: "running",
      attempts: current.attempts + 1,
      started_at: now().toISOString(),
      next_attempt_at: null,
    })
    .eq("id", runId)
    .eq("status", current.status)
    // Every claim bumps attempts, so it doubles as an optimistic version.
    .eq("attempts", current.attempts)
    .select("id");
  if (claimError) throw claimError;
  if (!claimed?.length) return { runId, claimed: false, status: "running", result: null };

  const attempt = current.attempts + 1;
  const maxAttempts = current.max_attempts ?? MAX_AUTOMATIC_ATTEMPTS;
  // Only consecutive failed attempts count toward the retry bound: clicks and
  // sweeps that merely found the job waiting must not use it up.
  const previousStreak = Number(
    (current.diagnostics as { retryStreak?: number } | null)?.retryStreak ?? 0,
  );
  const streak = previousStreak + 1;
  const run = { id: runId, organizationId: input.organizationId };
  let states = (current.step_states ?? {}) as StepStates;
  let currentKey: JobStepKey = "validating";
  let seenChange: string | undefined;
  await addEvent(admin, run, attempt === 1 ? "started" : "resumed", null, {
    attempt,
    trigger: input.trigger,
    checkpoint: lastDoneStep(states),
  });

  const nowIso = () => now().toISOString();
  const onStep = async (key: JobStepKey) => {
    currentKey = key;
    states = beginStep(states, key, nowIso());
    const { error } = await admin
      .from("provisioning_runs")
      .update({ current_job_step: key, step_states: states as unknown as Json })
      .eq("id", runId)
      .eq("attempts", attempt);
    if (error) throw error;
    await addEvent(admin, run, "step_started", key, { attempt });
  };

  /** Writes how this attempt ended (shared by the result and the unexpected-error paths). */
  const finish = async (
    kind: "succeeded" | "waiting" | "retry" | "failed",
    f: {
      code: FailureCode | null;
      retryable: boolean | null;
      customerMessage: string | null;
      note: string;
      extra?: Record<string, unknown>;
    },
  ) => {
    if (kind === "succeeded") {
      currentKey = "complete";
      states = endStep(beginStep(states, "complete", nowIso()), "complete", "done", nowIso());
    } else if (states[currentKey]?.status === "running") {
      states = endStep(
        states,
        currentKey,
        kind === "waiting" ? "waiting" : "failed",
        nowIso(),
        f.code ?? undefined,
      );
    }
    const terminal = kind === "succeeded" || kind === "failed";
    const { data: agentRow } = await admin
      .from("agent_configs")
      .select("sarvam_app_id")
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    const { error } = await admin
      .from("provisioning_runs")
      .update({
        status: kind === "retry" ? "pending" : kind,
        current_job_step: currentKey,
        step_states: states as unknown as Json,
        last_checkpoint: lastDoneStep(states),
        failure_code: f.code,
        retryable: f.retryable,
        customer_message: f.customerMessage,
        diagnostics: {
          attempt,
          maxAttempts,
          retryStreak: kind === "retry" ? streak : 0,
          step: currentKey,
          note: sanitizeDiagnostic(f.note),
          seenChange,
          ...f.extra,
        } as unknown as Json,
        next_attempt_at:
          kind === "retry" ? new Date(now().getTime() + backoffMs(streak)).toISOString() : null,
        // Keep an agent id reported by the operator until the version is registered.
        ...(agentRow?.sarvam_app_id ? { sarvam_agent_id: agentRow.sarvam_app_id } : {}),
        finished_at: terminal ? nowIso() : null,
        ...(kind === "failed" || kind === "retry"
          ? { last_error: sanitizeDiagnostic(f.note), last_error_at: nowIso() }
          : {}),
      })
      .eq("id", runId)
      // A superseded attempt (reclaimed as stale) never overwrites the newer one.
      .eq("attempts", attempt);
    if (error) throw error;
    await addEvent(admin, run, kind === "retry" ? "retry_scheduled" : kind, currentKey, {
      attempt,
      code: f.code,
      retryable: f.retryable,
    });
  };

  let result: ProvisionOrganizationResult;
  try {
    seenChange = (await changeMarks(admin, [input.organizationId])).get(input.organizationId)?.mark;
    result = await orchestrate(admin, input.organizationId, { onStep });
  } catch (err) {
    // An unexpected error ends this attempt (retried with backoff, bounded), never a stuck "running".
    const message = (err as Error).message ?? String(err);
    const retry = streak < maxAttempts;
    await finish(retry ? "retry" : "failed", {
      code: retry ? "INTERNAL_ERROR" : "RETRIES_EXHAUSTED",
      retryable: true,
      customerMessage: retry ? CUSTOMER_RETRYING : CUSTOMER_PROBLEM,
      note: message,
    }).catch((e) =>
      console.error("provisioning_runs:fail_write_failed", runId, (e as Error).message),
    );
    throw err;
  }

  const pipeline = result as Partial<PipelineResult>;
  const outcome = classifyOutcome({
    state: result.state,
    step: currentKey,
    failure: pipeline.failure,
    attempts: streak,
    maxAttempts,
  });
  const failingChecks = (pipeline.verification?.checks ?? []).filter((c) => !c.ok).map((c) => c.id);
  // The inbound number is live; the outbound agent is an internal follow-up.
  if (outcome.kind === "waiting" && result.state.startsWith("waiting_for_outbound")) {
    currentKey = "complete";
    states = endStep(beginStep(states, "complete", nowIso()), "complete", "done", nowIso());
  }
  await finish(
    outcome.kind,
    outcome.kind === "succeeded"
      ? { code: null, retryable: null, customerMessage: null, note: result.note }
      : {
          code: outcome.code,
          retryable:
            outcome.kind === "failed" ? outcome.retryable : outcome.kind === "retry" ? true : null,
          customerMessage: outcome.customerMessage,
          note: result.note,
          extra: { state: result.state, failingChecks },
        },
  );
  const status: ProvisioningRunStatus = outcome.kind === "retry" ? "pending" : outcome.kind;

  // Fields the pipeline produced that do not depend on the job outcome.
  const { error: saveError } = await admin
    .from("provisioning_runs")
    .update({
      current_step: result.state,
      note: result.note,
      phone_number_id: result.phoneNumberId,
      sarvam_deployment_id: result.deploymentId ?? null,
      ...(pipeline.generatedConfig
        ? {
            generated_agent_config: pipeline.generatedConfig as unknown as Json,
            agent_config_fingerprint: pipeline.generatedConfig.fingerprint,
          }
        : {}),
      ...(pipeline.deploymentVerifiedAt
        ? { deployment_verified_at: pipeline.deploymentVerifiedAt }
        : {}),
      ...(pipeline.verification ? { verification: pipeline.verification as unknown as Json } : {}),
    })
    .eq("id", runId)
    .eq("attempts", attempt);
  if (saveError) throw saveError;

  return { runId, claimed: true, status, result };
}

export interface SweepResult {
  due: number;
  stuck: number;
  agentRegistered: number;
  processed: number;
  errors: number;
}

/**
 * The scheduled tick's provisioning sweep (job kind `sweep.provisioning_retry`,
 * every minute from the Worker cron). Resumes, through runProvisioning's own
 * claim and backoff checks:
 *   1. jobs whose automatic retry is due (pending + next_attempt_at <= now);
 *   2. jobs stuck "running" past the stale window (a crashed attempt);
 *   3. jobs waiting on an agent, voice settings or tool authentication that CHANGED since
 *      the job last ran (an agent registered or its settings saved after the job's last
 *      attempt), so a registration whose own resume failed still continues the job. A job
 *      that has already re-run on the current state is left alone: re-running it every
 *      minute would change nothing and only grow the event trail.
 * Bounded per tick (maxRuns, budgetMs); the rest wait for the next minute.
 */
export async function sweepProvisioningRetries(
  admin: Admin,
  options: {
    now?: Date;
    maxRuns?: number;
    budgetMs?: number;
    run?: (admin: Admin, input: RunProvisioningInput) => Promise<RunProvisioningResult>;
  } = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const run = options.run ?? ((a, i) => runProvisioning(a, i));
  const [due, stuck, waiting] = await Promise.all([
    admin
      .from("provisioning_runs")
      .select("organization_id, trigger")
      .eq("status", "pending")
      .lte("next_attempt_at", now.toISOString())
      .order("next_attempt_at", { ascending: true })
      .limit(10),
    admin
      .from("provisioning_runs")
      .select("organization_id, trigger")
      .eq("status", "running")
      .lt("updated_at", new Date(now.getTime() - STALE_RUNNING_MS).toISOString())
      .limit(10),
    admin
      .from("provisioning_runs")
      .select("organization_id, trigger, diagnostics")
      .eq("status", "waiting")
      // Only a customer's own activation click authorizes going live automatically.
      .eq("trigger", "customer_activate")
      .in("current_step", [
        "waiting_for_agent",
        "waiting_for_voice_language",
        "waiting_for_tool_authentication",
      ])
      // Wide on purpose: most waiting jobs are unchanged and filtered out below, so a small
      // window could starve the one that changed. shortcut: 200 waiting jobs (the ids also go
      // into the follow-up queries' URLs); page beyond that.
      .limit(200),
  ]);
  for (const r of [due, stuck, waiting]) if (r.error) throw r.error;

  let registered: typeof waiting.data = [];
  const waitingOrgs = (waiting.data ?? []).map((w) => w.organization_id);
  if (waitingOrgs.length) {
    const marks = await changeMarks(admin, waitingOrgs);
    registered = (waiting.data ?? []).filter((w) => {
      const now = marks.get(w.organization_id);
      const seenAt = (w.diagnostics as { seenChange?: string } | null)?.seenChange;
      // Only a change since the job's last attempt is news; otherwise it would wait again.
      return Boolean(now?.registered) && now!.mark !== seenAt;
    });
  }

  const seen = new Set<string>();
  const queue = [...(due.data ?? []), ...(stuck.data ?? []), ...(registered ?? [])].filter(
    (r) => !seen.has(r.organization_id) && seen.add(r.organization_id),
  );
  const deadline = Date.now() + (options.budgetMs ?? 15_000);
  let processed = 0;
  let errors = 0;
  for (const r of queue.slice(0, options.maxRuns ?? 3)) {
    if (Date.now() > deadline) break;
    try {
      const out = await run(admin, {
        organizationId: r.organization_id,
        trigger: r.trigger as ProvisioningTrigger,
      });
      if (out.claimed) processed++;
    } catch (err) {
      errors++;
      console.error("provisioning_sweep:run_failed", (err as Error).message);
    }
  }
  return {
    due: due.data?.length ?? 0,
    stuck: stuck.data?.length ?? 0,
    agentRegistered: registered?.length ?? 0,
    processed,
    errors,
  };
}
