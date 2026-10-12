import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const retryCalendarSyncInputSchema = z.object({ bookingId: z.string().uuid() });

/**
 * Staff action: retry the Google Calendar event for a booking that is
 * saved but CALENDAR_SYNC_FAILED. The organization comes from the booking
 * row itself; the caller must be a member of THAT organization with a role
 * that may change bookings (anything but viewer — the same write rule as
 * the calendar dashboard). A booking in another workspace is reported as
 * "not found", never acted on.
 */
export const retryBookingCalendarSyncManual = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => retryCalendarSyncInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: booking, error } = await supabaseAdmin
      .from("bookings")
      .select("id, organization_id")
      .eq("id", data.bookingId)
      .maybeSingle();
    if (error) throw error;
    if (!booking) throw new Error("Booking not found.");

    const { data: membership, error: memberError } = await supabaseAdmin
      .from("organization_members")
      .select("role")
      .eq("organization_id", booking.organization_id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!membership) throw new Error("Booking not found.");
    if (membership.role === "viewer") {
      throw new Error("Your role only allows viewing bookings, not changing them.");
    }

    const { retryBookingCalendarSync } = await import("@/lib/calendar/booking-service.server");
    const { getCalendarProviderForConnection } =
      await import("@/lib/google-calendar/google-calendar-connection.server");
    const result = await retryBookingCalendarSync(
      supabaseAdmin,
      (connectionId) => getCalendarProviderForConnection(supabaseAdmin, connectionId),
      { organizationId: booking.organization_id, bookingId: booking.id, trigger: "staff" },
    );
    return { ...result, message: describeCalendarSyncRetry(result) };
  });

function describeCalendarSyncRetry(result: { outcome: string; reason?: string }): string {
  switch (result.outcome) {
    case "confirmed":
      return "Added to Google Calendar. The booking is now confirmed.";
    case "lost_race":
      return "This booking changed while retrying, so nothing was updated. Refresh to see its current status.";
    case "failed":
      return "Google Calendar still couldn't be updated. The booking stays saved; check the Google Calendar connection on the Integrations page and try again.";
    default:
      switch (result.reason) {
        case "in_past":
          return "This appointment has already started, so it can't be added to Google Calendar any more.";
        case "not_sync_failed":
          return "This booking no longer needs a calendar retry.";
        case "no_calendar_connection":
          return "This business has no working Google Calendar connection. Reconnect it on the Integrations page, then retry.";
        case "already_in_progress":
          return "A retry for this booking is already running. Refresh in a moment.";
        default:
          return "Booking not found.";
      }
  }
}
