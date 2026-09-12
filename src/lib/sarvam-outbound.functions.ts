import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkTelephonyAccess, walletCanAffordOutbound } from "@/lib/telephony-guard.server";
import { sendSarvamInstantOutboundCall } from "@/lib/sarvam-outbound-call.server";

/**
 * Sarvam instant-outbound call initiation — the Sarvam-specific counterpart
 * to telephony-outbound.functions.ts's initiateOutboundCall. A dedicated
 * function rather than a branch inside the shared one because Sarvam's
 * outbound shape does not fit InitiatedCall (its interaction_id is not
 * confirmed to come back synchronously, while InitiatedCall.providerCallId
 * is non-optional — see SarvamTelephonyAdapter.initiateOutboundCall's doc).
 *
 * The actual validation/dial/call-log logic lives in
 * sarvam-outbound-call.server.ts's sendSarvamInstantOutboundCall — the
 * admin-only test action (sarvam-admin.functions.ts's testSarvamOutboundCall)
 * calls that exact same function, so this customer path and the admin test
 * path can never drift into two different implementations of "place a
 * Sarvam outbound call." This handler's own job is its authorization spine:
 * own-org membership -> checkTelephonyAccess entitlement/lock/payment/
 * number-status gate -> wallet affordability, all before the shared
 * function is ever called.
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

    const affordable = await walletCanAffordOutbound(orgId);
    if (!affordable) throw new Error("Insufficient wallet balance to place this call.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const result = await sendSarvamInstantOutboundCall(supabaseAdmin, {
      phoneNumberId: data.phoneNumberId,
      toE164: data.toE164,
    });

    return { callId: result.callId };
  });
