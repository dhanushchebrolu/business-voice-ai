import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertFeatureUnlocked } from "@/lib/feature-gate.server";
import { customerActivationStatus } from "@/lib/customer-activation-status";

/**
 * Customer "Activate Number". Starts (or joins) the same provisioning run the
 * setup-fee webhook and the admin retry use, so a customer can never do
 * anything those paths would not. Safety:
 *   - the organization must be one the caller OWNS, checked through the
 *     caller's own RLS-scoped membership row (never trusted from input alone);
 *   - eligibility is the existing feature_locked(org, "phone") rule, which
 *     already honours the payment-enforcement switch, overrides and
 *     lifecycle: no new payment rule is introduced here;
 *   - one active run per organization (database index) plus a short reuse
 *     window, so repeated clicks never start parallel work;
 *   - Sarvam agent authoring and number confirmation stay manual: until the
 *     ClickAI team has done them the run simply waits.
 */

/** A finished customer run this recent is returned instead of starting another. */
export const ACTIVATION_REUSE_MS = 60_000;

async function assertOwner(supabase: SupabaseClient<Database>, userId: string, orgId: string) {
  // RLS on organization_members returns only the caller's own memberships.
  const { data } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .eq("role", "owner")
    .maybeSingle();
  if (!data) throw new Error("Only the workspace owner can activate the number.");
}

export const activateMyNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string }) => {
    if (!input?.orgId || typeof input.orgId !== "string") throw new Error("orgId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertOwner(context.supabase, context.userId, data.orgId);
    await assertFeatureUnlocked(data.orgId, "phone");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: recent, error: recentError } = await supabaseAdmin
      .from("provisioning_runs")
      .select("current_step, finished_at")
      .eq("organization_id", data.orgId)
      .eq("trigger", "customer_activate")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentError) throw recentError;
    if (
      recent?.finished_at &&
      Date.now() - new Date(recent.finished_at).getTime() < ACTIVATION_REUSE_MS
    )
      return customerActivationStatus(recent.current_step);

    const { runProvisioning } = await import("@/lib/provisioning-runs.server");
    const run = await runProvisioning(supabaseAdmin, {
      organizationId: data.orgId,
      trigger: "customer_activate",
      createdBy: context.userId,
    });
    if (!run.claimed || !run.result)
      return { status: "in_progress" as const, message: "Activation is already in progress." };
    return customerActivationStatus(run.result.state);
  });

export const getMyActivationStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string }) => {
    if (!input?.orgId || typeof input.orgId !== "string") throw new Error("orgId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertOwner(context.supabase, context.userId, data.orgId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: run, error } = await supabaseAdmin
      .from("provisioning_runs")
      .select("status, current_step")
      .eq("organization_id", data.orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!run) return null;
    if (run.status === "running" || run.status === "pending")
      return { status: "in_progress" as const, message: "Activation is in progress." };
    return customerActivationStatus(run.current_step);
  });
