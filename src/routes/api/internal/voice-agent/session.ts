import { createFileRoute } from "@tanstack/react-router";

/**
 * Internal voice-agent API (signed by services/voice-agent; see
 * src/lib/voice-agent/internal-auth.ts). POST only.
 */
export const Route = createFileRoute("/api/internal/voice-agent/session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleSessionStart, defaultHttpDeps } =
          await import("@/lib/voice-agent/http.server");
        return handleSessionStart(request, await defaultHttpDeps());
      },
    },
  },
});
