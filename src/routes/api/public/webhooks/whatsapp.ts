import { createFileRoute } from "@tanstack/react-router";

/**
 * Meta WhatsApp Cloud API webhook.
 *
 *   GET  — Meta's subscription handshake. Echoes back hub.challenge only if
 *          hub.verify_token matches our own WHATSAPP_WEBHOOK_VERIFY_TOKEN (a
 *          ClickAI-generated secret entered in the Meta App Dashboard).
 *   POST — authenticated first: the X-Hub-Signature-256 HMAC of the raw body
 *          with META_APP_SECRET must match, or the request is refused (403)
 *          before anything is parsed or stored. Then delivery-status updates
 *          and inbound messages are stored (whatsapp-inbound.server.ts), Meta
 *          gets its 200, and AI replies to new inbound text messages run in
 *          the background (whatsapp-ai-reply.server.ts) — never delaying the
 *          acknowledgement. If storing fails, the event's claim is released
 *          and the route answers 500 so Meta retries.
 *
 * Idempotency: the raw body is hashed into a webhook_events claim (provider
 * 'whatsapp') for exact redeliveries, and each message is unique per
 * (connection, wa_message_id), so a retry never stores or answers a message
 * twice.
 */
export const Route = createFileRoute("/api/public/webhooks/whatsapp")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const verifyToken = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");

        return import("@/lib/whatsapp/whatsapp-inbound.server").then(
          ({ verifyWebhookHandshake }) => {
            const echoedChallenge = verifyWebhookHandshake({ mode, verifyToken, challenge });
            if (echoedChallenge === null) {
              return new Response("Forbidden", { status: 403 });
            }
            return new Response(echoedChallenge, { status: 200 });
          },
        );
      },
      POST: async ({ request }) => {
        const raw = await request.text();
        const { verifyWhatsAppWebhookSignature, processInboundWhatsAppWebhook } =
          await import("@/lib/whatsapp/whatsapp-inbound.server");

        // Authenticate before parsing or storing anything: Meta signs every
        // POST with the app secret (X-Hub-Signature-256).
        if (!verifyWhatsAppWebhookSignature(raw, request.headers.get("x-hub-signature-256"))) {
          console.error("whatsapp_webhook:invalid_signature");
          return new Response("Forbidden", { status: 403 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { createHash } = await import("node:crypto");
        const eventId = createHash("sha256").update(raw).digest("hex");

        try {
          const result = await processInboundWhatsAppWebhook(supabaseAdmin, {
            rawBody: raw,
            eventId,
          });
          // AI replies run after Meta has its 200 — never blocking the
          // acknowledgement on model latency. An interrupted reply is picked
          // up by /api/public/cron/whatsapp-replies.
          if (result.newInboundTextMessageIds.length > 0) {
            const { replyToInboundWhatsAppMessages } =
              await import("@/lib/whatsapp/whatsapp-ai-reply.server");
            const { getRequestWaitUntil, runInBackground } =
              await import("@/lib/background-task.server");
            runInBackground(
              replyToInboundWhatsAppMessages(supabaseAdmin, result.newInboundTextMessageIds),
              getRequestWaitUntil(request),
              "whatsapp_ai_reply:background_failed",
            );
          }
          return new Response(JSON.stringify({ outcome: result.outcome }), {
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          // The event's claim was released: answer 5xx so Meta retries it.
          console.error(
            "whatsapp_webhook:processing_failed",
            err instanceof Error
              ? err.message
              : ((err as { message?: string } | null)?.message ?? String(err)),
          );
          return new Response(JSON.stringify({ outcome: "error" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      },
    },
  },
});
