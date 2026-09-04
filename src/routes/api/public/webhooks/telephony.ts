import { createFileRoute } from "@tanstack/react-router";
import {
  checkCallTransition,
  checkTelephonyAccess,
  finalizeCallBilling,
  TERMINAL_CALL_STATUSES,
} from "@/lib/telephony-guard.server";
import { routeToAgentRuntime } from "@/lib/telephony-runtime";
import { terminateRuntimeSession } from "@/lib/voice-runtime.server";
import type { NormalizedCallEvent } from "@/lib/telephony/adapter";

/**
 * Inbound telephony provider webhook — the single entry point every
 * provider event (inbound ring, outbound call status, mid-call updates)
 * arrives through. Provider is selected via `?provider=<id>` (each
 * provider's console is configured to POST to this URL with its own query
 * string) so one route serves every configured provider without a
 * per-vendor endpoint.
 *
 * Mirrors the Razorpay webhook's structure: verify signature before
 * anything is trusted, dedupe via `webhook_events` before any side effect,
 * never let a browser or unverified caller move call state.
 */
export const Route = createFileRoute("/api/public/webhooks/telephony")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const providerId = url.searchParams.get("provider");
        if (!providerId) return new Response("Missing provider", { status: 400 });

        const { getTelephonyAdapter } = await import("@/lib/telephony.server");
        const adapter = getTelephonyAdapter(providerId);
        if (!adapter) {
          console.error("telephony:webhook_provider_not_configured", providerId);
          return new Response("Not configured", { status: 503 });
        }

        const raw = await request.text();
        const headers: Record<string, string | null> = {};
        request.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });

        if (!adapter.verifyWebhookSignature(raw, headers, url)) {
          return new Response("Invalid signature", { status: 401 });
        }

        const event = adapter.normalizeWebhookEvent(raw, headers);
        if (!event) return new Response("Invalid payload", { status: 400 });

        const eventId =
          event.eventId ?? `${event.providerCallId}:${event.status}:${event.occurredAt}`;

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
          if ((dedupeError as { code?: string }).code === "23505")
            return new Response("ok (duplicate)");
          console.error("telephony:webhook_store_failed", dedupeError.message);
          return new Response("Storage error", { status: 500 });
        }

        try {
          await processTelephonyEvent(providerId, event);
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
      },
    },
  },
});

async function processTelephonyEvent(providerId: string, event: NormalizedCallEvent) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: existingCall } = await supabaseAdmin
    .from("call_logs")
    .select("*")
    .eq("provider", providerId)
    .eq("provider_call_id", event.providerCallId)
    .maybeSingle();

  if (existingCall) {
    await applyCallEvent(existingCall, event);
    return;
  }

  // No existing row — this must be a brand-new inbound call. Anything else
  // (an update event for a call we never initiated/received) is dropped
  // rather than fabricating a call record from partial webhook data.
  if (event.direction === "outbound") {
    console.error("telephony:webhook_unknown_outbound_call", event.providerCallId);
    return;
  }

  const vaaniNumber = event.vaaniE164 ?? event.toE164;
  if (!vaaniNumber) {
    console.error("telephony:webhook_missing_destination_number", event.providerCallId);
    return;
  }

  const { data: phoneNumber } = await supabaseAdmin
    .from("phone_numbers")
    .select("*")
    .eq("e164", vaaniNumber)
    .eq("status", "active")
    .maybeSingle();
  if (!phoneNumber) {
    console.error("telephony:webhook_unknown_number", vaaniNumber);
    return;
  }

  const gate = await checkTelephonyAccess(phoneNumber.organization_id, phoneNumber.id, "inbound");

  const { data: call, error: insertError } = await supabaseAdmin
    .from("call_logs")
    .insert({
      organization_id: phoneNumber.organization_id,
      business_id: phoneNumber.business_id,
      phone_number_id: phoneNumber.id,
      provider: providerId,
      provider_call_id: event.providerCallId,
      direction: "inbound",
      caller_number: event.fromE164 ?? null,
      destination_number: vaaniNumber,
      status: gate.allowed ? event.status : "failed",
      failure_reason: gate.allowed ? null : gate.reason,
      started_at: event.occurredAt,
      provider_metadata: event.raw as never,
    })
    .select("*")
    .single();
  if (insertError) throw insertError;

  if (!gate.allowed) return;

  if (event.status === "answered" || event.status === "in_progress") {
    await routeToAgentRuntime({
      callId: call.id,
      organizationId: phoneNumber.organization_id,
      businessId: phoneNumber.business_id,
      agentConfigId: phoneNumber.agent_config_id,
      phoneNumberId: phoneNumber.id,
      vaaniE164: phoneNumber.e164,
      callerE164: event.fromE164 ?? null,
      direction: "inbound",
      provider: providerId,
      providerCallId: event.providerCallId,
    });
  }

  if (TERMINAL_CALL_STATUSES.includes(event.status)) {
    await terminateRuntimeSession(call.id, `call ended: ${event.status}`);
    await finalizeCallBilling(call, event.durationSeconds ?? 0);
  }
}

