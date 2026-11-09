import { createServerFn } from "@tanstack/react-start";
import { normalizeCustomerPhone } from "@/lib/phone-number";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getTelephonyAdapter } from "@/lib/telephony.server";
import { checkTelephonyAccess, walletCanAffordOutbound } from "@/lib/telephony-guard.server";
import {
  INVALID_DESTINATION_MESSAGE,
  UNRESOLVED_CALL_MESSAGE,
} from "@/lib/sarvam-outbound-call.server";

/**
 * Outbound call initiation (spec §9). The client never calls the telephony
 * provider directly — it calls this server function, which re-derives every
 * authorization decision server-side before dialing anything.
 *
 * Flow: authenticated request -> resolve organization membership -> resolve
 * the requested phone number -> full entitlement/lock/payment/number-status
 * gate (checkTelephonyAccess, shared with the inbound webhook) -> wallet
 * affordability check -> create the call_logs row -> ask the provider
 * adapter to dial -> store provider_call_id. The provider's own webhook
 * events (not this function) drive every later state transition and the
 * final billing (finalizeCallBilling), so a client that never reconnects
 * after this call still gets billed correctly once the provider reports
 * the call ended.
 */

interface InitiateOutboundCallInput {
  phoneNumberId: string;
  toE164: string;
}

function webhookBaseUrl(): string | null {
  return process.env["TELEPHONY_WEBHOOK_BASE_URL"] ?? null;
}

export const initiateOutboundCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: InitiateOutboundCallInput) => {
    if (!input?.phoneNumberId) throw new Error("phoneNumberId is required");
    // Canonical E.164 (phone-number.ts): the exact string stored and reserved.
    // No country is assumed here, so the number must include its country code.
    const toE164 = normalizeCustomerPhone(input.toE164, null);
    if (!toE164) throw new Error(INVALID_DESTINATION_MESSAGE);
    return { ...input, toE164 };
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

    const affordable = await walletCanAffordOutbound(orgId);
    if (!affordable) throw new Error("Insufficient wallet balance to place this call.");

    const baseUrl = webhookBaseUrl();
    if (!baseUrl) throw new Error("Outbound calling is not configured on this platform yet.");

    const adapter = getTelephonyAdapter(gate.phoneNumber.provider);
    if (!adapter) throw new Error(`${gate.phoneNumber.provider} is not connected.`);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: call, error: insertError } = await supabaseAdmin
      .from("call_logs")
      .insert({
        organization_id: orgId,
        phone_number_id: gate.phoneNumber.id,
        provider: gate.phoneNumber.provider,
        direction: "outbound",
        caller_number: gate.phoneNumber.e164,
        destination_number: data.toE164,
        status: "initiated",
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    // The only unique index this insert can hit is the Sarvam single-call
    // reservation (idx_call_logs_sarvam_outbound_number_reservation): an earlier
    // call to this number is unresolved. Nothing was dialled.
    if (insertError?.code === "23505") throw new Error(UNRESOLVED_CALL_MESSAGE);
    if (insertError) throw insertError;

    try {
      const dialed = await adapter.initiateOutboundCall({
        fromE164: gate.phoneNumber.e164,
        toE164: data.toE164,
        callbackUrl: `${baseUrl}/api/public/webhooks/telephony?provider=${encodeURIComponent(gate.phoneNumber.provider)}`,
        metadata: { call_id: call.id, organization_id: orgId },
      });
      await supabaseAdmin
        .from("call_logs")
        .update({ provider_call_id: dialed.providerCallId, status: dialed.status })
        .eq("id", call.id);
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
