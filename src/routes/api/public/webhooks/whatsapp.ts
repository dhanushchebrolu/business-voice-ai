import { createFileRoute } from "@tanstack/react-router";

/**
 * Meta WhatsApp Cloud API webhook — the two things Meta requires and no
 * more (Phase 4 WhatsApp scope: "Meta webhook verification. Delivery
 * status handling." — NOT a full inbound-conversation/AI-reply pipeline):
 *
 *   GET  — Meta's one-time (and reconnect-time) subscription handshake.
 *          Echoes back hub.challenge only if hub.verify_token matches our
 *          own WHATSAPP_WEBHOOK_VERIFY_TOKEN (a Klyro-generated shared
 *          secret configured in the Meta App Dashboard's webhook
 *          subscription form — never a Meta-issued value).
 *   POST — delivery-status updates for messages we sent (sent/delivered/
 *          read/failed) plus persistence of inbound customer messages
 *          (needed for whatsapp-payments.server.ts's own 24-hour
 *          free-form-window check — see whatsapp-inbound.server.ts's own
 *          doc comment). No AI reply is ever generated from this route.
 *
 * Idempotency reuses the existing generic webhook_events table
 * (provider='whatsapp'), per that table's own established convention
 * (see 20260923090000_whatsapp_business_integration.sql's header comment)
 * — no new table introduced. Meta's POST body itself has no single
 * request-level id, so the raw body is hashed to form a stable dedupe key
 * for exact-duplicate redelivery; per-item idempotency for individual
 * messages/statuses is additionally handled by whatsapp_messages' own
 * constraints (defense-in-depth, same pattern the migration documents for
 * call_logs.provider_call_id).
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

        const { processInboundWhatsAppWebhook } =
          await import("@/lib/whatsapp/whatsapp-inbound.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { createHash } = await import("node:crypto");

        // Meta's payload has no request-level event id (unlike Razorpay's
        // x-razorpay-event-id header); a hash of the exact body is a
        // stable, collision-safe dedupe key for the webhook_events unique
        // index (provider, event_id) covering exact-duplicate redelivery.
        const eventId = createHash("sha256").update(raw).digest("hex");

        try {
          const result = await processInboundWhatsAppWebhook(supabaseAdmin, {
            rawBody: raw,
            eventId,
          });
          return new Response(JSON.stringify({ outcome: result.outcome }), {
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          console.error(
            "whatsapp_webhook:processing_failed",
            err instanceof Error ? err.message : err,
          );
          // Always 200 to Meta even on an internal processing error — a
          // non-2xx response makes Meta retry-storm the same batch, and a
          // failure here is never payment/booking truth (this route never
          // touches either), so there is nothing unsafe about acking receipt
          // while logging the failure for investigation.
          return new Response(JSON.stringify({ outcome: "error" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      },
    },
  },
});
