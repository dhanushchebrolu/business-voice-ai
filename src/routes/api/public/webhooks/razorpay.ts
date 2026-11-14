import { createFileRoute } from "@tanstack/react-router";

/**
 * Razorpay webhook for ClickAI's own charges (setup fee, monthly plan, phone
 * service fee) — the single source of truth for unlocking an account.
 * The signature is verified before anything is read from the payload; the
 * event ledger, payment-level idempotency and provisioning live in
 * src/lib/payments/razorpay-platform-webhook.server.ts.
 *
 * Responses: 200 once the event is fully applied (or was already); 500 when
 * any write failed, so Razorpay redelivers and the event is processed again.
 */
export const Route = createFileRoute("/api/public/webhooks/razorpay")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getRazorpayWebhookSecret, verifySignature } = await import("@/lib/razorpay.server");
        const secret = getRazorpayWebhookSecret();
        if (!secret) {
          console.error("razorpay:webhook_secret_missing");
          return new Response("Not configured", { status: 503 });
        }

        const raw = await request.text();
        const signature = request.headers.get("x-razorpay-signature") ?? "";
        if (!signature || !verifySignature(raw, signature, secret)) {
          return new Response("Invalid signature", { status: 401 });
        }

        let event: import("@/lib/payments/razorpay-platform-webhook.server").RazorpayEvent;
        try {
          event = JSON.parse(raw);
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }

        const eventId = request.headers.get("x-razorpay-event-id") ?? "";
        if (!eventId) return new Response("Missing event id", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { claimWebhookEvent, markWebhookEvent, processRazorpayPlatformEvent } =
          await import("@/lib/payments/razorpay-platform-webhook.server");

        let decision;
        try {
          decision = await claimWebhookEvent(supabaseAdmin, eventId, event, JSON.parse(raw));
        } catch (err) {
          console.error("razorpay:webhook_store_failed", (err as Error).message);
          return new Response("Storage error", { status: 500 });
        }
        if (!decision.process) return new Response("ok (duplicate)");

        try {
          const outcome = await processRazorpayPlatformEvent(supabaseAdmin, event);
          await markWebhookEvent(supabaseAdmin, eventId, { processed: true, note: outcome.note });
        } catch (err) {
          const message = (err as Error).message;
          console.error("razorpay:webhook_processing_failed", eventId, message);
          try {
            await markWebhookEvent(supabaseAdmin, eventId, { processed: false, error: message });
          } catch (markErr) {
            console.error(
              "razorpay:webhook_error_record_failed",
              eventId,
              (markErr as Error).message,
            );
          }
          return new Response("Processing error", { status: 500 });
        }

        return new Response("ok");
      },
    },
  },
});
