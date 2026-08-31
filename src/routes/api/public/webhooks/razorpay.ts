import { createFileRoute } from "@tanstack/react-router";

/**
 * Razorpay webhook — the single source of truth for unlocking an account.
 * Signature is verified before anything is read from the payload, and every
 * event is recorded so it is only ever processed once.
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

        let event: {
          event?: string;
          payload?: { payment?: { entity?: Record<string, unknown> } };
        };
        try {
          event = JSON.parse(raw);
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }

        const eventId = request.headers.get("x-razorpay-event-id") ?? "";
        if (!eventId) return new Response("Missing event id", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Idempotency: the unique (provider, event_id) index rejects replays.
        const { error: dedupeError } = await supabaseAdmin.from("webhook_events").insert({
          provider: "razorpay",
          event_id: eventId,
          event_type: event.event ?? null,
          payload: event as unknown as Record<string, unknown>,
        });
        if (dedupeError) {
          if (dedupeError.code === "23505") return new Response("ok (duplicate)");
          console.error("razorpay:webhook_store_failed", dedupeError.message);
          return new Response("Storage error", { status: 500 });
        }

        try {
          const entity = event.payload?.payment?.entity as
            | {
                id?: string;
                order_id?: string;
                amount?: number;
                currency?: string;
                status?: string;
                method?: string;
                notes?: Record<string, string>;
              }
            | undefined;

          if ((event.event === "payment.captured" || event.event === "order.paid") && entity?.order_id) {
            const { data: order } = await supabaseAdmin
              .from("payment_orders")
              .select("id, organization_id, purpose, amount, currency")
              .eq("provider_order_id", entity.order_id)
              .maybeSingle();

            if (order) {
              const { data: payment } = await supabaseAdmin
                .from("payments")
                .upsert(
                  {
                    organization_id: order.organization_id,
                    order_id: order.id,
                    provider: "razorpay",
                    provider_payment_id: entity.id ?? null,
                    purpose: order.purpose,
                    amount: entity.amount ?? order.amount,
                    currency: entity.currency ?? order.currency,
                    status: "captured",
                    method: entity.method ?? null,
                    captured_at: new Date().toISOString(),
                  },
                  { onConflict: "provider_payment_id" },
                )
                .select("id")
                .maybeSingle();

              await supabaseAdmin.from("payment_orders").update({ status: "paid" }).eq("id", order.id);

              await supabaseAdmin.from("invoices").insert({
                organization_id: order.organization_id,
                number: `INV-${new Date().getFullYear()}-${entity.id ?? order.id.slice(0, 8)}`,
                payment_id: payment?.id ?? null,
                amount: entity.amount ?? order.amount,
                currency: entity.currency ?? order.currency,
                status: "paid",
                line_items: [{ purpose: order.purpose, amount: entity.amount ?? order.amount }],
                paid_at: new Date().toISOString(),
              });

              if (order.purpose === "setup_fee") {
                await supabaseAdmin
                  .from("organizations")
                  .update({ account_status: "setup_in_progress", setup_paid_at: new Date().toISOString() })
                  .eq("id", order.organization_id);
              }
              if (order.purpose === "monthly_plan") {
                const next = new Date();
                next.setMonth(next.getMonth() + 1);
                await supabaseAdmin
                  .from("organizations")
                  .update({ account_status: "active", next_billing_at: next.toISOString() })
                  .eq("id", order.organization_id);
              }
            }
          }

          if (event.event === "payment.failed" && entity?.order_id) {
            await supabaseAdmin.from("payment_orders").update({ status: "failed" }).eq("provider_order_id", entity.order_id);
          }

          await supabaseAdmin
            .from("webhook_events")
            .update({ processed_at: new Date().toISOString() })
            .eq("provider", "razorpay")
            .eq("event_id", eventId);
        } catch (err) {
          console.error("razorpay:webhook_processing_failed", (err as Error).message);
          await supabaseAdmin
            .from("webhook_events")
            .update({ error: (err as Error).message })
            .eq("provider", "razorpay")
            .eq("event_id", eventId);
          return new Response("Processing error", { status: 500 });
        }

        return new Response("ok");
      },
    },
  },
});
