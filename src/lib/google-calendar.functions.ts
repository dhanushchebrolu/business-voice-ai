import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Customer-facing Google Calendar connection management. Every function
 * here derives organizationId exclusively from the authenticated user's
 * own organization_members row (never from client input — there is no
 * organizationId field in any input schema below), matching the same
 * pattern whatsapp-onboarding.functions.ts and whatsapp-connection.
 * functions.ts already established.
 *
 * connectGoogleCalendar/listGoogleCalendars/selectGoogleCalendar/
 * disconnectGoogleCalendar use supabaseAdmin (dynamically imported inside
 * each handler, matching whatsapp-onboarding.functions.ts's convention)
 * because they need to write to google_calendar_connections, which has no
 * authenticated-write RLS policy at all — every mutation is server-only,
 * with tenant ownership re-validated in code rather than relied on from
 * RLS for the write path itself.
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
 * google_calendar_connections SELECT policy (is_org_member(organization_id))
 * already does the tenant isolation this needs, and the column-level GRANT
 * already excludes encrypted_credentials, so nothing here needs
 * service-role access.
 */
export const listGoogleCalendarConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const organizationId = await resolveOrgId(context);
    const { data, error } = await context.supabase
      .from("google_calendar_connections")
      .select(
        "id, business_id, google_email, calendar_id, calendar_name, status, last_connected_at, last_error, updated_at",
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  });

const connectInputSchema = z.object({ businessId: z.string().uuid() });

export const connectGoogleCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { businessId: unknown }) => connectInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await assertBusinessOwnership(supabaseAdmin, organizationId, data.businessId);

    const { resolveGoogleCalendarConfig, GOOGLE_CALENDAR_SCOPES } =
      await import("@/lib/google-calendar/google-calendar-config.server");
    const config = resolveGoogleCalendarConfig();
    if (!config) {
      throw new Error(
        "Google Calendar is not configured on this deployment yet. Please contact support.",
      );
    }

    const { createOAuthState } = await import("@/lib/google-calendar/oauth-state.server");
    const state = await createOAuthState(supabaseAdmin, {
      provider: "google_calendar",
      organizationId,
      businessId: data.businessId,
      userId: context.userId,
      redirectTo: "/app/integrations",
    });

    const { buildAuthorizationUrl } = await import("@/lib/google-calendar/google-oauth.server");
    return { authorizationUrl: buildAuthorizationUrl(config, GOOGLE_CALENDAR_SCOPES, state) };
  });

const listCalendarsInputSchema = z.object({ connectionId: z.string().uuid() });

export const listGoogleCalendars = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown }) => listCalendarsInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: connection, error } = await supabaseAdmin
      .from("google_calendar_connections")
      .select("id, organization_id")
      .eq("id", data.connectionId)
      .maybeSingle();
    if (error) throw error;
    if (!connection || connection.organization_id !== organizationId) {
      throw new Error("That connection does not belong to your workspace.");
    }

    const { getCalendarProviderForConnection } =
      await import("@/lib/google-calendar/google-calendar-connection.server");
    const { provider } = await getCalendarProviderForConnection(supabaseAdmin, data.connectionId);
    return provider.listCalendars();
  });

const selectCalendarInputSchema = z.object({
  connectionId: z.string().uuid(),
  calendarId: z.string().min(1),
  calendarName: z.string().min(1),
});

export const selectGoogleCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown; calendarId: unknown; calendarName: unknown }) =>
    selectCalendarInputSchema.parse(input),
  )
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { selectCalendarForConnection } =
      await import("@/lib/google-calendar/google-calendar-connection.server");
    await selectCalendarForConnection(supabaseAdmin, { organizationId, ...data });
    return { ok: true };
  });

const disconnectInputSchema = z.object({ connectionId: z.string().uuid() });

export const disconnectGoogleCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown }) => disconnectInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { disconnectGoogleCalendarConnection } =
      await import("@/lib/google-calendar/google-calendar-connection.server");
    await disconnectGoogleCalendarConnection(supabaseAdmin, {
      organizationId,
      connectionId: data.connectionId,
    });
    return { ok: true };
  });

/** Businesses the caller's organization owns — powers the "connect for which business" selector, same pattern as listOrgBusinessesForWhatsApp. */
export const listOrgBusinessesForCalendar = createServerFn({ method: "GET" })
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
