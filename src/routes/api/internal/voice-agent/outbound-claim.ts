import { createFileRoute } from "@tanstack/react-router";

/**
 * Internal voice-agent API (signed by services/voice-agent; see
 * src/lib/voice-agent/internal-auth.ts). POST only. The agent claims an
 * outbound call row before dialling; see handleOutboundClaim.
 */
export const Route = createFileRoute("/api/internal/voice-agent/outbound-claim")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleOutboundClaim, defaultHttpDeps } =
          await import("@/lib/voice-agent/http.server");
        return handleOutboundClaim(request, await defaultHttpDeps());
      },
    },
  },
});
