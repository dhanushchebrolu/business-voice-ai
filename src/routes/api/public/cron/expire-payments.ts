import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Periodic sweep releasing PENDING_PAYMENT booking holds (and their
 * still-open payment_requests) once hold_expires_at passes — see
 * payment-expiration.server.ts's own doc comment for the full race-safety
 * reasoning. Same cron-secret mechanism as dispatch-campaigns.ts (Bearer
 * LOVABLE_CRON_SECRET, timing-safe compared) — no new scheduling
 * infrastructure introduced.
 */
export const Route = createFileRoute("/api/public/cron/expire-payments")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authError = await authenticateCronRequest(request);
        if (authError) return authError;

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { expirePendingPayments } =
            await import("@/lib/payments/payment-expiration.server");
          const { handlePaymentCapturedForCalendar } =
            await import("@/lib/payments/payment-calendar-consumer.server");
          const { handlePaymentEventForWhatsApp } =
            await import("@/lib/payments/payment-whatsapp-consumer.server");
          const { handlePaymentEventForVoice } =
            await import("@/lib/payments/payment-voice-consumer.server");

          const summary = await expirePendingPayments(supabaseAdmin, {
            calendar: handlePaymentCapturedForCalendar,
            whatsapp: handlePaymentEventForWhatsApp,
            voice: handlePaymentEventForVoice,
          });
          return new Response(JSON.stringify(summary), {
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          console.error("payment_expiration:tick_failed", (err as Error).message);
          return new Response("Expiration sweep error", { status: 500 });
        }
      },
    },
  },
});
