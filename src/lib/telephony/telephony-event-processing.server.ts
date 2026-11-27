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
import { detectSpecialOutcome, type CallTerminalStatus } from "@/lib/campaign-outcome";
import {
  BILLING_HOLD_DURATION_UNKNOWN,
  finalizeTerminalCallSafely,
} from "@/lib/telephony/call-finalization.server";
import { applyCallEventFenced, type WebhookClaim } from "@/lib/telephony/webhook-claim.server";
import {
  finalCallVariables,
  leadNotesFromVariables,
  retainCallVariables,
} from "@/lib/call-variables";

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
  options: {
    /** Operator resolution: apply the event only if it lands on this exact call. */
    onlyCallId?: string;
    /** The webhook_events claim this event runs under: the status write is fenced by it. */
    claim?: WebhookClaim | undefined;
  } = {},
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

  // Admission safety: a customer's agent answering through a deployment
  // ClickAI never recorded blocks that customer's business data until an
  // admin reviews it. Never stops the call from being logged.
  const appId = event.raw?.["app_id"];
  if (
    providerId === "sarvam" &&
    source === "provider" &&
    event.providerDeploymentId &&
    typeof appId === "string" &&
    appId
  ) {
    try {
      const [{ blockAdmissionOnUnknownDeployment }, { supabaseAdmin: admin }] = await Promise.all([
        import("@/lib/sarvam-inbound-admission.server"),
        import("@/integrations/supabase/client.server"),
      ]);
      const r = await blockAdmissionOnUnknownDeployment(admin, {
        appId,
        deploymentId: event.providerDeploymentId,
        now: new Date(),
      });
      if (r.blocked)
        console.error("sarvam:admission_blocked_unknown_deployment", {
          agent_config_id: r.agentConfigId,
          deployment_id: event.providerDeploymentId,
        });
    } catch (err) {
      console.error("sarvam:admission_mismatch_check_failed", (err as Error).message);
    }
  }

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
    await applyCallEvent(existingCall, event, source, options.claim);
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
    await applyCallEvent(resolved, event, source, options.claim);
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
  // status — unlike a ringing/answered/completed sequence of separate
  // events, there may be no later applyCallEvent patch to fill in
  // ended_at/duration_seconds/transcript, so this insert must capture them
  // itself whenever the very first event is already terminal. For a
  // provider whose first event is NOT terminal (Vobiz), this
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
      started_at: event.startedAt ?? event.occurredAt,
      ended_at: isTerminal ? event.occurredAt : null,
      duration_seconds: event.durationSeconds ?? 0,
      transcript:
        event.transcript && event.transcript.length > 0 ? (event.transcript as never) : null,
      provider_metadata: buildProviderMetadata(event) as never,
      // Sarvam's final agent variables: the source the end-of-call outcome is
      // recovered from if the on-end tool call never arrived.
      ...(providerId === "sarvam" && isTerminal
        ? { final_agent_variables: retainCallVariables(event.agentVariables, "inbound") as never }
        : {}),
    })
    .select("*")
    .single();

  if (insertError) {
    // Concurrent duplicate: another in-flight webhook request for this exact
    // (provider, provider_call_id) already won the insert race between this
    // function's own pre-check above (`existingCall`) and this INSERT —
    // exactly the shape a call's fallback-status "call-attempt" event and
    // its very next real status event racing (or a genuine provider retry
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
        await applyCallEvent(existingRow, event, source, options.claim);
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

  // Vobiz's `<Stream>` Voice XML opens its media WebSocket at once, with no
  // separate "answered" signal (it has no such CallStatus). Its first callback
  // reports "ringing", or in some variants no recognized status ("initiated").
  // Waiting for a later status meant the voice runtime never started: media
  // frames arrived with no listener and the caller heard no greeting
  // (production incidents dc249661 and 328a707b). So both start it here.
  // startRuntimeSession is idempotent per call_id, so also triggering on a
  // later "answered"/"in_progress" event is safe. It runs in the background so
  // the webhook answers at once: the socket the runtime waits for may only open
  // after this response. Scoped to Vobiz: a provider without a media bridge
  // would only log a refusal.
  const isAnswered = event.status === "answered";
  const isInProgress = event.status === "in_progress";
  const isVobizRinging = providerId === "vobiz" && event.status === "ringing";
  const isVobizInitiated = providerId === "vobiz" && event.status === "initiated";
  const newCallTriggerMatched = isAnswered || isInProgress || isVobizRinging || isVobizInitiated;
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
    isInitiated: isVobizInitiated,
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
  claim?: WebhookClaim,
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
  if (call.provider === "sarvam" && TERMINAL_CALL_STATUSES.includes(event.status)) {
    // What finalization (outbound) and end-of-call outcome recovery (inbound)
    // need later, written with the final status itself, so neither depends on
    // this event again.
    patch["final_agent_variables"] = retainCallVariables(event.agentVariables, call.direction);
    if (isSarvamOutbound(call)) patch["resolution_source"] = source;
    // Connected, but no usable duration: never billed as 0 or invented; held until verified (F3).
    if (
      isSarvamOutbound(call) &&
      event.status === "completed" &&
      !((event.durationSeconds ?? 0) > 0)
    )
      patch["billing_hold"] = BILLING_HOLD_DURATION_UNKNOWN;
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
  // no status write, no billing, no campaign outcome. Under a webhook claim the
  // write is also fenced: a processor whose claim was taken over writes nothing
  // (applyCallEventFenced throws WebhookClaimLostError).
  let applied: boolean;
  if (claim) {
    applied = (await applyCallEventFenced(supabaseAdmin, claim, call.id, patch)) === "applied";
  } else {
    const { data: updated, error } = await supabaseAdmin
      .from("call_logs")
      .update(patch as never)
      .eq("id", call.id)
      .not("status", "in", `(${TERMINAL_CALL_STATUSES.join(",")})`)
      .select("id");
    if (error) throw error;
    applied = Boolean(updated && updated.length > 0);
  }
  if (!applied) {
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
  // branch: Vobiz's "ringing"/"initiated" now also match here
  // (startRuntimeSession's idempotency makes a repeat a safe no-op).
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
 *   - the outcome was decided without the provider — by an operator, or as a
 *     start failure (Sarvam rejected the start request, so ClickAI recorded it
 *     as never placed) — and the provider's report arrived later: the report is
 *     kept (provider_metadata.late_provider_report) and a disagreement is
 *     flagged (resolution_conflict, listed in Calls → Needs review) — never
 *     applied over the recorded outcome and never billed automatically;
 *   - the call's finalization may still be pending or failed: run it (a no-op
 *     when it's done, or while another holder has the lease).
 * Other providers and Sarvam inbound calls are unaffected.
 */
/** Outcomes recorded without the provider's own report, so a later report is kept for review. */
const LATE_REPORT_SOURCES = new Set(["operator", "start_failure"]);

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
      .select("status, resolution_source, provider_metadata, campaign_contact_id")
      .eq("id", call.id)
      .maybeSingle();
    if (error) throw error;
    if (row && LATE_REPORT_SOURCES.has(row.resolution_source ?? "")) {
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
      // A start rejection the provider contradicts is ambiguous: the campaign contact's
      // automatic retry is stopped (held in outcome_unknown, never redialled) for review.
      if (
        row.resolution_source === "start_failure" &&
        row.status !== event.status &&
        row.campaign_contact_id
      ) {
        const { error: holdError } = await supabaseAdmin
          .from("campaign_contacts")
          .update({ status: "outcome_unknown", next_attempt_at: null })
          .eq("id", row.campaign_contact_id)
          .eq("current_call_id", call.id)
          .eq("status", "retry_scheduled");
        if (holdError) throw holdError;
      }
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
    finalCallVariables(event.agentVariables),
  );

  const completed = await maybeCompleteCampaign(campaignId);
  if (completed) {
    console.error("telephony:campaign_completed", campaignId);
  }

  // A contact who opted out on this call is never turned into a lead for follow-up.
  if (
    event.status === "completed" &&
    contactId &&
    detectSpecialOutcome(finalCallVariables(event.agentVariables)) !== "opted_out"
  ) {
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("name, phone, email")
      .eq("id", contactId)
      .maybeSingle();
    if (contact) {
      const vars = finalCallVariables(event.agentVariables) ?? {};
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
        notes: leadNotesFromVariables(vars),
      });
    }
  }
}
