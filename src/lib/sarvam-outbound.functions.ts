import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getTelephonyAdapter } from "@/lib/telephony.server";
import { checkTelephonyAccess, walletCanAffordOutbound } from "@/lib/telephony-guard.server";
import { SarvamTelephonyAdapter } from "@/lib/telephony/sarvam-provider.server";

/**
 * Sarvam instant-outbound call initiation — the Sarvam-specific counterpart
 * to telephony-outbound.functions.ts's initiateOutboundCall. A dedicated
 * function rather than a branch inside the shared one because Sarvam's
 * outbound shape does not fit InitiatedCall (its interaction_id is not
 * confirmed to come back synchronously, while InitiatedCall.providerCallId
 * is non-optional — see SarvamTelephonyAdapter.initiateOutboundCall's doc).
 *
 * Same authorization spine as the shared flow (own-org membership ->
 * checkTelephonyAccess entitlement/lock/payment/number-status gate ->
 * wallet affordability), plus the Sarvam-specific mapping checks
 * (connection registered, agent mapped to a Sarvam app) that
 * sarvam-admin.functions.ts's createSarvamInboundDeployment already applies
 * for inbound. Preserves the existing create-call-log-first pattern: the
 * call_logs row is created, and its own UUID id is sent to Sarvam as the
 * candidate clientReference, BEFORE the provider is ever called — so even
 * when Sarvam's response carries no interaction_id synchronously, the
 * existing webhook clientReference fallback (webhook-correlation.server.ts /
 * telephony.ts's webhook route, unchanged from Phase 1) can still find and
 * backfill this exact row once Sarvam reports the attempt.
 */

interface CreateSarvamInstantOutboundCallInput {
  phoneNumberId: string;
  toE164: string;
}

export const createSarvamInstantOutboundCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CreateSarvamInstantOutboundCallInput) => {
    if (!input?.phoneNumberId) throw new Error("phoneNumberId is required");
    if (!input.toE164 || !/^\+\d{6,15}$/.test(input.toE164))
      throw new Error("A valid E.164 destination number is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: membership } = await supabase
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", userId)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (!membership) throw new Error("No workspace found for this account");
    const orgId = membership.organization_id;

    const gate = await checkTelephonyAccess(orgId, data.phoneNumberId, "outbound");
    if (!gate.allowed || !gate.phoneNumber)
      throw new Error(gate.reason ?? "Outbound calling is not available.");
    if (gate.phoneNumber.provider !== "sarvam")
      throw new Error("This flow only applies to Sarvam-provisioned numbers.");
    if (!gate.phoneNumber.connection_id)
      throw new Error("This number has no telephony connection configured.");
    if (!gate.phoneNumber.agent_config_id) throw new Error("This number has no agent configured.");

    const affordable = await walletCanAffordOutbound(orgId);
    if (!affordable) throw new Error("Insufficient wallet balance to place this call.");

    const adapter = getTelephonyAdapter("sarvam");
    if (!adapter) throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
    if (!(adapter instanceof SarvamTelephonyAdapter))
      throw new Error("Unexpected adapter type for provider 'sarvam'.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: connection } = await supabaseAdmin
      .from("telephony_connections")
      .select("id, provider, provider_connection_id")
      .eq("id", gate.phoneNumber.connection_id)
      .maybeSingle();
    if (!connection || connection.provider !== "sarvam" || !connection.provider_connection_id)
      throw new Error(
        "This number's Sarvam connection has not been registered yet — contact support.",
      );

    const { data: agentConfig } = await supabaseAdmin
      .from("agent_configs")
      .select("id, organization_id, sarvam_app_id, sarvam_app_version")
      .eq("id", gate.phoneNumber.agent_config_id)
      .maybeSingle();
    if (!agentConfig || agentConfig.organization_id !== orgId)
      throw new Error("This number's agent does not belong to this organization.");
    if (!agentConfig.sarvam_app_id || !agentConfig.sarvam_app_version)
      throw new Error(
        "This number's agent has not been mapped to a Sarvam app yet — contact support.",
      );

    const { data: call, error: insertError } = await supabaseAdmin
      .from("call_logs")
      .insert({
        organization_id: orgId,
        phone_number_id: gate.phoneNumber.id,
        provider: "sarvam",
        direction: "outbound",
        caller_number: gate.phoneNumber.e164,
        destination_number: data.toE164,
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
        toE164: data.toE164,
        clientReference: call.id,
      });

      // interaction_id may not be returned synchronously — see
      // SarvamTelephonyAdapter.createInstantOutbound's doc. When absent,
      // provider_call_id is deliberately left null (never fabricated) and
      // status stays "initiated"; the webhook's own interaction_id, or the
      // clientReference fallback above, backfills it once Sarvam reports
      // the attempt — same "no fake success" discipline as
      // createSarvamInboundDeployment.
      if (dialed.interactionId) {
        await supabaseAdmin
          .from("call_logs")
          .update({ provider_call_id: dialed.interactionId })
          .eq("id", call.id);
      }
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

    return { callId: call.id };
  });
