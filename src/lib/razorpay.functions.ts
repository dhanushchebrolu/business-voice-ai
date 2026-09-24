import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Customer-facing Razorpay merchant connection management (Phase 3 scope:
 * connect/verify/disconnect/reconnect only — no payment-transaction
 * functions here, those are Phase 4). Every function here derives
 * organizationId exclusively from the authenticated user's own
 * organization_members row (never from client input — there is no
 * organizationId field in any input schema below), matching the same
 * pattern google-calendar.functions.ts and whatsapp-onboarding.functions.ts
 * already established.
 *
 * startRazorpayConnection/reconnectRazorpayConnection/verifyRazorpayConnection/
 * disconnectRazorpayConnection use supabaseAdmin (dynamically imported
 * inside each handler) because they need to write to razorpay_connections,
 * which has no authenticated-write RLS policy at all — every mutation is
 * server-only, with tenant ownership re-validated in code.
 */

async function resolveOrgId(context: { supabase: unknown; userId: string }): Promise<string> {
  const supabase = context.supabase as import("@supabase/supabase-js").SupabaseClient<
    import("@/integrations/supabase/types").Database
  >;
  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", context.userId)
    .limit(1)
    .maybeSingle();
  if (!membership) throw new Error("No workspace found for your account.");
  return membership.organization_id;
}

async function assertBusinessOwnership(
  supabaseAdmin: import("@supabase/supabase-js").SupabaseClient<
    import("@/integrations/supabase/types").Database
  >,
  organizationId: string,
  businessId: string,
): Promise<void> {
  const { data: business, error } = await supabaseAdmin
    .from("businesses")
    .select("id, organization_id")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw error;
  if (!business || business.organization_id !== organizationId) {
    throw new Error("That business does not belong to your workspace.");
  }
}

/**
 * Read path: RLS-scoped (context.supabase), not supabaseAdmin — the
 * razorpay_connections SELECT policy (is_org_member(organization_id))
 * already does the tenant isolation this needs, and the column-level GRANT
 * already excludes encrypted_credentials, so nothing here needs
 * service-role access.
 */
export const listRazorpayConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const organizationId = await resolveOrgId(context);
    const { data, error } = await context.supabase
      .from("razorpay_connections")
      .select(
        "id, business_id, connection_status, merchant_status, razorpay_account_id, business_name, display_name, email, phone, connected_at, last_verified_at, disconnected_at, last_error, updated_at",
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  });

/**
 * Whether Razorpay is configured on this deployment at all (env vars
 * present) — a boolean only, never leaking which vars or their values.
 * Powers the "Not configured" UI state (spec: distinct from "Not
 * connected") without the frontend ever seeing configuration secrets.
 */
export const getRazorpayIntegrationStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { validateRazorpayEnv } = await import("@/lib/razorpay/razorpay-config.server");
    const { allPresent } = validateRazorpayEnv();
    return { configured: allPresent };
  });

const startInputSchema = z.object({ businessId: z.string().uuid() });

/** Begins (or restarts) a Razorpay connection for a business: creates a fresh OAuth state and returns the URL to send the browser to. */
export const startRazorpayConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { businessId: unknown }) => startInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await assertBusinessOwnership(supabaseAdmin, organizationId, data.businessId);

    const { resolveRazorpayConfig } = await import("@/lib/razorpay/razorpay-config.server");
    const config = resolveRazorpayConfig();
    if (!config) {
      throw new Error("Razorpay is not configured on this deployment yet. Please contact support.");
    }

    const { createOAuthState } = await import("@/lib/google-calendar/oauth-state.server");
    const state = await createOAuthState(supabaseAdmin, {
      provider: "razorpay",
      organizationId,
      businessId: data.businessId,
      userId: context.userId,
      redirectTo: "/app/integrations",
    });

    const { buildAuthorizationUrl } = await import("@/lib/razorpay/razorpay-oauth.server");
    return { authorizationUrl: buildAuthorizationUrl(config, state) };
  });

const connectionIdInputSchema = z.object({ connectionId: z.string().uuid() });

/** Restarts authorization for an existing connection (REAUTH_REQUIRED/ERROR/DISCONNECTED) — same OAuth flow as startRazorpayConnection, scoped to the connection's already-known business. */
export const reconnectRazorpayConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown }) => connectionIdInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: connection, error } = await supabaseAdmin
      .from("razorpay_connections")
      .select("id, organization_id, business_id")
      .eq("id", data.connectionId)
      .maybeSingle();
    if (error) throw error;
    if (!connection || connection.organization_id !== organizationId) {
      throw new Error("That connection does not belong to your workspace.");
    }

    const { resolveRazorpayConfig } = await import("@/lib/razorpay/razorpay-config.server");
    const config = resolveRazorpayConfig();
    if (!config) {
      throw new Error("Razorpay is not configured on this deployment yet. Please contact support.");
    }

    const { createOAuthState } = await import("@/lib/google-calendar/oauth-state.server");
    const state = await createOAuthState(supabaseAdmin, {
      provider: "razorpay",
      organizationId,
      businessId: connection.business_id,
      userId: context.userId,
      redirectTo: "/app/integrations",
    });

    const { buildAuthorizationUrl } = await import("@/lib/razorpay/razorpay-oauth.server");
    return { authorizationUrl: buildAuthorizationUrl(config, state) };
  });

/** Actually verifies the connection is currently usable (a real Razorpay call), not just that a row exists. */
export const verifyRazorpayConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown }) => connectionIdInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { verifyRazorpayConnection: verifyConnection } =
      await import("@/lib/razorpay/razorpay-connection.server");
    return verifyConnection(supabaseAdmin, { organizationId, connectionId: data.connectionId });
  });

export const disconnectRazorpayConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown }) => connectionIdInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { disconnectRazorpayConnection: disconnect } =
      await import("@/lib/razorpay/razorpay-connection.server");
    await disconnect(supabaseAdmin, { organizationId, connectionId: data.connectionId });
    return { ok: true };
  });

/** Businesses the caller's organization owns — powers the "connect for which business" selector, same pattern as listOrgBusinessesForCalendar/listOrgBusinessesForWhatsApp. */
export const listOrgBusinessesForRazorpay = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const organizationId = await resolveOrgId(context);
    const { data, error } = await context.supabase
      .from("businesses")
      .select("id, name")
      .eq("organization_id", organizationId)
      .order("created_at");
    if (error) throw error;
    return data ?? [];
  });