async function applyCallEvent(
  call: {
    id: string;
    status: string;
    organization_id: string;
    direction: string;
    answered_at: string | null;
    phone_number_id: string | null;
    provider: string;
    provider_call_id: string | null;
  },
  event: NormalizedCallEvent,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const transition = checkCallTransition(call.status, event.status);
  if (!transition.ok) {
    console.error("telephony:illegal_transition", call.id, transition.reason);
    return;
  }
  if (!transition.changed) return; // idempotent replay of the same status

  const patch: Record<string, unknown> = { status: event.status, provider_metadata: event.raw };
  if (event.status === "answered" && !call.answered_at) patch["answered_at"] = event.occurredAt;
  if (event.recordingUrl) patch["recording_url"] = event.recordingUrl;
  if (event.failureReason) patch["failure_reason"] = event.failureReason;
  if (TERMINAL_CALL_STATUSES.includes(event.status)) {
    patch["ended_at"] = event.occurredAt;
    if (typeof event.durationSeconds === "number")
      patch["duration_seconds"] = event.durationSeconds;
  }

  const { error } = await supabaseAdmin
    .from("call_logs")
    .update(patch as never)
    .eq("id", call.id);
  if (error) throw error;

  // The very first webhook event for a call can arrive already "answered"
  // (handled in processTelephonyEvent's new-call branch below), but the
  // common case is ringing -> answered as two separate events on an
  // already-existing row — this is that second path into the runtime.
  // startRuntimeSession is idempotent per call_id, so both paths converging
  // here is safe.
  if (
    call.direction === "inbound" &&
    call.phone_number_id &&
    (event.status === "answered" || event.status === "in_progress")
  ) {
    const { data: phoneNumber } = await supabaseAdmin
      .from("phone_numbers")
      .select("*")
      .eq("id", call.phone_number_id)
      .maybeSingle();
    // Re-check entitlement at handoff time (defense in depth, spec §14) —
    // a lock/suspension applied after the call started must still prevent
    // the paid AI runtime from starting.
    if (phoneNumber) {
      const gate = await checkTelephonyAccess(call.organization_id, phoneNumber.id, "inbound");
      if (gate.allowed) {
        await routeToAgentRuntime({
          callId: call.id,
          organizationId: call.organization_id,
          businessId: phoneNumber.business_id,
          agentConfigId: phoneNumber.agent_config_id,
          phoneNumberId: phoneNumber.id,
          vaaniE164: phoneNumber.e164,
          callerE164: event.fromE164 ?? null,
          direction: "inbound",
          provider: call.provider,
          providerCallId: call.provider_call_id,
        });
      } else {
        console.error("telephony:runtime_blocked_by_gate", call.id, gate.reason);
      }
    }
  }

  if (TERMINAL_CALL_STATUSES.includes(event.status)) {
    await terminateRuntimeSession(call.id, `call ended: ${event.status}`);
    await finalizeCallBilling(
      {
        id: call.id,
        organization_id: call.organization_id,
        direction: call.direction as "inbound" | "outbound",
      },
      event.durationSeconds ?? 0,
    );
  }
}
