import { createFileRoute } from "@tanstack/react-router";

/**
 * Meta Instagram webhook (delivered via the linked Facebook Page's
 * subscription — see meta-instagram-client.server.ts's subscribePageWebhook).
 * Mirrors whatsapp.ts's structure exactly:
 *
 *   GET  — Meta's subscription handshake (hub.mode/hub.verify_token/
 *          hub.challenge), checked against INSTAGRAM_WEBHOOK_VERIFY_TOKEN.
 *   POST — signature-verified (X-Hub-Signature-256, see
 *          instagram-inbound.server.ts's verifyWebhookSignature),
 *          deduplicated via webhook_events(provider='instagram'), then
 *          routed to instagram-inbound.server.ts for message/comment
 *          persistence, AI auto-reply, and comment automation.
 *
 * Always returns 200 to Meta once the request is authenticated — an
 * internal processing error is logged, never surfaced as a non-2xx (which
 * would make Meta retry-storm the batch), matching whatsapp.ts's own
 * documented reasoning. The one case that DOES reject before processing
 * is a failed signature check — an unauthenticated payload is never
 * handed to any parsing/persistence code.
 */
export const Route = createFileRoute("/api/public/webhooks/instagram")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const verifyToken = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");

        return import("@/lib/instagram/instagram-inbound.server").then(
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
        const signatureHeader = request.headers.get("x-hub-signature-256");

        const { verifyWebhookSignature, processInboundInstagramWebhook } =
          await import("@/lib/instagram/instagram-inbound.server");

        if (!verifyWebhookSignature(raw, signatureHeader)) {
          console.error("instagram_webhook:invalid_signature");
          return new Response("Forbidden", { status: 403 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { createHash } = await import("node:crypto");
        const eventId = createHash("sha256").update(raw).digest("hex");

        try {
          const result = await processInboundInstagramWebhook(supabaseAdmin, {
            rawBody: raw,
            eventId,
          });
          return new Response(JSON.stringify({ outcome: result.outcome }), {
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          console.error(
            "instagram_webhook:processing_failed",
            err instanceof Error ? err.message : err,
          );
          return new Response(JSON.stringify({ outcome: "error" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      },
    },
  },
});
