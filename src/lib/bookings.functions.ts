import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Dashboard-facing booking management (spec section 42's "basic booking
 * interface"). Deliberately separate from calendar-tools.server.ts, which
 * gates the AI agent's own use of the same booking-service.server.ts core
 * behind that agent's configured tool permissions — a staff member acting
 * from their own dashboard is authorizing themselves as the business
 * owner, not exercising a permission granted to their AI agent, so this
 * file checks organization/business ownership directly instead of an
 * agent's capabilities JSONB.
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

/** RLS-scoped read — the bookings SELECT policy (is_org_member(organization_id)) already does the tenant isolation this needs. */
export const listBookings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const organizationId = await resolveOrgId(context);
    const { data, error } = await context.supabase
      .from("bookings")
      .select(
        "id, business_id, status, start_at, end_at, timezone, customer_name, customer_phone, source, google_event_id, created_at",
      )
      .eq("organization_id", organizationId)
      .order("start_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  });

const createInputSchema = z.object({
  businessId: z.string().uuid(),
  customerName: z.string().min(1),
  customerPhone: z.string().min(1).optional(),
  customerEmail: z.string().email().optional(),
  serviceId: z.string().uuid().optional().nullable(),
  startIso: z.string().datetime(),
  endIso: z.string().datetime(),
  notes: z.string().optional(),
});

export const createBookingManual = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => createInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: business, error: businessError } = await supabaseAdmin
      .from("businesses")
      .select("id, organization_id, name, timezone")
      .eq("id", data.businessId)
      .maybeSingle();
    if (businessError) throw businessError;
    if (!business || business.organization_id !== organizationId) {
      throw new Error("That business does not belong to your workspace.");
    }

    const { data: connection, error: connectionError } = await supabaseAdmin
      .from("google_calendar_connections")
      .select("id, calendar_id, status")
      .eq("organization_id", organizationId)
      .eq("business_id", data.businessId)
      .eq("provider", "google")
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection || connection.status !== "CONNECTED" || !connection.calendar_id) {
      throw new Error("Connect a Google Calendar for this business before creating bookings.");
    }

    const { getCalendarProviderForConnection } =
      await import("@/lib/google-calendar/google-calendar-connection.server");
    const { provider, calendarId } = await getCalendarProviderForConnection(
      supabaseAdmin,
      connection.id,
    );

    const { createBooking } = await import("@/lib/calendar/booking-service.server");
    const booking = await createBooking(supabaseAdmin, provider, {
      organizationId,
      businessId: data.businessId,
      calendarConnectionId: connection.id,
      calendarId,
      serviceId: data.serviceId ?? null,
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      customerEmail: data.customerEmail,
      startIso: data.startIso,
      endIso: data.endIso,
      timezone: business.timezone,
      source: "manual",
      notes: data.notes,
      businessName: business.name,
    });
    return booking;
  });

const rescheduleInputSchema = z.object({
  bookingId: z.string().uuid(),
  newStartIso: z.string().datetime(),
  newEndIso: z.string().datetime(),
});

export const rescheduleBookingManual = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => rescheduleInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: booking, error } = await supabaseAdmin
      .from("bookings")
      .select("id, organization_id, calendar_connection_id")
      .eq("id", data.bookingId)
      .maybeSingle();
    if (error) throw error;
    if (!booking || booking.organization_id !== organizationId) {
      throw new Error("Booking not found.");
    }
    if (!booking.calendar_connection_id) {
      throw new Error("This booking has no connected calendar to reschedule against.");
    }

    const { data: connection, error: connectionError } = await supabaseAdmin
      .from("google_calendar_connections")
      .select("calendar_id")
      .eq("id", booking.calendar_connection_id)
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection?.calendar_id)
      throw new Error("This booking's calendar connection is no longer configured.");

    const { getCalendarProviderForConnection } =
      await import("@/lib/google-calendar/google-calendar-connection.server");
    const { provider, calendarId } = await getCalendarProviderForConnection(
      supabaseAdmin,
      booking.calendar_connection_id,
    );

    const { rescheduleBooking } = await import("@/lib/calendar/booking-service.server");
    return rescheduleBooking(supabaseAdmin, provider, {
      organizationId,
      bookingId: data.bookingId,
      calendarId,
      newStartIso: data.newStartIso,
      newEndIso: data.newEndIso,
    });
  });

const cancelInputSchema = z.object({
  bookingId: z.string().uuid(),
  reason: z.string().optional(),
});

export const cancelBookingManual = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => cancelInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: booking, error } = await supabaseAdmin
      .from("bookings")
      .select("id, organization_id, calendar_connection_id")
      .eq("id", data.bookingId)
      .maybeSingle();
    if (error) throw error;
    if (!booking || booking.organization_id !== organizationId) {
      throw new Error("Booking not found.");
    }

    let calendarId = "";
    if (booking.calendar_connection_id) {
      const { data: connection, error: connectionError } = await supabaseAdmin
        .from("google_calendar_connections")
        .select("calendar_id")
        .eq("id", booking.calendar_connection_id)
        .maybeSingle();
      if (connectionError) throw connectionError;
      calendarId = connection?.calendar_id ?? "";
    }

    const { cancelBooking } = await import("@/lib/calendar/booking-service.server");

    if (!calendarId || !booking.calendar_connection_id) {
      // No connected calendar (or it's since been removed) — cancel the
      // ClickAI booking record without touching a Google event, since
      // there's nothing left to delete provider-side.
      const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
      const { data: cancelled, error: cancelError } = await admin
        .from("bookings")
        .update({ status: "CANCELLED", notes: data.reason ? `Cancelled: ${data.reason}` : null })
        .eq("id", data.bookingId)
        .select("id, status, start_at, end_at, timezone, google_event_id, contact_id")
        .single();
      if (cancelError) throw cancelError;
      return cancelled;
    }

    const { getCalendarProviderForConnection } =
      await import("@/lib/google-calendar/google-calendar-connection.server");
    const { provider } = await getCalendarProviderForConnection(
      supabaseAdmin,
      booking.calendar_connection_id,
    );
    return cancelBooking(supabaseAdmin, provider, {
      organizationId,
      bookingId: data.bookingId,
      calendarId,
      reason: data.reason,
    });
  });
