import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

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
 * its previous customer's connection or agent, or a call could be placed or
 * answered through another tenant's setup.
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
