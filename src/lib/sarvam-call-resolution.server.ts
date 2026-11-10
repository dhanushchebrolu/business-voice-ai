import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { NormalizedCallEvent } from "./telephony/adapter.ts";
import { isResolvableSarvamCall } from "./sarvam-call-review.ts";
import type { FinalizationResult } from "./telephony/call-finalization.server.ts";

/**
 * Operator resolution for a Sarvam outbound call whose outcome Klyro could
 * not determine: `outcome_unknown` (the start request failed ambiguously) or
 * `initiated` with a known attempt_id whose webhook never arrived. Nothing
 * resolves these automatically; a platform admin does, from what they can see
 * in Sarvam's dashboard.
 *
 * - "not_placed": the call is marked failed (only if it is still in the state
 *   the operator saw), then finalization runs (call-finalization.server.ts):
 *   no charge, and the campaign's normal "failed" outcome, which may retry.
 * - "placed": a synthetic event goes through the same webhook pipeline as a
 *   real Sarvam webhook (the shared processTelephonyEvent, pinned to this one
 *   call), so the transition rules, billing
 *   (duration only for connected calls) and campaign outcome apply exactly
 *   once. It is deduplicated in webhook_events under the attempt_id when
 *   known, so the real webhook arriving later is ignored.
 */

export type ResolutionOutcome = "completed" | "no_answer" | "busy" | "failed";

export interface ResolveUnknownCallInput {
  callId: string;
  resolution: "not_placed" | "placed";
  outcome?: ResolutionOutcome | undefined;
  durationSeconds?: number | undefined;
  attemptId?: string | undefined;
  /**
   * The operator confirmed they checked this call's status in Sarvam.
   * Required for an `initiated` call: Sarvam accepted it, so it may still be
   * in progress, and recording an outcome can let the campaign dial again.
   */
  confirmedCheckedInSarvam?: boolean | undefined;
  /** The admin who decided (call_logs.resolved_by). */
  resolvedBy?: string | undefined;
}

export interface ResolvableCall {
  id: string;
  organization_id: string;
  status: string;
  provider_call_id: string | null;
  campaign_id: string | null;
  campaign_contact_id: string | null;
}

export interface ResolutionDeps {
  /**
   * Applies the event through the shared telephony pipeline. Defaults to
   * telephony-event-processing.server.ts's processTelephonyEvent("sarvam", …)
   * — the same service the public webhook route uses. Injectable for tests.
   */
  processEvent?: (event: NormalizedCallEvent, options: { onlyCallId: string }) => Promise<void>;
  /**
   * Finalizes a call once it is final (billing + campaign outcome, exactly
   * once). Defaults to call-finalization.server.ts's finalizeTerminalCallSafely.
   */
  finalize?: (callId: string) => Promise<FinalizationResult>;
}

const sharedProcessEvent: NonNullable<ResolutionDeps["processEvent"]> = async (event, options) => {
  const { processTelephonyEvent } =
    await import("./telephony/telephony-event-processing.server.ts");
  await processTelephonyEvent("sarvam", event, undefined, options);
};

