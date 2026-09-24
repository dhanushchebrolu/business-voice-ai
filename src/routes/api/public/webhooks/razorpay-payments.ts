import { createFileRoute } from "@tanstack/react-router";

/**
 * Razorpay CUSTOMER-PAYMENT webhook — the single source of truth for
 * moving a payment_requests row to CAPTURED/FAILED/EXPIRED. Deliberately
 * a SEPARATE route from the existing platform-billing webhook
 * (src/routes/api/public/webhooks/razorpay.ts): its own signing secret
 * (RAZORPAY_CUSTOMER_PAYMENTS_WEBHOOK_SECRET, distinct from
 * RAZORPAY_WEBHOOK_SECRET), its own idempotency ledger
 * (payment_webhook_events, not webhook_events) — see
 * payment-webhook.server.ts's own doc comment for the full rationale.
 *
 * Signature is verified before anything is read from the payload,
 * reusing the same generic, already-battle-tested verifySignature()
 * HMAC-SHA256 helper the platform-billing webhook uses (not
 * payment-transaction-specific, safe to share).
 *
 * The calendar/WhatsApp/voice consumers (see payment-events.server.ts's
 * DispatchConsumers) are all wired in now — this route always calls
 * processRazorpayPaymentWebhook with whatever consumers currently exist;
 * an unwired consumer would simply be skipped, never an error.
 */
export const Route = createFileRoute("/api/public/webhooks/razorpay-payments")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const {
          getCustomerPaymentsWebhookSecret,
          processRazorpayPaymentWebhook,
          PaymentWebhookError,
        } = await import("@/lib/payments/payment-webhook.server");
        const { verifySignature } = await import("@/lib/razorpay.server");

        const secret = getCustomerPaymentsWebhookSecret();
        if (!secret) {
          console.error("razorpay_payments:webhook_secret_missing");
          return new Response("Not configured", { status: 503 });
        }

        const raw = await request.text();
        const signature = request.headers.get("x-razorpay-signature") ?? "";
        if (!signature || !verifySignature(raw, signature, secret)) {
          return new Response("Invalid signature", { status: 401 });
        }

        const eventId = request.headers.get("x-razorpay-event-id") ?? "";
        if (!eventId) return new Response("Missing event id", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { handlePaymentCapturedForCalendar } =
          await import("@/lib/payments/payment-calendar-consumer.server");
        const { handlePaymentEventForWhatsApp } =
          await import("@/lib/payments/payment-whatsapp-consumer.server");
        const { handlePaymentEventForVoice } =
          await import("@/lib/payments/payment-voice-consumer.server");

        try {
          const result = await processRazorpayPaymentWebhook(
            supabaseAdmin,
            { rawBody: raw, eventId },
            {
              calendar: handlePaymentCapturedForCalendar,
              whatsapp: handlePaymentEventForWhatsApp,
              voice: handlePaymentEventForVoice,
            },
          );
          return new Response(JSON.stringify({ outcome: result.outcome }), {
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          if (err instanceof PaymentWebhookError) {
            return new Response(err.message, { status: err.status });
          }
          console.error(
            "razorpay_payments:webhook_processing_failed",
            err instanceof Error ? err.message : err,
          );
          return new Response("Processing error", { status: 500 });
        }
      },
    },
  },
});
