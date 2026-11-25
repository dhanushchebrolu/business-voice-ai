import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertFeatureUnlocked } from "@/lib/feature-gate.server";

/**
 * Customer "Activate Number". Starts (or joins) the same provisioning run the
 * setup-fee webhook and the admin retry use, so a customer can never do
 * anything those paths would not. Safety:
 *   - the organization must be one the caller OWNS, checked through the
 *     caller's own RLS-scoped membership row (never trusted from input alone);
 *   - eligibility is the existing feature_locked(org, "phone") rule, which
 *     already honours the payment-enforcement switch, overrides and
 *     lifecycle: no new payment rule is introduced here;
 *   - one active run per organization AND per number (database indexes), a
 *     busy job is never restarted, and a just-finished permanent failure is
 *     not re-run, so repeated clicks never start parallel work;
 *   - the returned view comes from the persisted job (voice-activation.server.ts),
 *     so the dashboard shows real steps and survives a refresh;
 *   - Sarvam has no agent-authoring API: until the ClickAI team has done that
 *     step the job waits (and says so honestly).
 */

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
    const { startVoiceActivation } = await import("@/lib/voice-activation.server");
    return startVoiceActivation(supabaseAdmin, { orgId: data.orgId, userId: context.userId });
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
    const { loadActivationView } = await import("@/lib/voice-activation.server");
    return loadActivationView(supabaseAdmin, data.orgId);
  });
