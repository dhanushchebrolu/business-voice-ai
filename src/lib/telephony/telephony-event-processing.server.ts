import {
  checkCallTransition,
  checkTelephonyAccess,
  finalizeCallBilling,
  maskPhoneNumber,
  resolveActivePhoneNumberByDestination,
  TERMINAL_CALL_STATUSES,
} from "@/lib/telephony-guard.server";
import { routeToAgentRuntime, terminateAgentRuntime } from "@/lib/telephony-runtime";
import { runInBackground, type WaitUntil } from "@/lib/background-task.server";
import type { NormalizedCallEvent } from "@/lib/telephony/adapter";
import { maskCallSid } from "@/lib/telephony/media-session-authorization.server";
import {
  buildProviderMetadata,
  checkClientReferenceMatch,
  isPlausibleClientReference,
  metadataOrganizationMatches,
} from "@/lib/telephony/webhook-correlation.server";
import {
  applyOutcomeToCampaignContact,
  maybeCompleteCampaign,
} from "@/lib/campaign-dispatch.server";
import type { CallTerminalStatus } from "@/lib/campaign-outcome";
import { finalizeTerminalCallSafely } from "@/lib/telephony/call-finalization.server";

/** Who reported a final status: the provider's webhook, or an operator's resolution. */
type EventSource = "provider" | "operator";

// Phase 1 finalization (call-finalization.server.ts) covers Sarvam outbound only.
const isSarvamOutbound = (call: { provider: string; direction: string }) =>
  call.provider === "sarvam" && call.direction === "outbound";

/**
 * Shared telephony event processing: turns one normalized provider event into
 * call_logs changes, agent-runtime hand-off, billing and campaign outcomes.
 * Used by the public webhook route (routes/api/public/webhooks/telephony.ts),
 * vobiz-answer.ts, and operator resolution (sarvam-call-resolution.server.ts),
 * so every path applies exactly the same rules. Moved verbatim out of the
 * webhook route so no server function has to import a route module.
 */

/**
 * Applies one normalized event: the call_logs insert/update, entitlement
 * gate, runtime routing, billing and campaign outcome. Callers own
 * authentication and webhook_events deduplication.
 */
