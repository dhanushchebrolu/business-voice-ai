import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import type { ProvisionOrganizationResult } from "./provisioning-orchestrator.server.ts";
import { runProvisioningPipeline, type PipelineResult } from "./provisioning-pipeline.server.ts";

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
 */

export type ProvisioningTrigger =
  "setup_fee" | "phone_service_fee" | "admin_retry" | "customer_activate";
export type ProvisioningRunStatus = "pending" | "running" | "waiting" | "succeeded" | "failed";

export const ACTIVE_RUN_STATUSES = ["pending", "running", "waiting"] as const;
export const STALE_RUNNING_MS = 10 * 60 * 1000;

type Admin = SupabaseClient<Database>;
type Orchestrate = (admin: Admin, organizationId: string) => Promise<ProvisionOrganizationResult>;

export interface RunProvisioningInput {
  organizationId: string;
  trigger: ProvisioningTrigger;
  sourcePaymentId?: string | null;
  createdBy?: string | null;
}

export interface RunProvisioningResult {
  runId: string;
  /** false when another attempt holds the run; nothing was done. */
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

export async function runProvisioning(
  admin: Admin,
  input: RunProvisioningInput,
  orchestrate: Orchestrate = (a, org) => runProvisioningPipeline(a, org),
  now: () => Date = () => new Date(),
): Promise<RunProvisioningResult> {
  const runId = await findOrCreateActiveRun(admin, input);

  const { data: current, error: readError } = await admin
    .from("provisioning_runs")
    .select("id, status, attempts, updated_at")
    .eq("id", runId)
    .single();
  if (readError) throw readError;

  const stale =
    current.status === "running" &&
    now().getTime() - new Date(current.updated_at).getTime() > STALE_RUNNING_MS;
  if (current.status === "running" && !stale) {
    return { runId, claimed: false, status: "running", result: null };
  }

  // Claim: only succeeds if nobody else changed the run since we read it.
  const { data: claimed, error: claimError } = await admin
    .from("provisioning_runs")
    .update({
      status: "running",
      attempts: current.attempts + 1,
      started_at: now().toISOString(),
    })
    .eq("id", runId)
    .eq("status", current.status)
    // Every claim bumps attempts, so it doubles as an optimistic version.
    .eq("attempts", current.attempts)
    .select("id");
  if (claimError) throw claimError;
  if (!claimed?.length) return { runId, claimed: false, status: "running", result: null };

  let result: ProvisionOrganizationResult;
  try {
    result = await orchestrate(admin, input.organizationId);
  } catch (err) {
    // An unexpected error ends this attempt as failed (retryable), never a stuck "running".
    const message = (err as Error).message ?? String(err);
    const { error: failError } = await admin
      .from("provisioning_runs")
      .update({
        status: "failed",
        last_error: message,
        last_error_at: now().toISOString(),
        finished_at: now().toISOString(),
      })
      .eq("id", runId);
    if (failError) console.error("provisioning_runs:fail_write_failed", runId, failError.message);
    throw err;
  }
  const status = runStatusFor(result);
  const finishedAt = status === "waiting" ? null : now().toISOString();
  const pipeline = result as Partial<PipelineResult>;
  const { error: saveError } = await admin
    .from("provisioning_runs")
    .update({
      status,
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
      finished_at: finishedAt,
      ...(status === "failed"
        ? { last_error: result.note, last_error_at: now().toISOString() }
        : {}),
    })
    .eq("id", runId);
  if (saveError) throw saveError;

  return { runId, claimed: true, status, result };
}
