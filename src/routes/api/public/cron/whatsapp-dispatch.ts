import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * WhatsApp outbound sweep — schedule every minute (Bearer
 * LOVABLE_CRON_SECRET, same as the other /api/public/cron routes; no
 * Cloudflare cron trigger exists for it). Each step is independent, so one
 * failing never stops the others:
 *   1. expire booking proposals nobody confirmed in time;
 *   2. enqueue 24-hour booking reminders;
 *   3. send due booking/payment notifications (whatsapp_notifications);
 *   4. send the next rate-limited batch of each running campaign.
 * Returns counts only — never message content or numbers.
 */
export const Route = createFileRoute("/api/public/cron/whatsapp-dispatch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authError = await authenticateCronRequest(request);
        if (authError) return authError;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { expirePendingActions } = await import("@/lib/whatsapp/whatsapp-actions.server");
        const { enqueueDueReminders, processDueNotifications } =
          await import("@/lib/whatsapp/whatsapp-notifications.server");
        const { dispatchWhatsAppCampaigns } =
          await import("@/lib/whatsapp/whatsapp-campaigns.server");

        const now = new Date();
        const summary: Record<string, unknown> = {};
        const errors: string[] = [];
        const step = async (name: string, fn: () => Promise<unknown>) => {
          try {
            summary[name] = await fn();
          } catch (err) {
            errors.push(name);
            console.error(
              `whatsapp_dispatch_cron:${name}_failed`,
              err instanceof Error
                ? err.message
                : ((err as { message?: string } | null)?.message ?? String(err)),
            );
          }
        };
        await step("expiredProposals", () => expirePendingActions(supabaseAdmin, now));
        await step("remindersEnqueued", () => enqueueDueReminders(supabaseAdmin, now));
        await step("notifications", () => processDueNotifications(supabaseAdmin));
        await step("campaigns", async () =>
          (await dispatchWhatsAppCampaigns(supabaseAdmin)).map((c) => ({
            sent: c.sent,
            skipped: c.skipped,
            failed: c.failed,
            retried: c.retried,
            status: c.status,
          })),
        );
        return new Response(JSON.stringify({ ...summary, errors }), {
          status: errors.length > 0 ? 500 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
