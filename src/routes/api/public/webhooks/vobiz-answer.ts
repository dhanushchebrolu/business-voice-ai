import { createFileRoute } from "@tanstack/react-router";
import { getRequestWaitUntil, runInBackground } from "@/lib/background-task.server";
import {
  checkTelephonyAccess,
  resolveActivePhoneNumberByDestination,
} from "@/lib/telephony-guard.server";
import { maskCallSid } from "@/lib/telephony/media-session-authorization.server";
import { buildVobizDeniedXml, buildVobizStreamXml } from "@/lib/telephony/vobiz-xml";
import { VOBIZ_MEDIA_STREAM_PATH } from "@/lib/telephony/vobiz-media-stream-path";

/**
 * Vobiz's `answer_url` target — the one webhook route whose job is
 * fundamentally different from every other provider's: Vobiz expects an
 * immediate, synchronous Voice XML response body (not just a 200) that
 * tells it how to handle the call (here: open a `<Stream>` to Klyro's media
 * bridge, or speak a short message and let the call end). Every other
 * provider event — including Vobiz's own call-status/hangup events — still
 * goes through the single shared `/api/public/webhooks/telephony` route
 * unchanged (see telephony.server.ts's dedicated vobiz branch and
 * VobizTelephonyAdapter's module doc); this file does not duplicate that
 * pipeline, it reuses it: `processTelephonyEvent` (exported from
 * telephony.ts for exactly this reuse) is fired in the background to
 * create/update the call_logs row and trigger agent-runtime routing — the
 * identical side effects a normal webhook delivery would cause — while
 * this route's own synchronous work is limited to the one thing only it
 * can do: decide, fast, which XML to answer with. The two are deliberately
 * decoupled (background vs. synchronous) for the same deadlock reason
 * documented in telephony.ts's own `runInBackground(routeToAgentRuntime...)`
 * comment: Vobiz is waiting on THIS response before it will ever open the
 * WebSocket that `<Stream>` points to, so this handler must return quickly.
 */
export const Route = createFileRoute("/api/public/webhooks/vobiz-answer")({
  server: {
    handlers: {
      GET: ({ request }) => handleVobizAnswer(request),
      POST: ({ request }) => handleVobizAnswer(request),
    },
  },
});

async function handleVobizAnswer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const waitUntil = getRequestWaitUntil(request);
  // Non-sensitive per-request id, logged only to distinguish two
  // answer_url invocations for the same call (e.g. a duplicate delivery)
  // in the stream_response diagnostic below — carries no call/account data.
  const invocationId = crypto.randomUUID().slice(0, 8);

  const { getTelephonyAdapter } = await import("@/lib/telephony.server");
  const adapter = getTelephonyAdapter("vobiz");
  if (!adapter) {
    console.error("vobiz_answer:not_configured");
    return xmlResponse(buildVobizDeniedXml("This number is not available right now."));
  }

  const raw = request.method === "GET" ? url.search.replace(/^\?/, "") : await request.text();
  const headers: Record<string, string | null> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  if (!adapter.verifyWebhookSignature(raw, headers, url)) {
    console.error("vobiz_answer:signature_invalid", { method: request.method });
    return xmlResponse(buildVobizDeniedXml("This request could not be verified."));
  }

  const event = adapter.normalizeWebhookEvent(raw, headers);
  if (!event) {
    console.error("vobiz_answer:payload_unrecognized");
    return xmlResponse(buildVobizDeniedXml("Something went wrong on our end."));
  }

  console.info("vobiz_answer:received", {
    method: request.method,
    direction: event.direction,
    providerCallId: maskCallSid(event.providerCallId),
  });

  // Background: the exact same call_logs/entitlement/runtime-routing
  // pipeline a normal telephony webhook event causes — see this file's own
  // module doc for why this must not block the XML response below.
  const { processTelephonyEvent } = await import("@/routes/api/public/webhooks/telephony");
  runInBackground(
    processTelephonyEvent("vobiz", event, waitUntil),
    waitUntil,
    "vobiz_answer:background_processing_failed",
  );

  // Synchronous, fast: resolve organization/phone-number + the entitlement
  // gate purely to decide the XML, reusing the exact same
  // checkTelephonyAccess gate every other telephony path uses — never a
  // parallel authorization rule.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let organizationId: string | null = null;
  let phoneNumberId: string | null = null;
  let calledNumber: string | null = null;

  if (event.direction === "outbound") {
    const { data: call } = await supabaseAdmin
      .from("call_logs")
      .select("organization_id, phone_number_id")
      .eq("provider", "vobiz")
      .eq("provider_call_id", event.providerCallId)
      .maybeSingle();
    organizationId = call?.organization_id ?? null;
    phoneNumberId = call?.phone_number_id ?? null;
  } else {
    calledNumber = event.destinationE164 ?? event.toE164 ?? null;
    if (calledNumber) {
      const phoneNumber = await resolveActivePhoneNumberByDestination("vobiz", calledNumber);
      organizationId = phoneNumber?.organization_id ?? null;
      phoneNumberId = phoneNumber?.id ?? null;
    }
  }

  if (!organizationId || !phoneNumberId) {
    // Diagnostic: distinguishes "no phone_numbers row for this exact
    // (already-normalized) e164 at all" from "a row exists but with an
    // unexpected provider/status" — same shape as telephony.ts's own
    // permanent webhook_unknown_number diagnostic. calledNumber is logged
    // unmasked: a destination DID routed to a business's own line is not a
    // secret (same reasoning telephony.ts's normalized_number field uses).
    let matchingRowsForNumber: { provider: string; status: string }[] = [];
    if (calledNumber) {
      const { data: anyMatches } = await supabaseAdmin
        .from("phone_numbers")
        .select("provider, status")
        .eq("e164", calledNumber)
        .limit(5);
      matchingRowsForNumber = anyMatches ?? [];
    }
    console.error("vobiz_answer:unresolved_call", {
      direction: event.direction,
      providerCallId: maskCallSid(event.providerCallId),
      calledNumber,
      matchingRowsForNumber,
    });
    return xmlResponse(buildVobizDeniedXml("This number is not configured yet."));
  }

  const gate = await checkTelephonyAccess(
    organizationId,
    phoneNumberId,
    event.direction === "outbound" ? "outbound" : "inbound",
  );
  if (!gate.allowed) {
    console.error("vobiz_answer:denied_by_gate", {
      providerCallId: maskCallSid(event.providerCallId),
      organizationId,
      reason: gate.reason,
    });
    return xmlResponse(buildVobizDeniedXml("This call cannot be connected right now."));
  }

  const wsUrl = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}${VOBIZ_MEDIA_STREAM_PATH}`;
  // DIAGNOSTIC (production incident: media WebSocket never reached us, no
  // log confirmed what XML this route actually returned): the only log on
  // this route's success path. No secret/signature/token is logged — just
  // which branch was taken and the wsUrl Vobiz is told to connect to.
  console.info("vobiz_answer:stream_response", {
    method: request.method,
    invocationId,
    calledNumber,
    wsUrl,
    streamXmlReturned: true,
  });
  return xmlResponse(buildVobizStreamXml(wsUrl));
}

function xmlResponse(xml: string): Response {
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
