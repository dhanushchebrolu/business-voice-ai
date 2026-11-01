/**
 * The WhatsApp entitlement check for onboarding, evaluated as the signed-in
 * caller rather than as the service role.
 *
 * `feature_locked(_org, _feature)` is SECURITY DEFINER and never reads the
 * caller's identity, so its answer for an organization is the same whoever
 * runs it. But EXECUTE on it is granted only to `authenticated`
 * (20260907090000) — never to `service_role` — so the shared default in
 * feature-gate.server.ts (an RPC through supabaseAdmin) fails with a
 * permission error in a project without default function privileges, and
 * checkFeatureAccess turns that into "Could not evaluate WhatsApp
 * entitlement". Onboarding only worked while BYPASS_BILLING_GATES skipped the
 * check entirely.
 *
 * Evaluating it through the caller's own RLS-scoped client needs no new
 * grant, gives exactly the answer the dashboard already shows (access.ts
 * calls the same RPC from the browser), and keeps BYPASS_BILLING_GATES
 * behaving as before (checkFeatureAccess still checks it first). Tenant
 * safety comes from the caller: the organization id passed here is always
 * the one requireWhatsAppManager derived from the target and verified the
 * caller manages — never client input.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { assertFeatureUnlocked, type FeatureRpcResult } from "../feature-gate.server.ts";
import type { FeatureKey } from "../features.ts";

type Client = SupabaseClient<Database>;

/** feature_locked(), called with the given (caller's) client. */
export function featureLockedAs(client: Client) {
  return async (orgId: string, feature: FeatureKey): Promise<FeatureRpcResult> => {
    const { data, error } = await client.rpc("feature_locked", { _org: orgId, _feature: feature });
    return { data: data ?? null, error: error ? { message: error.message } : null };
  };
}

/** Throws the gate's customer-safe error when WhatsApp is locked (or can't be evaluated) for the organization. */
export async function assertWhatsAppUnlockedForCaller(
  callerClient: Client,
  organizationId: string,
): Promise<void> {
  await assertFeatureUnlocked(organizationId, "whatsapp", featureLockedAs(callerClient));
}
