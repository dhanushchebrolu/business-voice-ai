import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { customerJobView, maskPhone, type CustomerJobView } from "./voice-provisioning-job.ts";
import {
  runProvisioning,
  type RunProvisioningInput,
  type RunProvisioningResult,
} from "./provisioning-runs.server.ts";
import { businessSetupProblems, type PipelineDeps } from "./provisioning-pipeline.server.ts";

/**
 * The customer's submission of their business setup ("Submit setup" / "Activate Number" on the
 * dashboard): the one customer action that starts provisioning, and only when the setup is
 * complete. Saving details and paying never do. Everything the
 * customer sees is derived from the job's persisted state (never from the
 * click that started it), so a refresh, a second tab or a second click shows
 * the same truth. Callers own authentication and the ownership check; every
 * query here is scoped to the given organization.
 */

type Admin = SupabaseClient<Database>;

/** A permanently failed job that just finished is shown again instead of re-running. */
export const ACTIVATION_REUSE_MS = 60_000;

export interface ActivationView extends CustomerJobView {
  /** The customer's number, masked (never the full number in this view). */
  numberMasked: string | null;
  /** Set when a submission was refused: what the business setup still needs. */
  missing?: string[];
}

export const SETUP_INCOMPLETE_MESSAGE = "Finish your business setup before submitting it.";

const RUN_COLUMNS =
  "id, status, attempts, current_job_step, step_states, customer_message, retryable, next_attempt_at, finished_at";

export async function loadActivationView(admin: Admin, orgId: string): Promise<ActivationView> {
  const { data: run, error } = await admin
    .from("provisioning_runs")
    .select(RUN_COLUMNS)
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const { data: numbers, error: numError } = await admin
    .from("phone_numbers")
    .select(
      "e164, status, inbound_enabled, provider_deployment_id, verified_deployment_id, created_at",
    )
    .eq("organization_id", orgId)
    .eq("provider", "sarvam")
    .neq("status", "released")
    .order("created_at", { ascending: true });
  if (numError) throw numError;
  const number = numbers?.[0] ?? null;
  // Live means ACTIVE in ClickAI AND the verified deployment is the mapped one (the admission gate's rule).
  const live = Boolean(
    number &&
    number.status === "active" &&
    number.inbound_enabled &&
    number.provider_deployment_id &&
    number.verified_deployment_id === number.provider_deployment_id,
  );
  return { ...customerJobView(run, live), numberMasked: maskPhone(number?.e164) };
}

export async function startVoiceActivation(
  admin: Admin,
  input: { orgId: string; userId: string },
  run: (a: Admin, i: RunProvisioningInput) => Promise<RunProvisioningResult> = runProvisioning,
  now: () => Date = () => new Date(),
  loadSnapshot?: PipelineDeps["loadSnapshot"],
): Promise<ActivationView> {
  const before = await loadActivationView(admin, input.orgId);
  // Already live, or a job is queued/running/retrying: a click changes nothing.
  if (before.phase === "completed" || before.busy) return before;

  if (before.phase === "failed" && !before.canRetry) {
    const { data: last, error } = await admin
      .from("provisioning_runs")
      .select("finished_at")
      .eq("organization_id", input.orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (
      last?.finished_at &&
      now().getTime() - new Date(last.finished_at).getTime() < ACTIVATION_REUSE_MS
    )
      return before;
  }

  // Incomplete setup: no job is created or run.
  const missing = await businessSetupProblems(admin, input.orgId, loadSnapshot);
  if (missing.length) return { ...before, message: SETUP_INCOMPLETE_MESSAGE, missing };

  await run(admin, {
    organizationId: input.orgId,
    trigger: "customer_activate",
    createdBy: input.userId,
    idempotencyKey: `activate:${input.orgId}`,
  });
  return loadActivationView(admin, input.orgId);
}
