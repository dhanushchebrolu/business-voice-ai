import { createFileRoute } from "@tanstack/react-router";

/**
 * LiveKit server webhooks (signed JWT; see src/lib/voice-agent/livekit-webhook.ts).
 * Ends and bills calls that came in over Vobiz SIP -> LiveKit.
 */
export const Route = createFileRoute("/api/public/webhooks/livekit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleLiveKitWebhook, defaultHttpDeps } =
          await import("@/lib/voice-agent/http.server");
        return handleLiveKitWebhook(request, await defaultHttpDeps());
      },
    },
  },
});
