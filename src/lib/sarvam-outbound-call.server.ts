import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getTelephonyAdapter, sarvamWebhookUrl } from "./telephony.server.ts";
import { SarvamTelephonyAdapter } from "./telephony/sarvam-provider.server.ts";

export interface SendInstantOutboundCallResult {
  callId: string;
  interactionId: string | null;
}

/**
 * Core validation + Sarvam call for placing one instant outbound call,
 * extracted from sarvam-outbound.functions.ts's createSarvamInstantOutboundCall
 * so the admin-only test action (Task list item 5, sarvam-admin.functions.ts's
 * testSarvamOutboundCall) calls exactly the same logic the customer-facing
 * path uses — not a second reimplementation. Mirrors
 * sarvam-inbound-deployment.server.ts's createInboundDeploymentForNumbers
 * in shape and intent.
 *
 * Callers own authorization: this function performs no auth, entitlement,
 * or wallet check itself. The customer-facing function gates on org
 * membership + checkTelephonyAccess + wallet affordability before calling
 * this; the admin test action gates on assertPlatformAdmin + an explicit
 * confirmTest flag + a demo/test-organization restriction before calling
 * this.
 *
 * Preserves the existing create-call-log-first pattern: the call_logs row
 * is created, and its own id is sent to Sarvam as metadata.callId, BEFORE
 * the provider is ever called — so even when Sarvam's response carries no
 * interaction_id synchronously, the webhook's own clientReference fallback
 * can still find and backfill this exact row. Does not fake success: a
 * failed adapter call marks the row failed and rethrows, never silently
 * swallowed.
 */
export async function sendSarvamInstantOutboundCall(
  supabaseAdmin: SupabaseClient<Database>,
  params: {
    phoneNumberId: string;
    toE164: string;
    agentVariables?: Record<string, unknown> | undefined;
  },
): Promise<SendInstantOutboundCallResult> {
  const { data: phoneNumber } = await supabaseAdmin
    .from("phone_numbers")
    .select("id, e164, organization_id, provider, connection_id, agent_config_id")
    .eq("id", params.phoneNumberId)
    .maybeSingle();
  if (!phoneNumber) throw new Error("Phone number not found.");
  if (phoneNumber.provider !== "sarvam")
    throw new Error("This flow only applies to Sarvam-provisioned numbers.");
  if (!phoneNumber.organization_id)
    throw new Error("This phone number has no organization assigned.");
  if (!phoneNumber.connection_id)
    throw new Error("This number has no telephony connection configured.");
  if (!phoneNumber.agent_config_id) throw new Error("This number has no agent configured.");

  const webhookUrl = sarvamWebhookUrl();
  if (!webhookUrl) throw new Error("Outbound calling is not configured on this platform yet.");

  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter) throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
  if (!(adapter instanceof SarvamTelephonyAdapter))
    throw new Error("Unexpected adapter type for provider 'sarvam'.");

  const { data: connection } = await supabaseAdmin
    .from("telephony_connections")
    .select("id, provider, provider_connection_id")
    .eq("id", phoneNumber.connection_id)
    .maybeSingle();
  if (!connection || connection.provider !== "sarvam" || !connection.provider_connection_id)
    throw new Error("This number's Sarvam connection has not been registered yet.");

  const { data: agentConfig } = await supabaseAdmin
    .from("agent_configs")
    .select("id, organization_id, sarvam_app_id, sarvam_app_version")
    .eq("id", phoneNumber.agent_config_id)
    .maybeSingle();
  if (!agentConfig || agentConfig.organization_id !== phoneNumber.organization_id)
    throw new Error("This number's agent does not belong to this organization.");
  if (!agentConfig.sarvam_app_id || !agentConfig.sarvam_app_version)
    throw new Error("This number's agent has not been mapped to a Sarvam app yet.");

  const { data: call, error: insertError } = await supabaseAdmin
    .from("call_logs")
    .insert({
      organization_id: phoneNumber.organization_id,
      phone_number_id: phoneNumber.id,
      provider: "sarvam",
      direction: "outbound",
      caller_number: phoneNumber.e164,
      destination_number: params.toE164,
      status: "initiated",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insertError) throw insertError;

  try {
    const dialed = await adapter.createInstantOutbound({
      appId: agentConfig.sarvam_app_id,
      appVersion: agentConfig.sarvam_app_version,
      connectionId: connection.provider_connection_id,
      fromE164: phoneNumber.e164,
      toE164: params.toE164,
      agentVariables: params.agentVariables,
      webhookUrl,
      metadata: { organizationId: phoneNumber.organization_id, callId: call.id },
    });

    // interaction_id may not be returned synchronously — see
    // SarvamTelephonyAdapter.createInstantOutbound's doc. When absent,
    // provider_call_id stays null (never fabricated); the webhook's own
    // interaction_id, or the clientReference fallback, backfills it later.
    if (dialed.interactionId) {
      await supabaseAdmin
        .from("call_logs")
        .update({ provider_call_id: dialed.interactionId })
        .eq("id", call.id);
    }
    return { callId: call.id, interactionId: dialed.interactionId ?? null };
  } catch (err) {
    await supabaseAdmin
      .from("call_logs")
      .update({
        status: "failed",
        failure_reason: (err as Error).message,
        ended_at: new Date().toISOString(),
      })
      .eq("id", call.id);
    throw err;
  }
}
