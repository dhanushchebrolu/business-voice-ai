import { createFileRoute } from "@tanstack/react-router";

/**
 * Reconciles SIP (LiveKit) calls (see reconcileStaleSipCalls): closes
 * outbound rows that were never dialled or whose dial never completed,
 * bills once from klyro's own timestamps when LiveKit's signed end event is
 * missing but the agent reported the end, closes the rest unbilled, and
 * retries billing left pending. Authenticated with the voice-agent cron
 * credential (cron-auth.server.ts). Scheduled every 15 minutes (scripts/staging/schedule-cron.sql
 * for staging). Every step is idempotent, so overlapping or repeated runs
 * are harmless.
 */
export const Route = createFileRoute("/api/public/cron/reconcile-sip-calls")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // F14: route-specific credential (VOICE_AGENT_CRON_SECRET; signed
        // and replay-protected, or a route-scoped bearer), failed-auth and
        // per-route run limits (src/lib/voice-agent/cron-auth.server.ts).
        let auth;
        try {
          const { authenticateVoiceCron, defaultCronAuthDeps } =
            await import("@/lib/voice-agent/cron-auth.server");
          auth = await authenticateVoiceCron(
            request,
            "reconcile-sip-calls",
            await defaultCronAuthDeps(),
          );
        } catch (err) {
          console.error("voice_agent:cron_auth_error", {
            route: "reconcile-sip-calls",
            error: (err as Error).name,
          });
          return new Response(JSON.stringify({ error: "unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        if (!auth.ok) return auth.response;
        try {
          const {
            defaultSessionDeps,
            pruneVoiceAgentNonces,
            pruneVoiceAgentRateLimits,
            reconcileStaleSipCalls,
          } = await import("@/lib/voice-agent/sessions.server");
          const deps = await defaultSessionDeps();
          const summary = await reconcileStaleSipCalls(deps);
          await pruneVoiceAgentNonces(deps, { olderThanHours: 24 });
          await pruneVoiceAgentRateLimits(deps, { olderThanHours: 24 });
          // One line per run: the absence of this log is the missed-run alert.
          console.info("sip_reconcile:tick", summary);
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
