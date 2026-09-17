import { createFileRoute } from "@tanstack/react-router";
import {
  checkCallTransition,
  checkTelephonyAccess,
  finalizeCallBilling,
  TERMINAL_CALL_STATUSES,
} from "@/lib/telephony-guard.server";
import { routeToAgentRuntime, terminateAgentRuntime } from "@/lib/telephony-runtime";
import { getRequestWaitUntil, runInBackground, type WaitUntil } from "@/lib/background-task.server";
import type { NormalizedCallEvent } from "@/lib/telephony/adapter";
import {
  buildProviderMetadata,
  isPlausibleClientReference,
} from "@/lib/telephony/webhook-correlation.server";
import {
  applyOutcomeToCampaignContact,
  maybeCompleteCampaign,
} from "@/lib/campaign-dispatch.server";
import type { CallTerminalStatus } from "@/lib/campaign-outcome";

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

  if (!adapter.verifyWebhookSignature(raw, headers, url)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = adapter.normalizeWebhookEvent(raw, headers);
  if (!event) return new Response("Invalid payload", { status: 400 });

  const eventId = event.eventId ?? `${event.providerCallId}:${event.status}:${event.occurredAt}`;

  // Structured webhook-receipt log: method/provider/status/direction/call
  // reference only — never the raw body/query string or headers (which may
  // carry the provider's verify_token/signature material).
  console.info("telephony:webhook_received", {
    method: request.method,
    provider: providerId,
    event_id: eventId,
    status: event.status,
    direction: event.direction,
    provider_call_id: event.providerCallId,
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

async function processTelephonyEvent(
  providerId: string,
  event: NormalizedCallEvent,
  waitUntil: WaitUntil | undefined,
) {
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
    // Diagnostic: does ANY row exist for this exact (already-normalized)
    // e164 at all, under any provider/status? Distinguishes "genuinely no
    // mapping exists" from "wrong provider" or "inactive" without a manual
    // SQL lookup every time this fires. Never logs anything beyond the
    // e164 value itself (not a secret) and other rows' provider/status —
    // no tenant ID, no row ID, no other customer-identifying data.
    const { data: anyMatches } = await supabaseAdmin
      .from("phone_numbers")
      .select("provider, status")
      .eq("e164", vaaniNumber)
      .limit(5);
    // Also log which Supabase PROJECT this Worker is actually querying —
    // only the hostname (e.g. "abcxyz.supabase.co"), never the URL's own
    // query string or the service-role key used to authenticate against
    // it. This is the one fact that distinguishes "the row genuinely
    // doesn't exist in this project" from "this Worker is pointed at a
    // different Supabase project than whatever was used to create the
    // row" — the second case looks identical from inside this function
    // alone (an empty matching_rows_for_number either way), so it needs
    // its own signal to be diagnosable from logs rather than guessed.
    let supabaseHost: string | null = null;
    try {
      const rawUrl = process.env["SUPABASE_URL"];
      supabaseHost = rawUrl ? new URL(rawUrl).hostname : null;
    } catch {
      supabaseHost = "unparseable";
    }
    console.error("telephony:webhook_unknown_number", {
      provider: providerId,
      normalized_number: vaaniNumber,
      matching_rows_for_number: (anyMatches ?? []).map((r) => ({
        provider: r.provider,
        status: r.status,
      })),
      supabase_host: supabaseHost,
    });
    return;
  }
  if (!phoneNumber.organization_id) {
    // Cannot happen through the normal lifecycle (only pool numbers ever
    // have a null organization_id, and this query filters status='active' —
    // a pool number is never 'active'; see the phone_number_pool migration).
    // Guarded anyway rather than trusting that invariant blindly.
    console.error("telephony:webhook_active_number_missing_org", vaaniNumber);
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
  if (!gate.allowed) {
    // Diagnostic: this is the exact point a call that otherwise resolved
    // correctly (real CallSid, real status, real phone_numbers row) still
    // ends up inserted as call_logs.status = 'failed' a few lines below —
    // checkTelephonyAccess rejected it, and gate.reason is always one of
    // four fixed, pre-written strings (never a tenant ID, never a raw DB
    // error) so it's safe to log verbatim. Logged BEFORE the insert since
    // the row (and its id) doesn't exist yet at this point — the insert's
    // own "telephony:call_log_inserted" log line right after this one
    // carries the resulting call_id/status for the same event.
    console.error("telephony:call_rejected_by_gate", {
      provider: providerId,
      provider_call_id: event.providerCallId,
      stage: "entitlement_gate",
      reason: gate.reason,
    });
  }

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

  if (insertError) {
    // Concurrent duplicate: another in-flight webhook request for this exact
    // (provider, provider_call_id) already won the insert race between this
    // function's own pre-check above (`existingCall`) and this INSERT —
    // exactly the shape a call's fallback-status "call-attempt" event and
    // its very next real status event racing (or a genuine Exotel retry
    // delivery) would produce. idx_call_logs_provider_call_id (the existing
    // unique index) rejects the second insert with 23505; fall back to the
    // same update path the pre-check takes for a row that already existed
    // *before* this request started, so a race can never produce two rows
    // for one call.
    if ((insertError as { code?: string }).code === "23505") {
      console.info("telephony:call_log_insert_raced", {
        provider: providerId,
        provider_call_id: event.providerCallId,
      });
      const { data: existingRow } = await supabaseAdmin
        .from("call_logs")
        .select("*")
        .eq("provider", providerId)
        .eq("provider_call_id", event.providerCallId)
        .maybeSingle();
      if (existingRow) {
        await applyCallEvent(existingRow, event);
        return;
      }
    }
    throw insertError;
  }
  console.info("telephony:call_log_inserted", {
    provider: providerId,
    provider_call_id: event.providerCallId,
    call_id: call.id,
    status: call.status,
  });

  if (!gate.allowed) return;

  // ROOT CAUSE (production incident: media session accepted, WebSocket
  // upgrades and Exotel's "start"/"connected" events arrive, but the
  // caller never hears Klyro's greeting): Exotel's Voicebot Applet flow
  // hands the entire live call over to a bidirectional WebSocket the
  // moment the call-flow reaches that step (see
  // exotel-media-route.server.ts / call-session-durable-object.server.ts,
  // and media-session-eligibility.ts's own doc comment on this same
  // race) — its webhook callback for THIS call was observed live to never
  // carry a recognized status at all (falls back to "initiated" — see
  // exotel-provider.ts's normalizeWebhookEvent), and there is no
  // guarantee a later "answered"/"in_progress" event ever arrives for the
  // Voicebot Applet product surface specifically. Waiting for one before
  // calling routeToAgentRuntime meant the Exotel media WebSocket was
  // correctly authorized (media-session-eligibility.ts already allows
  // "initiated") but nothing ever started the Sarvam voice runtime on it
  // — no STT/TTS connection, no greeting, the caller heard only Exotel's
  // own trial-account layer until it timed out and disconnected.
  // startRuntimeSession is idempotent per call_id (voice-runtime.server.ts),
  // so also triggering it here — in addition to the pre-existing
  // "answered"/"in_progress" trigger below and in applyCallEvent, for a
  // provider that DOES send a later status transition — is safe:
  // whichever fires first wins, any later one is a no-op. Scoped to
  // `providerId === "exotel"` specifically, not every provider: a
  // provider without this WS-bridging design (routeToAgentRuntime's own
  // doc comment — "a provider without openMediaBridge... still degrades
  // to handled: false") would otherwise pay a wasted ~15s Durable Object
  // bridge-await timeout (DEFAULT_BRIDGE_TIMEOUT_MS) on every single
  // "initiated" event for no benefit.
  //
  // SECOND PRODUCTION INCIDENT, found after the fix above shipped: this
  // exact call site is Exotel's own Passthru webhook callback — the call
  // flow (App Bazaar) only advances to its Voicebot Applet step, which is
  // what opens the media WebSocket routeToAgentRuntime is about to wait up
  // to 15s for (DEFAULT_BRIDGE_TIMEOUT_MS), once THIS webhook responds
  // 200. Awaiting routeToAgentRuntime here was a deadlock: the socket
  // can't open until this handler returns, and this handler wouldn't
  // return until the socket opened (or the full 15s elapsed). Exotel's own
  // Passthru step has a much shorter timeout than that, so in practice it
  // gave up and took the call-flow's "if the URL returns anything else"
  // branch — silence, then hangup — before our 200 ever arrived, no matter
  // how long it eventually took. Fix: fire this in the background
  // (runInBackground/waitUntil — see background-task.server.ts) so the
  // webhook response goes out immediately and Exotel can reach the
  // Voicebot Applet step — opening the very socket this wait is blocking
  // on — while routeToAgentRuntime's own bridge wait is still in flight.
  // Not applied to the "answered"/"in_progress" trigger in applyCallEvent
  // below: that fires on a later, separate webhook delivery, by which
  // point (for Exotel) the runtime this fast path starts is normally
  // already active, so startRuntimeSession's own idempotency makes that a
  // fast no-op rather than another 15s wait — it was never part of this
  // deadlock.
  if (
    event.status === "answered" ||
    event.status === "in_progress" ||
    (providerId === "exotel" && event.status === "initiated")
  ) {
    runInBackground(
      routeToAgentRuntime({
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
      }),
      waitUntil,
      "telephony:runtime_handoff_background_failed",
    );
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
    campaign_id?: string | null;
    campaign_contact_id?: string | null;
    contact_id?: string | null;
    retry_attempt?: number | null;
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
  console.info("telephony:call_log_updated", {
    provider: call.provider,
    provider_call_id: call.provider_call_id,
    call_id: call.id,
    from_status: call.status,
    to_status: event.status,
  });

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

    if (call.direction === "outbound" && call.campaign_id && call.campaign_contact_id) {
      await applyCampaignTerminalEvent(
        call.campaign_id,
        call.campaign_contact_id,
        call.contact_id ?? null,
        event,
      );
    }
  }
}

/**
 * Rolls a terminal outbound webhook event up into the campaign layer (spec
 * §16/§30/§31/§39): decides retry-vs-terminal for this campaign_contact via
 * the exact same shared decision function the dispatcher's own synchronous
 * failure path uses, marks the campaign completed once nothing is left to
 * dial, and — only on a fully successful call — creates a lead from
 * whatever output variables the provider returned. Never fabricates a lead
 * or an outcome the provider event didn't actually carry.
 */
async function applyCampaignTerminalEvent(
  campaignId: string,
  campaignContactId: string,
  contactId: string | null,
  event: NormalizedCallEvent,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: campaign } = await supabaseAdmin
    .from("campaigns")
    .select(
      "id, name, organization_id, business_id, max_attempts, retry_after_minutes, retry_statuses",
    )
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign) return;

  const { data: cc } = await supabaseAdmin
    .from("campaign_contacts")
    .select("attempts")
    .eq("id", campaignContactId)
    .maybeSingle();
  if (!cc) return;

  await applyOutcomeToCampaignContact(
    campaignContactId,
    event.status as CallTerminalStatus,
    cc.attempts,
    campaign,
    event.agentVariables ?? null,
  );

  const completed = await maybeCompleteCampaign(campaignId);
  if (completed) {
    console.error("telephony:campaign_completed", campaignId);
  }

  if (event.status === "completed" && contactId) {
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("name, phone, email")
      .eq("id", contactId)
      .maybeSingle();
    if (contact) {
      const vars = event.agentVariables ?? {};
      const interest =
        typeof vars["interest_level"] === "string" ? (vars["interest_level"] as string) : null;
      await supabaseAdmin.from("leads").insert({
        organization_id: campaign.organization_id,
        business_id: campaign.business_id,
        campaign_id: campaignId,
        contact_id: contactId,
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        source: "campaign",
        asked_about: campaign.name,
        score: interest === "high" ? "hot" : interest === "low" ? "cold" : "warm",
        notes: Object.keys(vars).length > 0 ? JSON.stringify(vars) : null,
      });
    }
  }
}
