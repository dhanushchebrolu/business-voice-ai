import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Customer-facing Google Calendar connection management. No input schema
 * below has an organizationId field: reads derive it from the caller's own
 * organization_members row, and every MUTATION (connect, list/select a
 * calendar, test, reconnect, disconnect) derives it from the target
 * business/connection row and then requires the caller to be an owner or
 * admin of exactly that organization (requireCalendarManager in
 * calendar-access.server.ts).
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

type AdminClient = import("@supabase/supabase-js").SupabaseClient<
  import("@/integrations/supabase/types").Database
>;

async function requireManager(
  supabaseAdmin: AdminClient,
  userId: string,
  target: { businessId: string } | { connectionId: string },
) {
  const { requireCalendarManager } = await import("@/lib/google-calendar/calendar-access.server");
  return requireCalendarManager(supabaseAdmin, userId, target);
}

/**
 * Re-throws any failure as an Error carrying only customer-safe wording —
 * raw Google/provider/database messages never reach the browser. The
 * access-check messages are already customer-safe and pass through.
 */
async function rethrowFriendly(err: unknown, logTag: string): Promise<never> {
  const { CalendarAccessError } = await import("@/lib/google-calendar/calendar-access.server");
  if (err instanceof CalendarAccessError) throw new Error(err.message);
  const { googleCalendarIssueCode, googleCalendarIssueMessage } =
    await import("@/lib/google-calendar/google-calendar-errors");
  const code = googleCalendarIssueCode(err);
  console.error(logTag, { code });
  throw new Error(googleCalendarIssueMessage(code));
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const scope = await requireManager(supabaseAdmin, context.userId, {
      businessId: data.businessId,
    }).catch((err) => rethrowFriendly(err, "google_calendar_connect:denied"));

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
      organizationId: scope.organizationId,
      businessId: scope.businessId,
      userId: context.userId,
      redirectTo: "/app/integrations",
    });

    // Bind this state to the browser that asked for it; the callback
    // rejects a state whose cookie does not match.
    const { setCookie } = await import("@tanstack/react-start/server");
    const { GOOGLE_OAUTH_STATE_COOKIE, googleOAuthStateCookieOptions } =
      await import("@/lib/google-calendar/oauth-state-cookie.server");
    setCookie(GOOGLE_OAUTH_STATE_COOKIE, state, { ...googleOAuthStateCookieOptions });

    const { buildAuthorizationUrl } = await import("@/lib/google-calendar/google-oauth.server");
    return { authorizationUrl: buildAuthorizationUrl(config, GOOGLE_CALENDAR_SCOPES, state) };
  });

const listCalendarsInputSchema = z.object({ connectionId: z.string().uuid() });

export const listGoogleCalendars = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown }) => listCalendarsInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    try {
      const scope = await requireManager(supabaseAdmin, context.userId, {
        connectionId: data.connectionId,
      });
      const { listWritableCalendarsForConnection } =
        await import("@/lib/google-calendar/google-calendar-connection.server");
      // Only calendars ClickAI can create events in are offered.
      return await listWritableCalendarsForConnection(supabaseAdmin, {
        organizationId: scope.organizationId,
        connectionId: data.connectionId,
      });
    } catch (err) {
      return rethrowFriendly(err, "google_calendar_list_calendars:failed");
    }
  });

const selectCalendarInputSchema = z.object({
  connectionId: z.string().uuid(),
  calendarId: z.string().min(1).max(1024),
});

export const selectGoogleCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown; calendarId: unknown }) =>
    selectCalendarInputSchema.parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let selected: { calendarId: string; calendarName: string };
    try {
      const scope = await requireManager(supabaseAdmin, context.userId, {
        connectionId: data.connectionId,
      });
      const { selectCalendarForConnection } =
        await import("@/lib/google-calendar/google-calendar-connection.server");
      selected = await selectCalendarForConnection(supabaseAdmin, {
        organizationId: scope.organizationId,
        connectionId: data.connectionId,
        calendarId: data.calendarId,
      });
    } catch (err) {
      return rethrowFriendly(err, "google_calendar_select:failed");
    }

    // Start push notifications right away instead of waiting for the next
    // cron tick. Best-effort: when it can't be started (e.g. no webhook
    // URL configured) the periodic sync still picks up changes.
    let pushNotifications: "active" | "unavailable" = "unavailable";
    try {
      const { ensureWatchChannel } =
        await import("@/lib/google-calendar/google-calendar-sync.server");
      await ensureWatchChannel(supabaseAdmin, data.connectionId);
      pushNotifications = "active";
    } catch (err) {
      const { googleCalendarIssueCode } =
        await import("@/lib/google-calendar/google-calendar-errors");
      console.info("google_calendar_select:watch_not_started", {
        connectionId: data.connectionId,
        code: googleCalendarIssueCode(err),
      });
    }
    return { ok: true, calendarName: selected.calendarName, pushNotifications };
  });

const testInputSchema = z.object({ connectionId: z.string().uuid() });

export const testGoogleCalendarConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown }) => testInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    try {
      const scope = await requireManager(supabaseAdmin, context.userId, {
        connectionId: data.connectionId,
      });
      const { testGoogleCalendarConnection: runTest } =
        await import("@/lib/google-calendar/google-calendar-connection.server");
      return await runTest(supabaseAdmin, {
        organizationId: scope.organizationId,
        connectionId: data.connectionId,
      });
    } catch (err) {
      return rethrowFriendly(err, "google_calendar_test:failed");
    }
  });

const disconnectInputSchema = z.object({ connectionId: z.string().uuid() });

export const disconnectGoogleCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown }) => disconnectInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    try {
      const scope = await requireManager(supabaseAdmin, context.userId, {
        connectionId: data.connectionId,
      });
      const { disconnectGoogleCalendarConnection } =
        await import("@/lib/google-calendar/google-calendar-connection.server");
      const result = await disconnectGoogleCalendarConnection(supabaseAdmin, {
        organizationId: scope.organizationId,
        connectionId: data.connectionId,
      });
      return { ok: true, ...result };
    } catch (err) {
      return rethrowFriendly(err, "google_calendar_disconnect:failed");
    }
  });

/**
 * What the Integrations page needs beyond the connection rows: whether the
 * caller may manage the integration (owner/admin; the server re-checks on
 * every action regardless), and how many upcoming bookings per business
 * are saved but still missing their Google Calendar event.
 */
export const getGoogleCalendarIntegrationStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: membership, error } = await context.supabase
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", context.userId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!membership) throw new Error("No workspace found for your account.");
    const { CALENDAR_MANAGER_ROLES } = await import("@/lib/google-calendar/calendar-access.server");

    const { data: failed, error: failedError } = await context.supabase
      .from("bookings")
      .select("business_id")
      .eq("organization_id", membership.organization_id)
      .eq("status", "CALENDAR_SYNC_FAILED")
      .gte("start_at", new Date().toISOString())
      .limit(500);
    if (failedError) throw failedError;
    const syncFailedByBusiness: Record<string, number> = {};
    for (const row of failed ?? []) {
      syncFailedByBusiness[row.business_id] = (syncFailedByBusiness[row.business_id] ?? 0) + 1;
    }
    return {
      canManage: CALENDAR_MANAGER_ROLES.includes(membership.role),
      syncFailedByBusiness,
    };
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
