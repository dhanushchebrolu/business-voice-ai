import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getTelephonyAdapter } from "./telephony.server.ts";
import { SarvamTelephonyAdapter } from "./telephony/sarvam-provider.server.ts";

export interface CreateInboundDeploymentForNumbersResult {
  deploymentId: string;
  organizationId: string;
}

/**
 * Core validation + Sarvam call for creating an inbound deployment across
 * one or more Klyro phone numbers. Extracted from
 * sarvam-admin.functions.ts's createSarvamInboundDeployment (which still
 * does its own assertPlatformAdmin gate and audit write, then delegates
 * here) so the automatic provisioning orchestrator can call exactly the
 * same validated logic the admin UI already used, instead of a second
 * reimplementation. This is the one place that logic exists.
 *
 * Callers own authorization: this function performs no auth check itself.
 * The admin server function gates on assertPlatformAdmin("numbers.write")
 * before calling it; the automatic orchestrator runs with service-role
 * trust from inside the Razorpay webhook, which has no end-user session to
 * gate on.
 *
 * Does not fake success: no provider_deployment_id write happens unless
 * Sarvam's own createInboundDeployment call actually succeeds (see
 * SarvamTelephonyAdapter.createInboundDeployment's doc for that call's
 * verification status).
 */
export async function createInboundDeploymentForNumbers(
  supabaseAdmin: SupabaseClient<Database>,
  params: { phoneNumberIds: string[]; name: string },
): Promise<CreateInboundDeploymentForNumbersResult> {
  const { phoneNumberIds, name } = params;

  const { data: numbers, error: numbersError } = await supabaseAdmin
    .from("phone_numbers")
    .select("id, e164, organization_id, connection_id, agent_config_id")
    .in("id", phoneNumberIds);
  if (numbersError) throw numbersError;
  if (!numbers || numbers.length !== phoneNumberIds.length)
    throw new Error("One or more phone numbers were not found.");

  // A single deployment binds one connection + one app to a set of
  // numbers — every number in the request must share both, and (as a
  // direct consequence) the same organization. Rejecting a mixed set here
  // is what makes "cross-tenant mapping" structurally impossible: there is
  // no way to smuggle a number from a different organization into a
  // deployment for this one.
  const orgIds = new Set(numbers.map((n) => n.organization_id));
  if (orgIds.size > 1)
    throw new Error("All phone numbers in one deployment must belong to the same organization.");
  const connectionIds = new Set(numbers.map((n) => n.connection_id));
  if (connectionIds.size > 1 || numbers.some((n) => !n.connection_id))
    throw new Error(
      "All phone numbers in one deployment must share the same telephony connection.",
    );
  const agentConfigIds = new Set(numbers.map((n) => n.agent_config_id));
  if (agentConfigIds.size > 1 || numbers.some((n) => !n.agent_config_id))
    throw new Error("All phone numbers in one deployment must share the same agent.");

  const organizationId = numbers[0]!.organization_id;
  if (!organizationId) throw new Error("These phone numbers have no organization assigned yet.");
  const connectionId = numbers[0]!.connection_id!;
  const agentConfigId = numbers[0]!.agent_config_id!;

  const { data: connection } = await supabaseAdmin
    .from("telephony_connections")
    .select("id, provider, provider_connection_id")
    .eq("id", connectionId)
    .maybeSingle();
  if (!connection) throw new Error("Telephony connection not found.");
  if (connection.provider !== "sarvam")
    throw new Error("This deployment flow only applies to sarvam connections.");
  if (!connection.provider_connection_id)
    throw new Error(
      "This connection has not been registered with Sarvam yet — call registerTelephonyConnection first.",
    );

  const { data: agentConfig } = await supabaseAdmin
    .from("agent_configs")
    .select("id, organization_id, sarvam_app_id, sarvam_app_version")
    .eq("id", agentConfigId)
    .maybeSingle();
  if (!agentConfig) throw new Error("Agent not found.");
  if (agentConfig.organization_id !== organizationId)
    throw new Error("The agent's organization does not match the phone numbers' organization.");
  if (!agentConfig.sarvam_app_id || !agentConfig.sarvam_app_version)
    throw new Error(
      "This agent has not been mapped to a Sarvam app yet — call setSarvamAppMapping first.",
    );

  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter) throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
  if (!(adapter instanceof SarvamTelephonyAdapter))
    throw new Error("Unexpected adapter type for provider 'sarvam'.");

  // Real HTTP request against Sarvam's documented deployment-creation
  // endpoint — see SarvamTelephonyAdapter.createInboundDeployment's doc
  // comment for its verification status. No provider_deployment_id write
  // happens unless it genuinely succeeds.
  const created = await adapter.createInboundDeployment({
    name,
    appId: agentConfig.sarvam_app_id,
    appVersion: agentConfig.sarvam_app_version,
    connectionId: connection.provider_connection_id,
    phoneNumbers: numbers.map((n) => n.e164),
  });

  const { error: updateError } = await supabaseAdmin
    .from("phone_numbers")
    .update({ provider_deployment_id: created.deploymentId })
    .in("id", phoneNumberIds);
  if (updateError) throw updateError;

  return { deploymentId: created.deploymentId, organizationId };
}
