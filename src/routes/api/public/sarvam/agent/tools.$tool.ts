import { createFileRoute } from "@tanstack/react-router";

/**
 * Mid-call tools and the on-end outcome for a customer's Sarvam agent.
 * HTTP boundary only; see src/lib/sarvam-agent-api.server.ts.
 */
export const Route = createFileRoute("/api/public/sarvam/agent/tools/$tool")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { handleSarvamAgentRequest } = await import("@/lib/sarvam-agent-api.server");
        const { checkSarvamAgentRateLimit } = await import("@/lib/rate-limit.server");
        return handleSarvamAgentRequest(request, params.tool, {
          supabaseAdmin,
          rateLimit: checkSarvamAgentRateLimit,
        });
      },
    },
  },
});
