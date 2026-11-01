import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertFeatureUnlocked } from "@/lib/feature-gate.server";
import { featureLockedAs } from "@/lib/whatsapp/whatsapp-feature-gate.server";

/**
 * Customer-facing phone-number request. Real Sarvam number rental has no
 * verified/implemented endpoint anywhere in this codebase (see
 * sarvam-provider.server.ts's provisionNumber, which hard-throws 501 rather
 * than guess an endpoint) — the existing, working path is an admin manually
 * buying/registering a number in Sarvam's own dashboard, then running the
 * already-built telephony-admin.functions.ts / sarvam-admin.functions.ts
 * chain (provisionPhoneNumber -> registerTelephonyConnection ->
 * setSarvamAppMapping -> createSarvamInboundDeployment -> activatePhoneNumber).
 *
 * This function does NOT fake that chain. It queues a real, auditable
 * request (a customer_events row — the same generic per-org timeline table
 * Customer 360 already reads) that tells an admin a customer wants a
 * number, after enforcing every real access check a genuine provisioning
 * action would need. No phone_numbers row is ever inserted here.
 */

export interface RequestPhoneNumberResult {
  ok: true;
  alreadyHasNumber: boolean;
  alreadyRequested: boolean;
  providerReady: boolean;
}

export const requestPhoneNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RequestPhoneNumberResult> => {
    // 1+2. Resolve the organization from the authenticated user's own
    // membership row via the RLS-scoped client — never a client-supplied
    // organization id. RLS on organization_members only returns rows for
    // orgs this exact user_id belongs to (or none), so this also verifies
    // membership in the same query.
    const { data: membership } = await context.supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", context.userId)
      .limit(1)
      .maybeSingle();
    if (!membership) throw new Error("No workspace found for your account.");
    const organizationId = membership.organization_id;

    // 3. Phone-number feature access + customer/service lock state — the
    // exact gate checkTelephonyAccess (Phase D) already enforces for real
    // calls, reused here rather than re-derived. Evaluated with the caller's
    // own client: feature_locked() is executable by `authenticated` only, so
    // through the service role it fails ("Could not evaluate ... entitlement")
    // — see whatsapp-feature-gate.server.ts. The function is SECURITY DEFINER
    // and ignores the caller, so the answer is the same.
    await assertFeatureUnlocked(organizationId, "phone", featureLockedAs(context.supabase));

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Idempotent: already has a live number -> nothing to request.
    // Only numbers that carry voice count (not a WhatsApp-only number).
    const { data: liveNumbers } = await supabaseAdmin
      .from("phone_numbers")
      .select("*")
      .eq("organization_id", organizationId)
      .neq("status", "released");
    const existingNumber = (liveNumbers ?? []).find((n) => n.voice_capable !== false);
    if (existingNumber) {
      return {
        ok: true,
        alreadyHasNumber: true,
        alreadyRequested: false,
        providerReady: false,
      };
    }

    // Idempotent: an unfulfilled request already exists -> don't queue a
    // second one on every re-click of "Get a number".
    const { data: recentRequest } = await supabaseAdmin
      .from("customer_events")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", "phone_number_requested")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Provider readiness: has an admin already registered a Sarvam
    // connection for this org (the manual, out-of-band first step of the
    // existing admin chain)? Informational only — it does not change
    // whether the request is queued, only what state the customer sees.
    const { data: connection } = await supabaseAdmin
      .from("telephony_connections")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("provider", "sarvam")
      .maybeSingle();
    const providerReady = Boolean(connection);

    if (!recentRequest) {
      const email = (context.claims["email"] as string | undefined) ?? null;
      await supabaseAdmin.from("customer_events").insert({
        organization_id: organizationId,
        kind: "phone_number_requested",
        title: "Customer requested a phone number",
        detail: providerReady
          ? "Sarvam connection already registered for this workspace — ready for an admin to provision the number."
          : "No Sarvam connection registered yet for this workspace — provider setup required before this can be fulfilled.",
        actor_email: email,
      });
    }

    return {
      ok: true,
      alreadyHasNumber: false,
      alreadyRequested: Boolean(recentRequest),
      providerReady,
    };
  });
