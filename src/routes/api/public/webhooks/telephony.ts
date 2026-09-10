import { createFileRoute } from "@tanstack/react-router";
import {
  checkCallTransition,
  checkTelephonyAccess,
  finalizeCallBilling,
  TERMINAL_CALL_STATUSES,
} from "@/lib/telephony-guard.server";
import { routeToAgentRuntime, terminateAgentRuntime } from "@/lib/telephony-runtime";
import type { NormalizedCallEvent } from "@/lib/telephony/adapter";
import {
  buildProviderMetadata,
  isPlausibleClientReference,
} from "@/lib/telephony/webhook-correlation.server";

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

  // No row keyed by the provider's own call id yet. For an outbound event,
  // this is expected when the provider only reveals its call identifier
  // asynchronously (via this very webhook) rather than synchronously at
  // submission time — a Klyro-created tracking row can exist with
  // organization_id already correct but no provider_call_id yet. The ONLY
  // safe fallback lookup is Klyro's own client-reference, which Klyro
  // generated itself before ever contacting the provider — never a payload
  // field the provider (or a forged request) controls. Anything that still
  // doesn't resolve to a Klyro-owned row is dropped, never used to
  // fabricate a call record or infer an organization (spec: a webhook must
  // never be able to choose organization_id directly).
  if (event.direction === "outbound") {
    const resolved =
      event.clientReference && isPlausibleClientReference(event.clientReference)
        ? await resolveOutboundCallByClientReference(providerId, event.clientReference)
        : null;
    if (!resolved) {
      console.error("telephony:webhook_unknown_outbound_call", event.providerCallId);
      return;
    }
    if (!resolved.provider_call_id) {
      await supabaseAdmin
        .from("call_logs")
        .update({ provider_call_id: event.providerCallId })
        .eq("id", resolved.id);
      resolved.provider_call_id = event.providerCallId;
    }
    await applyCallEvent(resolved, event);
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
    .eq("provider", providerId)
    .eq("status", "active")
    .maybeSingle();
  if (!phoneNumber) {
    console.error("telephony:webhook_unknown_number", vaaniNumber);
    return;
  }

  // Reassignment safety (spec Phase 5 §8): the lookup above only proves
  // which organization owns this number RIGHT NOW — it says nothing about
  // which organization owned it when this specific interaction actually
  // happened. A number can be reassigned (to a different customer, or to a
  // recreated Sarvam deployment) between when a call started and when its
  // one-shot completion webhook arrives. When the provider tells us which
  // deployment handled the call (event.providerDeploymentId) and Klyro has
  // a deployment on file for the currently-active row
  // (phoneNumber.provider_deployment_id), the two must agree; a mismatch
  // means this is a stale event from a deployment that is no longer this
  // number's active mapping, and it must never be attributed to whichever
  // organization happens to own the number today. There is deliberately no
  // attempt to instead attribute it to the correct (old) organization —
  // nothing in the current schema records historical (organization,
  // deployment) assignments over time, so recovering the true owner would
  // be a guess, not a lookup. The event is dropped (logged, not retried as
  // an error — a stale event is not a processing failure) rather than
  // guessed. Providers/events that don't carry a deployment id (or a number
  // not yet deployment-mapped) are unaffected — this only ever narrows an
  // already-successful e164 match, never blocks one that has nothing to
  // cross-check.
  if (
    event.providerDeploymentId &&
    phoneNumber.provider_deployment_id &&
    event.providerDeploymentId !== phoneNumber.provider_deployment_id
  ) {
    console.error(
      "telephony:webhook_stale_deployment_mismatch",
      vaaniNumber,
      event.providerDeploymentId,
    );
    return;
  }

  const gate = await checkTelephonyAccess(phoneNumber.organization_id, phoneNumber.id, "inbound");

  // A provider whose own runtime handles the entire call (e.g. Sarvam Voice
  // Agents) can deliver its one-and-only webhook already in a terminal
  // status — unlike Exotel's ringing/answered/completed sequence of
  // separate events, there may be no later applyCallEvent patch to fill in
  // ended_at/duration_seconds/transcript, so this insert must capture them
  // itself whenever the very first event is already terminal. For a
  // provider whose first event is NOT terminal (Exotel today), this
  // resolves to exactly the same values the column defaults already
  // provided (ended_at: null, duration_seconds: 0, transcript: null) — no
  // behavior change there.
  const isTerminal = TERMINAL_CALL_STATUSES.includes(event.status);

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
      ended_at: isTerminal ? event.occurredAt : null,
      duration_seconds: event.durationSeconds ?? 0,
      transcript:
        event.transcript && event.transcript.length > 0 ? (event.transcript as never) : null,
      provider_metadata: buildProviderMetadata(event) as never,
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
    await terminateAgentRuntime(call.id, `call ended: ${event.status}`);
    await finalizeCallBilling(call, event.durationSeconds ?? 0);
  }
}

/**
 * Resolves a Klyro-created outbound tracking row by the client-reference
 * Klyro itself attached before ever contacting the provider (currently: the
 * row's own `id` — see telephony-outbound.functions.ts and the Sarvam
 * outbound design in the migration report). Returns null on no match; never
 * widens the search (no fuzzy match, no fallback to phone number or any
 * other payload field) — an unmatched reference means the event is dropped
 * by the caller, not attributed by guesswork.
 */
async function resolveOutboundCallByClientReference(providerId: string, clientReference: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("call_logs")
    .select("*")
    .eq("id", clientReference)
    .eq("provider", providerId)
    .eq("direction", "outbound")
    .maybeSingle();
  return data ?? null;
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

  const patch: Record<string, unknown> = {
    status: event.status,
    provider_metadata: buildProviderMetadata(event),
  };
  if (event.status === "answered" && !call.answered_at) patch["answered_at"] = event.occurredAt;
  if (event.recordingUrl) patch["recording_url"] = event.recordingUrl;
  if (event.failureReason) patch["failure_reason"] = event.failureReason;
  if (event.transcript && event.transcript.length > 0) patch["transcript"] = event.transcript;
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
    await terminateAgentRuntime(call.id, `call ended: ${event.status}`);
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
