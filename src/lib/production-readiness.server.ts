import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin } from "@/lib/platform-admin.server";
import { validateSarvamEnv } from "@/lib/telephony.server";
import { razorpayConfigured, getRazorpayWebhookSecret } from "@/lib/razorpay.server";

/**
 * The production readiness checklist (Task list item 6): every
 * prerequisite this codebase can actually check for itself before
 * automatic provisioning has any chance of working end to end. Read-only,
 * admin-gated, no side effects. Deliberately does NOT check for an
 * existing Sarvam agent/version/connection/number belonging to any
 * specific customer — those are per-organization facts already covered by
 * getCustomerDetail's own provisioning view (Task #95); this checklist is
 * the platform-wide prerequisites only.
 */

export interface ProductionReadinessChecklist {
  sarvamEnv: ReturnType<typeof validateSarvamEnv>;
  sarvamContextSecretPresent: boolean;
  sarvamWebhookSecretPresent: boolean;
  telephonyWebhookBaseUrlPresent: boolean;
  razorpayConfigured: boolean;
  razorpayWebhookSecretPresent: boolean;
  poolAvailableNumberCount: number;
  registeredConnectionCount: number;
  sarvamMappedAgentCount: number;
  /** Every env-var-level prerequisite is met — does not imply any customer can fully activate (that also needs a connection + agent mapping per org). */
  allCriticalEnvPresent: boolean;
}

export const getProductionReadinessChecklist = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ProductionReadinessChecklist> => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const sarvamEnv = validateSarvamEnv();
    const sarvamContextSecretPresent = Boolean(process.env["SARVAM_CONTEXT_SECRET"]);
    const sarvamWebhookSecretPresent = Boolean(process.env["SARVAM_WEBHOOK_SECRET"]);
    const telephonyWebhookBaseUrlPresent = Boolean(process.env["TELEPHONY_WEBHOOK_BASE_URL"]);
    const razorpayReady = razorpayConfigured();
    const razorpayWebhookSecretPresent = Boolean(getRazorpayWebhookSecret());

    const [
      { count: poolAvailableNumberCount },
      { count: registeredConnectionCount },
      { count: sarvamMappedAgentCount },
    ] = await Promise.all([
      supabaseAdmin
        .from("phone_numbers")
        .select("id", { count: "exact", head: true })
        .eq("status", "available")
        .is("organization_id", null),
      supabaseAdmin
        .from("telephony_connections")
        .select("id", { count: "exact", head: true })
        .eq("provider", "sarvam")
        .not("provider_connection_id", "is", null),
      supabaseAdmin
        .from("agent_configs")
        .select("id", { count: "exact", head: true })
        .not("sarvam_app_id", "is", null)
        .not("sarvam_app_version", "is", null),
    ]);

    return {
      sarvamEnv,
      sarvamContextSecretPresent,
      sarvamWebhookSecretPresent,
      telephonyWebhookBaseUrlPresent,
      razorpayConfigured: razorpayReady,
      razorpayWebhookSecretPresent,
      poolAvailableNumberCount: poolAvailableNumberCount ?? 0,
      registeredConnectionCount: registeredConnectionCount ?? 0,
      sarvamMappedAgentCount: sarvamMappedAgentCount ?? 0,
      allCriticalEnvPresent:
        sarvamEnv.allPresent &&
        sarvamContextSecretPresent &&
        telephonyWebhookBaseUrlPresent &&
        razorpayReady &&
        razorpayWebhookSecretPresent,
    };
  });
