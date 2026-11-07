/**
 * The WhatsApp webhook's POST handler (deliveries from Vobiz), separated
 * from the route file so it runs under the test runner with injected
 * dependencies (src/routes/api/public/webhooks/whatsapp.ts is a thin
 * wrapper):
 *
 *   1. Authenticate before parsing or storing anything: X-Webhook-Signature
 *      must be the hex HMAC-SHA256 of the exact raw body with
 *      VOBIZ_WHATSAPP_WEBHOOK_SECRET, or 401.
 *   2. Store statuses / inbound messages (whatsapp-inbound.server.ts),
 *      deduplicated on Vobiz's event_id.
 *   3. Answer 200 straight away; AI replies to newly stored inbound texts
 *      run in the background, never delaying the acknowledgement.
 *   4. If storing fails, the claim was released: answer 500 so Vobiz
 *      retries. Nothing from the payload is logged.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  getVobizWhatsAppWebhookSecret,
  verifyVobizWebhookSignature,
} from "./vobiz-webhook.server.ts";
import { processVobizWhatsAppWebhook } from "./whatsapp-inbound.server.ts";

type Client = SupabaseClient<Database>;

export interface WebhookHandlerDeps {
  getSupabaseAdmin: () => Promise<Client>;
  /** Defaults to VOBIZ_WHATSAPP_WEBHOOK_SECRET. */
  secret?: string | null | undefined;
  process?: typeof processVobizWhatsAppWebhook;
  /** Starts AI replies after the response (waitUntil in production). */
  replyInBackground: (supabaseAdmin: Client, messageIds: string[], request: Request) => void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleWhatsAppWebhookPost(
  request: Request,
  deps: WebhookHandlerDeps,
): Promise<Response> {
  const raw = await request.text();
  const secret = deps.secret === undefined ? getVobizWhatsAppWebhookSecret() : deps.secret;
  if (!verifyVobizWebhookSignature(raw, request.headers.get("x-webhook-signature"), secret)) {
    console.error("whatsapp_webhook:invalid_signature");
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseAdmin = await deps.getSupabaseAdmin();
  try {
    const result = await (deps.process ?? processVobizWhatsAppWebhook)(supabaseAdmin, {
      rawBody: raw,
    });
    if (result.newInboundTextMessageIds.length > 0) {
      deps.replyInBackground(supabaseAdmin, result.newInboundTextMessageIds, request);
    }
    return json({ outcome: result.outcome });
  } catch (err) {
    // The event's claim was released: answer 5xx so Vobiz retries it.
    console.error(
      "whatsapp_webhook:processing_failed",
      err instanceof Error
        ? err.message
        : ((err as { message?: string } | null)?.message ?? "unknown error"),
    );
    return json({ outcome: "error" }, 500);
  }
}
