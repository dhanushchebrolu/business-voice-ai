import { createFileRoute } from "@tanstack/react-router";

/**
 * WhatsApp webhook: deliveries from Vobiz (ClickAI's WhatsApp BSP), from the
 * account-level subscription created once with `POST
 * /api/v1/messaging/webhooks` pointing here. POST only (Meta's GET
 * verification handshake belonged to the retired direct-Meta webhook).
 *
 * All behaviour — signature check before anything else (401), event_id
 * deduplication, background AI replies, 500 on a storage failure so Vobiz
 * retries — lives in whatsapp-webhook-handler.server.ts, which is tested at
 * runtime; this file only wires production dependencies.
 */
export const Route = createFileRoute("/api/public/webhooks/whatsapp")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleWhatsAppWebhookPost } =
          await import("@/lib/whatsapp/whatsapp-webhook-handler.server");
        return handleWhatsAppWebhookPost(request, {
          getSupabaseAdmin: async () =>
            (await import("@/integrations/supabase/client.server")).supabaseAdmin,
          replyInBackground: (supabaseAdmin, messageIds, req) => {
            void (async () => {
              const { replyToInboundWhatsAppMessages } =
                await import("@/lib/whatsapp/whatsapp-ai-reply.server");
              const { getRequestWaitUntil, runInBackground } =
                await import("@/lib/background-task.server");
              // AI replies run after Vobiz has its 200 — never blocking the
              // acknowledgement on model latency. An interrupted reply is
              // picked up by /api/public/cron/whatsapp-replies.
              runInBackground(
                replyToInboundWhatsAppMessages(supabaseAdmin, messageIds),
                getRequestWaitUntil(req),
                "whatsapp_ai_reply:background_failed",
              );
            })();
          },
        });
      },
    },
  },
});
