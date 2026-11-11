import { createFileRoute } from "@tanstack/react-router";

/**
 * On-start business context for a customer's Sarvam agent. HTTP boundary
 * only; authentication, tenant resolution and the response live in
 * src/lib/sarvam-agent-api.server.ts.
 */
export const Route = createFileRoute("/api/public/sarvam/agent/context")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { handleSarvamAgentRequest } = await import("@/lib/sarvam-agent-api.server");
        const { checkSarvamAgentRateLimit } = await import("@/lib/rate-limit.server");
        return handleSarvamAgentRequest(request, undefined, {
          supabaseAdmin,
          rateLimit: checkSarvamAgentRateLimit,
        });
      },
    },
  },
});
