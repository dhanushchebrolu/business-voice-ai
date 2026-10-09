import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Periodic Google Calendar reconciliation sweep (hospital calendar spec
 * section 6: "periodic reconciliation... reuse and complete the existing
 * infrastructure where possible"). Same cron-secret mechanism as
 * expire-payments.ts (Bearer LOVABLE_CRON_SECRET, timing-safe) — no new
 * scheduling infrastructure introduced.
 *
 * Does two things for every CONNECTED Google Calendar connection:
 *   1. Renews its push-notification channel once it's within 24h of
 *      Google's imposed expiration (so a connection is never silently left
 *      without live notifications because nothing else renewed it).
 *   2. Re-runs the same incremental sync a webhook notification would have
 *      triggered — the documented fallback for a notification that was
 *      never delivered, delayed, or dropped.
 *
 * No Cloudflare cron trigger is configured for this route in
 * wrangler.json — scheduling it (e.g. hourly) is an ops-level deployment
 * step, not implemented here, matching expire-payments.ts's own documented
 * limitation.
 */
export const Route = createFileRoute("/api/public/cron/sync-google-calendars")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authError = await authenticateCronRequest(request);
        if (authError) return authError;

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { runPeriodicGoogleCalendarSync } =
            await import("@/lib/google-calendar/google-calendar-sync.server");

          const summary = await runPeriodicGoogleCalendarSync(supabaseAdmin);
          return new Response(JSON.stringify(summary), {
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          console.error(
            "google_calendar_sync:periodic_sweep_failed",
            err instanceof Error ? err.message : err,
          );
          return new Response("Sync sweep error", { status: 500 });
        }
      },
    },
  },
});
