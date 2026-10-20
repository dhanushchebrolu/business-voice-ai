import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Recovery sweep for WhatsApp AI replies (whatsapp-ai-reply.server.ts's
 * recoverPendingWhatsAppReplies): retries inbound text messages from the
 * last 30 minutes whose reply never started or was abandoned by a crashed
 * Worker. Every guard and the one-reply-per-message claim still apply, so a
 * message is never answered twice. Same cron-secret mechanism as the other
 * /api/public/cron routes (Bearer LOVABLE_CRON_SECRET); no Cloudflare cron
 * trigger exists for it — schedule it externally, e.g. every 2–5 minutes.
 */
export const Route = createFileRoute("/api/public/cron/whatsapp-replies")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authError = await authenticateCronRequest(request);
        if (authError) return authError;
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { recoverPendingWhatsAppReplies } =
            await import("@/lib/whatsapp/whatsapp-ai-reply.server");
          const summary = await recoverPendingWhatsAppReplies(supabaseAdmin);
          return new Response(
            JSON.stringify({ examined: summary.examined, attempted: summary.attempted }),
            { headers: { "content-type": "application/json" } },
          );
        } catch (err) {
          console.error(
            "whatsapp_replies_cron:failed",
            err instanceof Error
              ? err.message
              : ((err as { message?: string } | null)?.message ?? String(err)),
          );
          return new Response("WhatsApp reply recovery error", { status: 500 });
        }
      },
    },
  },
});
