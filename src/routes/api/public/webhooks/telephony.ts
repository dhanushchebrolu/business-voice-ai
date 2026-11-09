import { createFileRoute } from "@tanstack/react-router";
import { getRequestWaitUntil } from "@/lib/background-task.server";
import { maskCallSid } from "@/lib/telephony/media-session-authorization.server";
import { processTelephonyEvent } from "@/lib/telephony/telephony-event-processing.server";

/**
 * Inbound telephony provider webhook — the single entry point every
 * provider event (inbound ring, outbound call status, mid-call updates)
 * arrives through. Provider is selected via `?provider=<id>` (each
 * provider's console is configured to hit this URL with its own query
 * string) so one route serves every configured provider without a
 * per-vendor endpoint.
 *
 * Both GET and POST are handled, sharing the exact same logic below —
 * confirmed against a real live test call that Exotel's Voicebot Passthru
 * step sends its callback as a GET request with every field in the URL
 * query string, not a POST body (previously this route only registered a
 * POST handler, so a live GET request matched the route but hit no
 * handler at all — returning framework-default 200 without ever running
 * signature verification, event normalization, or the call_logs insert;
 * this silently dropped every Exotel webhook event). The method-specific
 * part is only how `raw` is built: GET's query string (already
 * `key=val&key2=val2` form-encoded, minus the leading "?") is handed to
 * the exact same `URLSearchParams`-based parsing `ExotelTelephonyAdapter`
 * already used for a POST's url-encoded body — no adapter changes needed.
 * `verifyWebhookSignature` was already method-agnostic (Exotel's
 * `verify_token` lives in the URL query string either way, never the
 * body), so authentication is unaffected by this change.
 *
 * Mirrors the Razorpay webhook's structure: verify signature before
 * anything is trusted, dedupe via `webhook_events` before any side effect,
 * never let a browser or unverified caller move call state.
 */
export const Route = createFileRoute("/api/public/webhooks/telephony")({
  server: {
    handlers: {
      GET: ({ request }) => handleTelephonyWebhook(request),
      POST: ({ request }) => handleTelephonyWebhook(request),
    },
  },
});

async function handleTelephonyWebhook(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const providerId = url.searchParams.get("provider");
  if (!providerId) return new Response("Missing provider", { status: 400 });
  const waitUntil = getRequestWaitUntil(request);

  const { getTelephonyAdapter } = await import("@/lib/telephony.server");
  const adapter = getTelephonyAdapter(providerId);
  if (!adapter) {
    console.error("telephony:webhook_provider_not_configured", providerId);
    return new Response("Not configured", { status: 503 });
  }

  // GET's fields live entirely in the query string; POST's live in the
  // body. Re-serializing url.search this way (rather than reading it
  // directly in the adapter) keeps TelephonyProviderAdapter's interface
  // unchanged — every adapter still only ever sees one "raw" string shaped
  // like a url-encoded body, regardless of which HTTP method delivered it.
  const raw = request.method === "GET" ? url.search.replace(/^\?/, "") : await request.text();
  const headers: Record<string, string | null> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Diagnostic: proves the request actually reached this handler at all,
  // before signature verification can reject it with zero trace. A prior
  // live-call investigation found the media WebSocket rejecting every
  // connection with "no known call for CallSid" and no way to tell, from
  // logs alone, whether that was because the status webhook never arrived
  // versus arrived and was silently 401'd — this line closes that gap.
  // Never the raw query string/body or header values (which may carry the
  // provider's verify_token) — method and provider only.
  console.info("telephony:webhook_request_received", {
    method: request.method,
    provider: providerId,
  });

  if (!adapter.verifyWebhookSignature(raw, headers, url)) {
    console.error("telephony:webhook_signature_invalid", {
      method: request.method,
      provider: providerId,
    });
    return new Response("Invalid signature", { status: 401 });
  }

  const event = adapter.normalizeWebhookEvent(raw, headers);
  if (!event) return new Response("Invalid payload", { status: 400 });

  const eventId = event.eventId ?? `${event.providerCallId}:${event.status}:${event.occurredAt}`;

  // Structured webhook-receipt log: method/provider/status/direction/call
  // reference only — never the raw body/query string or headers (which may
  // carry the provider's verify_token/signature material). provider_call_id
  // is masked so this line can be visually diffed against the media route's
  // own masked CallSid log (media-session-authorization.server.ts) without
  // ever printing the full identifier in either place.
  console.info("telephony:webhook_received", {
    method: request.method,
    provider: providerId,
    event_id: eventId,
    status: event.status,
    direction: event.direction,
    provider_call_id: event.providerCallId ? maskCallSid(event.providerCallId) : null,
  });

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Idempotency: the unique (provider, event_id) index rejects replays,
  // exactly like the Razorpay webhook (spec §10/§Q/§O).
  const { error: dedupeError } = await supabaseAdmin.from("webhook_events").insert({
    provider: providerId,
    event_id: eventId,
    event_type: event.status,
    payload: event.raw as never,
  });
  if (dedupeError) {
    if ((dedupeError as { code?: string }).code === "23505") return new Response("ok (duplicate)");
    console.error("telephony:webhook_store_failed", dedupeError.message);
    return new Response("Storage error", { status: 500 });
  }

  try {
    await processTelephonyEvent(providerId, event, waitUntil);
    await supabaseAdmin
      .from("webhook_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("provider", providerId)
      .eq("event_id", eventId);
  } catch (err) {
    console.error("telephony:webhook_processing_failed", (err as Error).message);
    await supabaseAdmin
      .from("webhook_events")
      .update({ error: (err as Error).message })
      .eq("provider", providerId)
      .eq("event_id", eventId);
    return new Response("Processing error", { status: 500 });
  }

  return new Response("ok");
}
