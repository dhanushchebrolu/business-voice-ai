import { createFileRoute } from "@tanstack/react-router";

/**
 * Google Calendar push-notification webhook (events.watch's `address`).
 * Google sends a bare POST with no body — the entire notification is in
 * headers (X-Goog-Channel-Id, X-Goog-Channel-Token, X-Goog-Resource-State,
 * ...). There is no cryptographic signature; X-Goog-Channel-Token is the
 * authentication mechanism (the opaque secret ClickAI generated when
 * registering the channel, which Google echoes back verbatim) — see
 * google-calendar-sync.server.ts's handleWebhookNotification and the
 * channel_token migration's own doc comment for why this is sufficient.
 *
 * Always responds 200 once the notification is authenticated, even for a
 * "sync" handshake or an unrecognized-but-authenticated channel, matching
 * Google's expectation that the receiving endpoint acknowledges quickly;
 * only an unauthenticated notification (unknown channel or token mismatch)
 * gets a non-200, and even that is harmless — Google only cares that ITS
 * own channel + token round-trip, so a mismatch simply means this was
 * never a notification for a channel ClickAI actually registered.
 */
export const Route = createFileRoute("/api/public/webhooks/google-calendar")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { handleWebhookNotification } =
          await import("@/lib/google-calendar/google-calendar-sync.server");

        try {
          const result = await handleWebhookNotification(supabaseAdmin, {
            channelId: request.headers.get("x-goog-channel-id"),
            channelToken: request.headers.get("x-goog-channel-token"),
            resourceState: request.headers.get("x-goog-resource-state"),
          });
          if (result.outcome === "rejected") {
            return new Response(result.reason ?? "Rejected", { status: 401 });
          }
          return new Response(JSON.stringify(result), {
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          console.error(
            "google_calendar_sync:webhook_processing_failed",
            err instanceof Error ? err.message : err,
          );
          // Google retries a non-2xx response — returning 500 here (rather
          // than swallowing the error as a false 200) lets Google's own
          // retry mechanism recover a transient failure (e.g. a momentary
          // token-refresh or database hiccup) without ClickAI needing its
          // own redelivery logic for this one notification.
          return new Response("Processing error", { status: 500 });
        }
      },
    },
  },
});