export async function resolveUnknownSarvamCall(
  supabaseAdmin: SupabaseClient<Database>,
  input: ResolveUnknownCallInput,
  deps: ResolutionDeps = {},
): Promise<{ status: string; organizationId: string; finalization: FinalizationResult["state"] }> {
  const processEvent = deps.processEvent ?? sharedProcessEvent;
  const finalize =
    deps.finalize ??
    (async (callId: string) => {
      const { finalizeTerminalCallSafely } =
        await import("./telephony/call-finalization.server.ts");
      return finalizeTerminalCallSafely(supabaseAdmin, callId);
    });
  const { data: call } = await supabaseAdmin
    .from("call_logs")
    .select(
      "id, organization_id, provider, direction, status, provider_call_id, campaign_id, campaign_contact_id",
    )
    .eq("id", input.callId)
    .maybeSingle();
  if (!call || call.provider !== "sarvam" || call.direction !== "outbound")
    throw new Error("Sarvam outbound call not found.");
  if (!isResolvableSarvamCall(call))
    throw new Error(`This call doesn't need resolving (status: ${call.status}).`);
  // `initiated` may still be live (Sarvam accepted it), or its start request
  // may still be running or have died before Sarvam answered.
  if (call.status === "initiated" && input.confirmedCheckedInSarvam !== true)
    throw new Error(
      "This call may still be in progress. Confirm you checked its status in Sarvam first.",
    );

  if (input.resolution === "not_placed") {
    const { data: changed, error } = await supabaseAdmin
      .from("call_logs")
      .update({
        status: "failed",
        failure_reason: "Resolved by an operator: the call was not placed.",
        ended_at: new Date().toISOString(),
        resolution_source: "operator",
        resolved_by: input.resolvedBy ?? null,
      })
      .eq("id", call.id)
      .eq("status", call.status)
      .select("id");
    if (error) throw error;
    if (!changed || changed.length === 0)
      throw new Error("This call changed while you were resolving it. Reload and check again.");
    const finalized = await finalize(call.id);
    return {
      status: "failed",
      organizationId: call.organization_id,
      finalization: finalized.state,
    };
  }

  const outcome = input.outcome;
  if (!outcome) throw new Error("Choose the call's outcome.");
  if (input.attemptId && call.provider_call_id && input.attemptId !== call.provider_call_id)
    throw new Error("That attempt ID doesn't match the one recorded for this call.");
  const attemptId = input.attemptId ?? call.provider_call_id ?? undefined;
  const eventKey = attemptId ?? `manual:${call.id}`;

  // An attempt id recorded on another call (possibly another customer's) is a typo or a mix-up.
  if (input.attemptId && !call.provider_call_id) {
    const { data: owner } = await supabaseAdmin
      .from("call_logs")
      .select("id")
      .eq("provider", "sarvam")
      .eq("provider_call_id", input.attemptId)
      .maybeSingle();
    if (owner && owner.id !== call.id)
      throw new Error("That attempt ID belongs to a different call.");
  }

  // Same dedupe key a real webhook for this attempt would use.
  const { error: dedupeError } = await supabaseAdmin.from("webhook_events").insert({
    provider: "sarvam",
    event_id: eventKey,
    event_type: outcome,
    payload: { source: "operator_resolution", call_id: call.id, outcome } as never,
  });
  if (dedupeError) {
    if ((dedupeError as { code?: string }).code === "23505")
      throw new Error("Sarvam's result for this attempt was already recorded.");
    throw dedupeError;
  }

  // If the call's status was never written, drop our dedupe row so neither a
  // retry nor the real webhook for this attempt is blocked by it. Once the
  // status is written the decision stands and the row is kept: billing and
  // the campaign outcome are finalization's job (retried from Needs review).
  const releaseDedupeIfUnapplied = async () => {
    const { data: now } = await supabaseAdmin
      .from("call_logs")
      .select("status")
      .eq("id", call.id)
      .maybeSingle();
    if (now && isResolvableSarvamCall({ ...call, status: now.status }))
      await supabaseAdmin
        .from("webhook_events")
        .delete()
        .eq("provider", "sarvam")
        .eq("event_id", eventKey);
  };

  const event: NormalizedCallEvent = {
    eventId: eventKey,
    providerCallId: eventKey,
    status: outcome,
    direction: "outbound",
    // Same billing rule as a real single-call webhook: only a connected call has billable time.
    durationSeconds: outcome === "completed" ? input.durationSeconds : undefined,
    recordingUrl: null,
    failureReason: outcome === "completed" ? null : "Resolved by an operator.",
    occurredAt: new Date().toISOString(),
    providerAttemptId: attemptId,
    clientReference: call.id,
    raw: { source: "operator_resolution", attempt_id: attemptId ?? null },
  };
  try {
    await processEvent(event, { onlyCallId: call.id });
  } catch (err) {
    await releaseDedupeIfUnapplied();
    throw err;
  }

  const { data: after } = await supabaseAdmin
    .from("call_logs")
    .select("status, resolution_source, finalization_state")
    .eq("id", call.id)
    .maybeSingle();
  if (!after || after.status !== outcome) {
    await releaseDedupeIfUnapplied();
    throw new Error(
      `The call was not updated (now: ${after?.status ?? "missing"}). A webhook may have resolved it first.`,
    );
  }
  await supabaseAdmin
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("provider", "sarvam")
    .eq("event_id", eventKey);
  if (input.resolvedBy && after.resolution_source === "operator") {
    await supabaseAdmin
      .from("call_logs")
      .update({ resolved_by: input.resolvedBy })
      .eq("id", call.id)
      .is("resolved_by", null);
  }
  // The pipeline already ran finalization; this only reports where it stands
  // (and finishes it if that pass didn't).
  const finalized =
    after.finalization_state === "done" ? { state: "done" as const } : await finalize(call.id);
  return { status: outcome, organizationId: call.organization_id, finalization: finalized.state };
}
