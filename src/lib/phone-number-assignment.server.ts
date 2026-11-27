import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { withDeploymentLock } from "./sarvam-deployment-lock.server.ts";
import { getTelephonyAdapter } from "./telephony.server.ts";
import { SarvamTelephonyAdapter } from "./telephony/sarvam-provider.server.ts";

/**
 * Number-to-customer assignment rules shared by the admin number actions
 * (telephony-admin.functions.ts). Callers own authorization.
 *
 * The database already guarantees one ACTIVE row per e164 and one UNCLAIMED
 * (pool) row per e164; these checks also cover the states in between
 * (provisioning, suspended), where the indexes alone would let one number sit
 * with two customers at once.
 */

export const NUMBER_HELD_MESSAGE =
  "This number is already assigned to another customer. Release it there first.";

/** Another non-released row holding this e164, if any (the pool counts as a holder). */
export async function findOtherE164Holder(
  supabaseAdmin: SupabaseClient<Database>,
  e164: string,
  exceptNumberId?: string,
): Promise<{ id: string; organization_id: string | null } | null> {
  let query = supabaseAdmin
    .from("phone_numbers")
    .select("id, organization_id")
    .eq("e164", e164)
    .neq("status", "released");
  if (exceptNumberId) query = query.neq("id", exceptNumberId);
  const { data, error } = await query.limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * Moves a number to a customer. It always lands `provisioning` with inbound
 * and outbound off, and is linked to the DESTINATION customer's own
 * connection (same provider) and agent, or to none: a number must never keep
 * its previous customer's connection, agent, deployment, verification or
 * confirmation, or a call could be placed or answered through, or a change
 * made to, another tenant's setup. A deployment Sarvam still has for the
 * number stays there until a person removes it; none is adopted from another
 * agent.
 */
export async function assignNumberToOrganization(
  supabaseAdmin: SupabaseClient<Database>,
  params: { numberId: string; toOrgId: string },
) {
  const { data: before, error: readError } = await supabaseAdmin
    .from("phone_numbers")
    .select("id, e164, provider, status, organization_id, connection_id, agent_config_id")
    .eq("id", params.numberId)
    .maybeSingle();
  if (readError) throw readError;
  if (!before) throw new Error("Number not found");
  if (before.status === "released")
    throw new Error("A released number cannot be reassigned — import or provision it again.");
  if (before.organization_id === params.toOrgId)
    throw new Error("This number is already assigned to this customer.");

  const { data: destOrg } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("id", params.toOrgId)
    .maybeSingle();
  if (!destOrg) throw new Error("Destination client not found");

  if (await findOtherE164Holder(supabaseAdmin, before.e164, before.id))
    throw new Error(NUMBER_HELD_MESSAGE);

  const [{ data: connection }, { data: agent }] = await Promise.all([
    supabaseAdmin
      .from("telephony_connections")
      .select("id")
      .eq("organization_id", params.toOrgId)
      .eq("provider", before.provider)
      .maybeSingle(),
    supabaseAdmin
      .from("agent_configs")
      .select("id")
      .eq("organization_id", params.toOrgId)
      .maybeSingle(),
  ]);

  const { error } = await supabaseAdmin
    .from("phone_numbers")
    .update({
      organization_id: params.toOrgId,
      business_id: null,
      connection_id: connection?.id ?? null,
      agent_config_id: agent?.id ?? null,
      provider_deployment_id: null,
      verified_deployment_id: null,
      verified_sarvam_app_id: null,
      verified_sarvam_app_version: null,
      deployment_verified_at: null,
      sarvam_number_confirmed_at: null,
      sarvam_number_confirmed_by: null,
      admission_blocked_at: null,
      admission_blocked_reason: null,
      status: "provisioning",
      inbound_enabled: false,
      outbound_enabled: false,
      suspended_reason: null,
    })
    .eq("id", params.numberId);
  if (error) {
    // UNIQUE(organization_id, e164): the customer already has a row for this e164.
    if ((error as { code?: string }).code === "23505") throw new Error(NUMBER_HELD_MESSAGE);
    throw error;
  }
  return before;
}

/** Throws unless Sarvam itself says this deployment is answering. Reads only. */
async function assertDeploymentAnswers(deploymentId: string) {
  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter || !(adapter instanceof SarvamTelephonyAdapter))
    throw new Error("Sarvam is not connected, so the number was not activated.");
  const { status } = await adapter.getDeployment(deploymentId).catch((err: Error) => {
    throw new Error(
      `Sarvam could not confirm that deployment ${deploymentId} is answering, so the number was not activated: ${err.message}`,
    );
  });
  if (status !== "active")
    throw new Error(
      `Sarvam deployment ${deploymentId} is ${status ?? "in an unknown state"}, so calls are not answered and the number was not activated. Resume the deployment (or retry provisioning), then activate it.`,
    );
}

/**
 * The admin "Activate" action. Under the number's deployment lock, so it never lands in the
 * middle of provisioning or another deployment change; and a Sarvam number is not called active
 * while its deployment is not answering. Nothing is resumed or paused for the person.
 */
export async function activateAssignedNumber(
  supabaseAdmin: SupabaseClient<Database>,
  numberId: string,
) {
  return withDeploymentLock(supabaseAdmin, [numberId], async (lock) => {
    const { data: before, error: readError } = await supabaseAdmin
      .from("phone_numbers")
      .select("status, organization_id, e164, provider, provider_deployment_id")
      .eq("id", numberId)
      .maybeSingle();
    if (readError) throw readError;
    if (!before) throw new Error("Number not found");
    if (before.status === "active") throw new Error("This number is already active");
    if (before.status === "released")
      throw new Error("A released number cannot be reactivated — provision a new one");
    if (before.provider === "sarvam" && before.provider_deployment_id)
      await assertDeploymentAnswers(before.provider_deployment_id);

    await lock.confirm();
    const { data: activated, error } = await supabaseAdmin
      .from("phone_numbers")
      .update({ status: "active", suspended_reason: null })
      .eq("id", numberId)
      // Only from the state just read: never over a release or reassignment made meanwhile.
      .eq("status", before.status)
      .select("id");
    if (error) {
      // Most likely the global "one active row per e164" uniqueness constraint.
      if ((error as { code?: string }).code === "23505") {
        throw new Error("This number is already active on another organization.");
      }
      throw error;
    }
    if (!activated?.length)
      throw new Error("The number changed while it was being activated; reload and try again.");
    const { status, organization_id, e164 } = before;
    return { status, organization_id, e164 };
  });
}
