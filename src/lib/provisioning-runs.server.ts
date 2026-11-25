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
    .select("id, status, attempts, updated_at, next_attempt_at, max_attempts, step_states")
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
  const run = { id: runId, organizationId: input.organizationId };
  let states = (current.step_states ?? {}) as StepStates;
  let currentKey: JobStepKey = "validating";
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
      .eq("id", runId);
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
          step: currentKey,
          note: sanitizeDiagnostic(f.note),
          ...f.extra,
        } as unknown as Json,
        next_attempt_at:
          kind === "retry" ? new Date(now().getTime() + backoffMs(attempt)).toISOString() : null,
        sarvam_agent_id: agentRow?.sarvam_app_id ?? null,
        finished_at: terminal ? nowIso() : null,
        ...(kind === "failed" || kind === "retry"
          ? { last_error: sanitizeDiagnostic(f.note), last_error_at: nowIso() }
          : {}),
      })
      .eq("id", runId);
    if (error) throw error;
    await addEvent(admin, run, kind === "retry" ? "retry_scheduled" : kind, currentKey, {
      attempt,
      code: f.code,
      retryable: f.retryable,
    });
  };

  let result: ProvisionOrganizationResult;
  try {
    result = await orchestrate(admin, input.organizationId, { onStep });
  } catch (err) {
    // An unexpected error ends this attempt (retried with backoff, bounded), never a stuck "running".
    const message = (err as Error).message ?? String(err);
    const retry = attempt < maxAttempts;
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
    attempts: attempt,
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
    .eq("id", runId);
  if (saveError) throw saveError;

  return { runId, claimed: true, status, result };
}
