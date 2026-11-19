import { createServerFn } from "@tanstack/react-start";
import { normalizeCustomerPhone } from "@/lib/phone-number";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  IDEMPOTENCY_KEY_PATTERN,
  INVALID_DESTINATION_MESSAGE,
} from "@/lib/sarvam-outbound-call.server";

/**
 * Sarvam instant-outbound call initiation — the Sarvam-specific counterpart
 * to telephony-outbound.functions.ts's initiateOutboundCall. A dedicated
 * function rather than a branch inside the shared one because Sarvam's
 * outbound shape does not fit InitiatedCall (its interaction_id is not
 * confirmed to come back synchronously, while InitiatedCall.providerCallId
 * is non-optional — see SarvamTelephonyAdapter.initiateOutboundCall's doc).
 *
 * This handler's own job is who may dial: an owner or admin of the caller
 * number's organization. Everything else is the shared
 * placeSarvamCallForOrganization (sarvam-admin-calls.server.ts) — the same
 * gate the admin's call-on-behalf uses: entitlement/lock/payment, number
 * state, call limits, wallet, then sendSarvamInstantOutboundCall (readiness,
 * do-not-call, per-destination reservation, the dial itself). One path, so
 * the customer and admin flows can never drift apart.
 */

interface CreateSarvamInstantOutboundCallInput {
  phoneNumberId: string;
  toE164: string;
  /** Why the call is made; sanitized and capped before it reaches the agent. */
  objective?: string | undefined;
  /** One per dialog: a repeat of the same request returns the same call, never a second one. */
  idempotencyKey: string;
}

export const createSarvamInstantOutboundCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CreateSarvamInstantOutboundCallInput) => {
    if (!input?.phoneNumberId) throw new Error("phoneNumberId is required");
    // Canonical E.164 (phone-number.ts): the exact string stored and reserved.
    // No country is assumed here, so the number must include its country code.
    const toE164 = normalizeCustomerPhone(input.toE164, null);
    if (!toE164) throw new Error(INVALID_DESTINATION_MESSAGE);
    if (
      typeof input.idempotencyKey !== "string" ||
      !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)
    )
      throw new Error("This request is missing a valid request id. Reload the page and try again.");
    if (input.objective !== undefined && typeof input.objective !== "string")
      throw new Error("The reason for the call must be text.");
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

    // The same gate as the admin's call-on-behalf: entitlement, number state, call limits,
    // wallet, then the shared sendSarvamInstantOutboundCall.
    const { placeSarvamCallForOrganization } = await import("@/lib/sarvam-admin-calls.server");
    const result = await placeSarvamCallForOrganization(supabaseAdmin, {
      orgId,
      phoneNumberId: data.phoneNumberId,
      toE164: data.toE164,
      objective: typeof data.objective === "string" ? data.objective : undefined,
      idempotencyKey: data.idempotencyKey,
    });

    // outcome "unknown": Sarvam may have placed the call; it stays unconfirmed
    // in call history until a webhook or an operator resolves it.
    return { callId: result.callId, outcome: result.outcome, duplicate: result.duplicate === true };
  });

/**
 * What the Calls page needs before showing "Call a number": the workspace's
 * Sarvam numbers and why each cannot dial yet, the per-minute price and the
 * call limits. Any member may read it; only owners and admins may dial
 * (canDial). A preview only: the call itself re-checks everything.
 */
export const getOutboundCallingStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { memberRole, OUTBOUND_DIAL_ROLES } = await import("@/lib/outbound-authorization.server");
    const role = await memberRole(supabase, userId, data.orgId);
    if (!role) throw new Error("Workspace not found.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadOutboundCallingStatus } = await import("@/lib/sarvam-admin-calls.server");
    const { checkFeatureAccess } = await import("@/lib/feature-gate.server");
    const { walletCanAffordOutbound, getCallRate } = await import("@/lib/telephony-guard.server");
    const status = await loadOutboundCallingStatus(supabaseAdmin, data.orgId, {
      checkFeatureAccess,
      walletCanAffordOutbound,
      getCallRate,
    });
    return { ...status, canDial: OUTBOUND_DIAL_ROLES.includes(role) };
  });