export async function processTelephonyEvent(
  providerId: string,
  event: NormalizedCallEvent,
  waitUntil: WaitUntil | undefined,
  /** Operator resolution: apply the event only if it lands on this exact call. */
  options: { onlyCallId?: string } = {},
) {
  const source: EventSource = options.onlyCallId ? "operator" : "provider";
  const isTargetCall = (id: string) => {
    if (!options.onlyCallId || id === options.onlyCallId) return true;
    console.error("telephony:event_target_mismatch", id);
    return false;
  };
  // TEMPORARY DIAGNOSTIC (production incident: routeToAgentRuntime never
  // fires for Vobiz despite the status check being correct — see the
  // runtime-trigger diagnostics below). Fires on every event this function
  // receives, before any branch decision, so the two possible call-graph
  // paths (fresh insert vs. existing-row applyCallEvent) can be told apart
  // from logs alone. No secret/signature/token is logged.
  console.info("telephony:process_event_received", {
    providerId,
    status: event.status,
    direction: event.direction,
    providerCallId: event.providerCallId ? maskCallSid(event.providerCallId) : null,
  });

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: existingCall } = await supabaseAdmin
    .from("call_logs")
    .select("*")
    .eq("provider", providerId)
    .eq("provider_call_id", event.providerCallId)
    .maybeSingle();

  // TEMPORARY DIAGNOSTIC (same incident): the "isNewCall" branch decision
  // itself — the fresh-insert path (below) and applyCallEvent's path
  // (existingCall branch, reached here or via the 23505 race further down)
  // have historically carried DIFFERENT runtime-handoff trigger conditions;
  // this proves which one a given event actually takes.
  console.info("telephony:process_event_branch", {
    providerId,
    status: event.status,
    providerCallId: event.providerCallId ? maskCallSid(event.providerCallId) : null,
    existingCallFound: Boolean(existingCall),
    branch: existingCall ? "existing_call_apply_event" : "new_call_insert",
  });

  if (existingCall) {
    if (!isTargetCall(existingCall.id)) return;
    if (!metadataOrganizationMatches(event, existingCall.organization_id)) {
      console.error("telephony:webhook_organization_mismatch", existingCall.id);
      return;
    }
    await applyCallEvent(existingCall, event, source);
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
    if (!isTargetCall(resolved.id)) return;
    const match = checkClientReferenceMatch(resolved, event);
    if (!match.ok) {
      console.error(`telephony:webhook_${match.reason}`, resolved.id);
      return;
    }
    if (match.backfillProviderCallId) {
      await supabaseAdmin
        .from("call_logs")
        .update({ provider_call_id: event.providerCallId })
        .eq("id", resolved.id)
        .is("provider_call_id", null); // never overwrite an id the call-start code saved meanwhile
      resolved.provider_call_id = event.providerCallId;
    }
    await applyCallEvent(resolved, event, source);
    return;
  }

  if (options.onlyCallId) return; // a targeted event never creates a new (inbound) call row

  const destinationNumber = event.destinationE164 ?? event.toE164;
  if (!destinationNumber) {
    console.error("telephony:webhook_missing_destination_number", event.providerCallId);
    return;
  }

  const phoneNumber = await resolveActivePhoneNumberByDestination(providerId, destinationNumber);
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
      .eq("e164", destinationNumber)
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
      normalized_number: destinationNumber,
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
    console.error("telephony:webhook_active_number_missing_org", destinationNumber);
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
      destinationNumber,
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
      provider_call_id: event.providerCallId ? maskCallSid(event.providerCallId) : null,
      organization_id: phoneNumber.organization_id,
      called_number: maskPhoneNumber(destinationNumber),
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
      destination_number: destinationNumber,
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
        provider_call_id: event.providerCallId ? maskCallSid(event.providerCallId) : null,
      });
      const { data: existingRow } = await supabaseAdmin
        .from("call_logs")
        .select("*")
        .eq("provider", providerId)
        .eq("provider_call_id", event.providerCallId)
        .maybeSingle();
      if (existingRow) {
        await applyCallEvent(existingRow, event, source);
        return;
      }
    }
    throw insertError;
  }
  console.info("telephony:call_log_inserted", {
    provider: providerId,
    provider_call_id: event.providerCallId ? maskCallSid(event.providerCallId) : null,
    call_id: call.id,
    organization_id: phoneNumber.organization_id,
    called_number: maskPhoneNumber(destinationNumber),
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
  //
  // THIRD PRODUCTION INCIDENT (Vobiz, calls dc249661-.../328a707b):
  // identical root cause, different provider. Vobiz's `<Stream>` Voice XML
  // opens its own media WebSocket the same way Exotel's Voicebot Applet
  // does — immediately, with no wait for a separate "answered" signal (see
  // vobiz-media-route.server.ts / vobiz-call-session-durable-object.server.ts)
  // — and Vobiz has no "answered" CallStatus at all (Twilio/Plivo-family
  // semantics; see vobiz-provider.ts's STATUS_MAP). An earlier version of
  // this fix assumed the answer_url's own first callback carries no
  // CallStatus field (falling back to "initiated", exactly like Exotel's
  // documented case) and widened only that branch — but a further
  // production call (328a707b) proved that assumption wrong: Vobiz's real
  // first callback DOES carry a recognized CallStatus — "ringing"
  // (STATUS_MAP maps it straight through, never the "initiated" fallback;
  // call_log_inserted logged status=ringing, not initiated). "ringing" was
  // not checked by this condition for any provider, so routeToAgentRuntime
  // was never invoked at all for that call — not dropped after being
  // called, never called in the first place (telephony:runtime_handoff,
  // routeToAgentRuntime's own first log line, never appeared). "initiated"
  // is kept alongside "ringing" defensively, in case some other Vobiz
  // callback variant genuinely doesn't carry a recognized CallStatus.
  // Without either status covered here, routeToAgentRuntime (and
  // therefore the bridge's one and only onInboundFrame registration, in
  // startRuntimeSession) never fires until a later, separate Vobiz status
  // webhook reports "in-progress" — which, as the dc249661 incident
  // already showed (ringing -> completed with no intermediate status),
  // is not guaranteed to ever arrive before the call ends. Confirmed in
  // production: media session accepted, media frames correctly parsed
  // (vobiz_bridge:media_event_shape), but every frame dropped with no
  // listener (vobiz_bridge:media_frame_dropped_no_listener) because
  // nothing had called onInboundFrame yet. Same safety reasoning as
  // Exotel's case: routeToAgentRuntime/getVobizCallSessionStub are already
  // fully Vobiz-aware (telephony-runtime.ts), and startRuntimeSession's
  // idempotency makes firing this twice (here, and again later if a real
  // "in-progress" event does arrive) a safe no-op. Exotel's own clause is
  // untouched — scoped to "initiated" only, exactly as before.
  const isAnswered = event.status === "answered";
  const isInProgress = event.status === "in_progress";
  const isExotelInitiated = providerId === "exotel" && event.status === "initiated";
  const isVobizRinging = providerId === "vobiz" && event.status === "ringing";
  const isVobizInitiated = providerId === "vobiz" && event.status === "initiated";
  const newCallTriggerMatched =
    isAnswered || isInProgress || isExotelInitiated || isVobizRinging || isVobizInitiated;
  // TEMPORARY DIAGNOSTIC (production incident: routeToAgentRuntime never
  // fires for Vobiz) — logs the exact boolean evaluated at this trigger,
  // site "new_call_insert", every time this branch is reached, regardless
  // of outcome. No secret/signature/token is logged.
  console.info("telephony:runtime_trigger_evaluated", {
    site: "new_call_insert",
    providerId,
    status: event.status,
    direction: event.direction,
    isAnswered,
    isInProgress,
    isInitiated: isExotelInitiated || isVobizInitiated,
    isVobizRinging,
    matched: newCallTriggerMatched,
  });
  if (newCallTriggerMatched) {
    console.info("telephony:runtime_trigger_matched", {
      site: "new_call_insert",
      providerId,
      status: event.status,
    });
    console.info("telephony:runtime_handoff_start", {
      site: "new_call_insert",
      callId: call.id,
      providerId,
    });
    runInBackground(
      routeToAgentRuntime({
        callId: call.id,
        organizationId: phoneNumber.organization_id,
        businessId: phoneNumber.business_id,
        agentConfigId: phoneNumber.agent_config_id,
        phoneNumberId: phoneNumber.id,
        destinationE164: phoneNumber.e164,
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
    await terminateAgentRuntime(call.id, `call ended: ${event.status}`, providerId);
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
    caller_number?: string | null;
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
  source: EventSource = "provider",
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const transition = checkCallTransition(call.status, event.status);
  // TEMPORARY DIAGNOSTIC (production incident: routeToAgentRuntime never
  // fires for Vobiz) — this branch (applyCallEvent, reached whenever a row
  // for this provider_call_id already exists) has TWO early returns before
  // ever reaching its own runtime-handoff trigger below; both are silent
  // with respect to that trigger today, so logging them here closes the
  // gap. No secret/signature/token is logged.
  console.info("telephony:apply_call_event_transition", {
    callId: call.id,
    provider: call.provider,
    fromStatus: call.status,
    toStatus: event.status,
    transitionOk: transition.ok,
    transitionChanged: transition.changed,
  });
  if (!transition.ok) {
    console.error("telephony:illegal_transition", call.id, transition.reason);
    await afterFinalCallEvent(call, event, source);
    return;
  }
  if (!transition.changed) {
    // idempotent replay of the same status
    await afterFinalCallEvent(call, event, source);
    return;
  }

  const patch: Record<string, unknown> = {
    status: event.status,
    provider_metadata: buildProviderMetadata(event),
  };
  if (isSarvamOutbound(call) && TERMINAL_CALL_STATUSES.includes(event.status)) {
    // What finalization (call-finalization.server.ts) needs later, written with
    // the final status itself, so it never depends on this event again.
    patch["final_agent_variables"] = event.agentVariables ?? null;
    patch["resolution_source"] = source;
  }
  if (event.status === "answered" && !call.answered_at) patch["answered_at"] = event.occurredAt;
  if (event.recordingUrl) patch["recording_url"] = event.recordingUrl;
  if (event.failureReason) patch["failure_reason"] = event.failureReason;
  if (event.transcript && event.transcript.length > 0) patch["transcript"] = event.transcript;
  if (TERMINAL_CALL_STATUSES.includes(event.status)) {
    patch["ended_at"] = event.occurredAt;
    if (typeof event.durationSeconds === "number")
      patch["duration_seconds"] = event.durationSeconds;
  }

  // Never overwrite a final status: if another event (a concurrent webhook or
  // an operator resolution) already finalized this call, nothing here applies —
  // no status write, no billing, no campaign outcome.
  const { data: updated, error } = await supabaseAdmin
    .from("call_logs")
    .update(patch as never)
    .eq("id", call.id)
    .not("status", "in", `(${TERMINAL_CALL_STATUSES.join(",")})`)
    .select("id");
  if (error) throw error;
  if (!updated || updated.length === 0) {
    console.error("telephony:call_already_final", call.id, event.status);
    await afterFinalCallEvent(call, event, source);
    return;
  }
  console.info("telephony:call_log_updated", {
    provider: call.provider,
    provider_call_id: call.provider_call_id ? maskCallSid(call.provider_call_id) : null,
    call_id: call.id,
    from_status: call.status,
    to_status: event.status,
  });

  // FOURTH PRODUCTION INCIDENT (Vobiz, call 03da4fdb): the new-call insert
  // branch's trigger (processTelephonyEvent, above) was fixed three times
  // to cover Vobiz's "ringing"/"initiated" first-event status — but this
  // function's OWN, separate trigger below was never touched. Any event
  // for a call row that already exists (a second/duplicate webhook
  // delivery, or a race lost against another in-flight insert — see
  // processTelephonyEvent's existingCall check and its 23505 fallback)
  // reaches THIS trigger instead, and it only ever checked "answered"/
  // "in_progress" — never "ringing"/"initiated", for any provider. The
  // comment immediately above (describing "ringing -> answered as two
  // separate events on an already-existing row") already anticipated
  // "ringing" reaching this exact function, but the condition beneath it
  // never implemented that check. Widened the same way as the insert
  // branch: Vobiz's "ringing"/"initiated" now also match here. Exotel is
  // untouched — it was never added to this particular trigger and still
  // isn't; its own fast path is the insert-branch "initiated" clause,
  // which normally makes its runtime already active by the time a second
  // event reaches this function (startRuntimeSession's idempotency makes
  // that a safe no-op either way).
  const isApplyAnswered = event.status === "answered";
  const isApplyInProgress = event.status === "in_progress";
  const isApplyVobizRinging = call.provider === "vobiz" && event.status === "ringing";
  const isApplyVobizInitiated = call.provider === "vobiz" && event.status === "initiated";
  const applyTriggerMatched =
    call.direction === "inbound" &&
    Boolean(call.phone_number_id) &&
    (isApplyAnswered || isApplyInProgress || isApplyVobizRinging || isApplyVobizInitiated);
  // TEMPORARY DIAGNOSTIC (same incident) — logs the exact boolean evaluated
  // at this trigger, site "existing_call_apply_event", every time this
  // function reaches this point, regardless of outcome.
  console.info("telephony:runtime_trigger_evaluated", {
    site: "existing_call_apply_event",
    providerId: call.provider,
    status: event.status,
    direction: call.direction,
    hasPhoneNumberId: Boolean(call.phone_number_id),
    isAnswered: isApplyAnswered,
    isInProgress: isApplyInProgress,
    isVobizRinging: isApplyVobizRinging,
    isInitiated: isApplyVobizInitiated,
    matched: applyTriggerMatched,
  });
  if (applyTriggerMatched && call.phone_number_id) {
    console.info("telephony:runtime_trigger_matched", {
      site: "existing_call_apply_event",
      providerId: call.provider,
      status: event.status,
    });
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
        console.info("telephony:runtime_handoff_start", {
          site: "existing_call_apply_event",
          callId: call.id,
          providerId: call.provider,
        });
        await routeToAgentRuntime({
          callId: call.id,
          organizationId: call.organization_id,
          businessId: phoneNumber.business_id,
          agentConfigId: phoneNumber.agent_config_id,
          phoneNumberId: phoneNumber.id,
          destinationE164: phoneNumber.e164,
          // A later status callback may omit From — fall back to the number
          // recorded from this call's first (signed) webhook event.
          callerE164: event.fromE164 ?? call.caller_number ?? null,
          direction: "inbound",
          provider: call.provider,
          providerCallId: call.provider_call_id,
        });
      } else {
        console.error("telephony:runtime_blocked_by_gate", call.id, gate.reason);
      }
    }
  }

  if (TERMINAL_CALL_STATUSES.includes(event.status) && isSarvamOutbound(call)) {
    await terminateAgentRuntime(call.id, `call ended: ${event.status}`, call.provider);
    // Billing and campaign effects, exactly once and re-runnable. A failure
    // leaves the call `pending`/`failed` for an admin retry; it never fails
    // this event, whose status change is already saved.
    await finalizeTerminalCallSafely(supabaseAdmin, call.id);
    return;
  }

  if (TERMINAL_CALL_STATUSES.includes(event.status)) {
    await terminateAgentRuntime(call.id, `call ended: ${event.status}`, call.provider);
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
 * An event that changed nothing because the Sarvam outbound call it targets is
 * already final. Two things may still be owed:
 *   - an operator decided this call's outcome before the provider's report
 *     arrived: the report is kept (provider_metadata.late_provider_report) and
 *     a disagreement is flagged (resolution_conflict) for admin review — never
 *     applied over the operator's decision;
 *   - the call's finalization may still be pending or failed: run it (a no-op
 *     when it's done, or while another holder has the lease).
 * Other providers and Sarvam inbound calls are unaffected.
 */
async function afterFinalCallEvent(
  call: { id: string; status: string; provider: string; direction: string },
  event: NormalizedCallEvent,
  source: EventSource,
) {
  if (!isSarvamOutbound(call) || !TERMINAL_CALL_STATUSES.includes(call.status as never)) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (source === "provider" && TERMINAL_CALL_STATUSES.includes(event.status)) {
    const { data: row, error } = await supabaseAdmin
      .from("call_logs")
      .select("status, resolution_source, provider_metadata")
      .eq("id", call.id)
      .maybeSingle();
    if (error) throw error;
    if (row && row.resolution_source === "operator") {
      const metadata =
        row.provider_metadata && typeof row.provider_metadata === "object"
          ? (row.provider_metadata as Record<string, unknown>)
          : {};
      const { error: updateError } = await supabaseAdmin
        .from("call_logs")
        .update({
          provider_metadata: {
            ...metadata,
            late_provider_report: {
              status: event.status,
              durationSeconds: event.durationSeconds ?? null,
              failureReason: event.failureReason ?? null,
              attemptId: event.providerAttemptId ?? null,
              receivedAt: new Date().toISOString(),
            },
          } as never,
          resolution_conflict: row.status !== event.status,
        })
        .eq("id", call.id);
      if (updateError) throw updateError;
      console.error("telephony:late_provider_report", call.id, row.status, event.status);
    }
  }

  await finalizeTerminalCallSafely(supabaseAdmin, call.id);
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
