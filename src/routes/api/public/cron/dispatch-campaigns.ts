import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";
import { dispatchDueCampaigns } from "@/lib/campaign-dispatch.server";

/**
 * The only trigger for outbound campaign dialing (spec §57's "simplest
 * compatible asynchronous mechanism" — no Redis/Kafka/queue infrastructure
 * introduced). Reuses the platform's existing cron-secret mechanism
 * (authenticateCronRequest, already generated for this project but not
 * wired to any route before this) rather than adding a second scheduling
 * system. The platform's own scheduler is expected to POST here on an
 * interval; nothing else may call this endpoint (Bearer LOVABLE_CRON_SECRET
 * required, timing-safe compared).
 */
export const Route = createFileRoute("/api/public/cron/dispatch-campaigns")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authError = await authenticateCronRequest(request);
        if (authError) return authError;

        // Same opt-in as the scheduled job: nothing dials unless explicitly enabled.
        const { campaignDispatchEnabled } = await import("@/lib/jobs/handlers.server");
        if (!campaignDispatchEnabled()) {
          return new Response(JSON.stringify({ skipped: "disabled" }), {
            headers: { "content-type": "application/json" },
          });
        }

        try {
          const summary = await dispatchDueCampaigns();
          return new Response(JSON.stringify(summary), {
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          console.error("campaign_dispatch:tick_failed", (err as Error).message);
          return new Response("Dispatch error", { status: 500 });
        }
      },
    },
  },
});
