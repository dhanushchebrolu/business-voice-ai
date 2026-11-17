import { createServerFn } from "@tanstack/react-start";
import { normalizeCustomerPhone } from "@/lib/phone-number";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkTelephonyAccess, walletCanAffordOutbound } from "@/lib/telephony-guard.server";
import {
  INVALID_DESTINATION_MESSAGE,
  sendSarvamInstantOutboundCall,
} from "@/lib/sarvam-outbound-call.server";

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
  /** Why the call is made; sanitized and capped before it reaches the agent. */
  objective?: string | undefined;
}

export const createSarvamInstantOutboundCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CreateSarvamInstantOutboundCallInput) => {
    if (!input?.phoneNumberId) throw new Error("phoneNumberId is required");
    // Canonical E.164 (phone-number.ts): the exact string stored and reserved.
    // No country is assumed here, so the number must include its country code.
    const toE164 = normalizeCustomerPhone(input.toE164, null);
    if (!toE164) throw new Error(INVALID_DESTINATION_MESSAGE);
    return { ...input, toE164 };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // The caller number's own organization; dialling needs an owner or admin of it.
    const { outboundNumberOrganizationForCaller } =
      await import("@/lib/outbound-authorization.server");
    const orgId = await outboundNumberOrganizationForCaller(
      { supabase, supabaseAdmin },
      userId,
      data.phoneNumberId,
    );

    const gate = await checkTelephonyAccess(orgId, data.phoneNumberId, "outbound");
    if (!gate.allowed || !gate.phoneNumber)
      throw new Error(gate.reason ?? "Outbound calling is not available.");
    if (gate.phoneNumber.provider !== "sarvam")
      throw new Error("This flow only applies to Sarvam-provisioned numbers.");

    const affordable = await walletCanAffordOutbound(orgId);
    if (!affordable) throw new Error("Insufficient wallet balance to place this call.");

    const result = await sendSarvamInstantOutboundCall(supabaseAdmin, {
      phoneNumberId: data.phoneNumberId,
      toE164: data.toE164,
      objective: typeof data.objective === "string" ? data.objective : undefined,
    });

    // outcome "unknown": Sarvam may have placed the call; it stays unconfirmed
    // in call history until a webhook or an operator resolves it.
    return { callId: result.callId, outcome: result.outcome };
  });
