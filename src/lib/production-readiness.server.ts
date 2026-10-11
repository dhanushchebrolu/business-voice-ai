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

/**
 * Safe, redacted check of which Supabase project this deployment's
 * service-role client is actually pointed at, and whether PostgREST can
 * currently see `public.bookings` — added to diagnose a recurring
 * production incident ("Could not load this — step 'fetch_bookings'
 * failed ... PGRST205"). Never exposes SUPABASE_URL or any key: `projectRef`
 * is only the project-ref label parsed out of the URL's hostname (e.g.
 * "eorazvlmqwunmhwviocn" from "https://eorazvlmqwunmhwviocn.supabase.co"),
 * which is also the non-secret value already committed in
 * supabase/config.toml — comparing the two here is exactly the "verify
 * the Worker's Supabase project" check that can't otherwise be done
 * without pasting a secret into chat. `bookingsTable*` deliberately
 * reports the raw error code/message rather than collapsing a failure
 * into a boolean — PGRST205 alone can't distinguish "migration never
 * applied" from "table exists but PostgREST's schema cache is stale", and
 * this is a diagnostic surface, not fetch_bookings' own data path, so
 * there is nothing here for an empty-list fallback to silently hide.
 */
export interface SupabaseSchemaDiagnostic {
  /** null only when SUPABASE_URL itself is unset/unparseable — never the full URL. */
  projectRef: string | null;
  bookingsTableReachable: boolean;
  bookingsTableErrorCode: string | null;
  bookingsTableErrorMessage: string | null;
}

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
  supabaseSchema: SupabaseSchemaDiagnostic;
}

export function parseSupabaseProjectRef(): string | null {
  const url = process.env["SUPABASE_URL"];
  if (!url) return null;
  try {
    return new URL(url).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
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
      bookingsProbe,
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
      // Deliberately not `throw`n on error — the point of this probe is to
      // report exactly what PostgREST says about public.bookings (e.g. a
      // PGRST205 code/message) as diagnostic data, not to fail the whole
      // checklist if that one table is unreachable.
      supabaseAdmin.from("bookings").select("id", { count: "exact", head: true }).limit(1),
    ]);

    const supabaseSchema: SupabaseSchemaDiagnostic = {
      projectRef: parseSupabaseProjectRef(),
      bookingsTableReachable: !bookingsProbe.error,
      bookingsTableErrorCode: bookingsProbe.error?.code ?? null,
      bookingsTableErrorMessage: bookingsProbe.error?.message ?? null,
    };

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
      supabaseSchema,
    };
  });
