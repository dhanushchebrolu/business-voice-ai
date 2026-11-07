import { createFileRoute } from "@tanstack/react-router";

/**
 * Independent maximum-duration backstop for inbound SIP calls (see
 * sweepOverdueSipRooms): deletes the LiveKit room of calls the voice agent
 * could not end itself, so a caller is never left connected to nobody.
 * Authenticated with the voice-agent cron credential (cron-auth.server.ts).
 * Scheduled every 5 minutes
 * (scripts/staging/schedule-cron.sql for staging). Every step is a
 * conditional update, so overlapping or repeated runs are harmless.
 */
export const Route = createFileRoute("/api/public/cron/sweep-sip-rooms")({
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
            "sweep-sip-rooms",
            await defaultCronAuthDeps(),
          );
        } catch (err) {
          console.error("voice_agent:cron_auth_error", {
            route: "sweep-sip-rooms",
            error: (err as Error).name,
          });
          return new Response(JSON.stringify({ error: "unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        if (!auth.ok) return auth.response;
        try {
          const { defaultRoomSweepDeps, sweepFailed, sweepOverdueSipRooms } =
            await import("@/lib/voice-agent/room-sweep.server");
          const summary = await sweepOverdueSipRooms(await defaultRoomSweepDeps());
          // One line per run: its absence is the missed-run alert (STAGING.md §6c).
          // 503: LiveKit credentials missing (backstop off). 500: database or
          // row errors (the run could not reliably do its job).
          const status = summary.unconfigured ? 503 : sweepFailed(summary) ? 500 : 200;
          if (status === 200) console.info("sip_room_sweep:tick", summary);
          else console.error("sip_room_sweep:tick_failed", summary);
          return new Response(JSON.stringify(summary), {
            status,
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          // Selection failed (database error): nothing was attempted.
          console.error("sip_room_sweep:tick_failed", { error: (err as Error).message });
          return new Response("Room sweep error", { status: 500 });
        }
      },
    },
  },
});
