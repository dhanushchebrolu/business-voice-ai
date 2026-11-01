import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Closes SIP (LiveKit) calls whose signed end event never arrived; never
 * bills them (see reconcileStaleSipCalls). Same cron authentication as the
 * other sweeps. Suggested schedule: every 15 minutes.
 */
export const Route = createFileRoute("/api/public/cron/reconcile-sip-calls")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authError = await authenticateCronRequest(request);
        if (authError) return authError;
        try {
          const { defaultSessionDeps, pruneVoiceAgentNonces, reconcileStaleSipCalls } =
            await import("@/lib/voice-agent/sessions.server");
          const deps = await defaultSessionDeps();
          const summary = await reconcileStaleSipCalls(deps, { olderThanMinutes: 180 });
          await pruneVoiceAgentNonces(deps, { olderThanHours: 24 });
          return new Response(JSON.stringify(summary), {
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          console.error("sip_reconcile:tick_failed", (err as Error).message);
          return new Response("Reconcile error", { status: 500 });
        }
      },
    },
  },
});
