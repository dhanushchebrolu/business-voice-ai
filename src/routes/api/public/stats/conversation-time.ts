import { createFileRoute } from "@tanstack/react-router";
import { cachedStatsLoader, loadConversationStats } from "@/lib/conversation-stats.server";

/**
 * Public landing-page counter: the total of seconds ClickAI has handled in
 * conversations, across all customers. Returns three numbers and nothing else;
 * errors reveal nothing.
 */
const load = cachedStatsLoader(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return loadConversationStats(supabaseAdmin);
}, 15_000);

export const Route = createFileRoute("/api/public/stats/conversation-time")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const stats = await load();
          return new Response(JSON.stringify(stats), {
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=10, s-maxage=15",
            },
          });
        } catch (err) {
          console.error("conversation_stats:failed", (err as Error).message);
          return new Response(JSON.stringify({ error: "unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
      },
    },
  },
});
