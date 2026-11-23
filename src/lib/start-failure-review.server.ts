import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { decideCampaignContactOutcome } from "./campaign-outcome.ts";

/**
 * Operator review of a contradicted start failure (F2): Sarvam rejected the
 * start request (the call was recorded `failed`, never placed, ₹0), then a
 * provider report for it arrived anyway (resolution_conflict, Needs review).
 *
 *   call_confirmed     the call did happen. The record keeps its original
 *                      outcome and stays unbilled (the customer was told it
 *                      failed; ClickAI absorbs it). A campaign contact takes
 *                      the provider's outcome as final: never redialled.
 *   no_call_confirmed  it did not happen. A campaign contact is released to
 *                      the campaign's normal retry policy only when the
 *                      operator explicitly allows it (allowRetry); otherwise
 *                      it ends `failed`.
 *   unresolved         nothing changes; the call stays in Needs review (the
 *                      reason is audited by the caller).
 *
 * Exactly once, whatever the timing: the call row is claimed first by a
 * conditional update (resolution_conflict true -> false, the decision stored
 * on it); a repeat, a double click or a retry after a crash finds that stored
 * decision and re-applies the contact step, which is itself conditional (only
 * while the contact is still held on this call). The first decision wins.
 * Nothing here bills, refunds or dials.
 */

export const START_FAILURE_DECISIONS = [
  "call_confirmed",
  "no_call_confirmed",
  "unresolved",
] as const;
export type StartFailureDecision = (typeof START_FAILURE_DECISIONS)[number];

interface StoredReview {
  decision: StartFailureDecision;
  allowRetry: boolean;
  reason: string;
  reviewedBy: string;
  reviewedAt: string;
}

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export async function reviewContradictedStartFailure(
  admin: SupabaseClient<Database>,
  input: {
    callId: string;
    decision: StartFailureDecision;
    allowRetry: boolean;
    reason: string;
    reviewedBy: string;
    now?: Date | undefined;
  },
): Promise<{
  organizationId: string;
  applied: StoredReview | null;
  duplicate: boolean;
  contact: string | null;
}> {
  const { data: call, error } = await admin
    .from("call_logs")
    .select(
      "id, organization_id, provider, direction, status, resolution_source, resolution_conflict, provider_metadata, campaign_id, campaign_contact_id",
    )
    .eq("id", input.callId)
    .maybeSingle();
  if (error) throw error;
  if (!call || call.provider !== "sarvam" || call.direction !== "outbound")
    throw new Error("Sarvam outbound call not found.");
  if (call.resolution_source !== "start_failure")
    throw new Error("Only a call recorded as a rejected start can be reviewed here.");

  const metadata = asObject(call.provider_metadata);
  let stored = metadata["operator_review"] as StoredReview | undefined;
  let duplicate = false;

  if (input.decision === "unresolved") {
    if (!call.resolution_conflict) throw new Error("This call was already reviewed.");
    return { organizationId: call.organization_id, applied: null, duplicate: false, contact: null };
  }

  if (call.resolution_conflict) {
    const review: StoredReview = {
      decision: input.decision,
      allowRetry: input.decision === "no_call_confirmed" && input.allowRetry,
      reason: input.reason,
      reviewedBy: input.reviewedBy,
      reviewedAt: (input.now ?? new Date()).toISOString(),
    };
    const { data: claimed, error: claimError } = await admin
      .from("call_logs")
      .update({
        resolution_conflict: false,
        resolved_by: input.reviewedBy,
        provider_metadata: { ...metadata, operator_review: review } as never,
      })
      .eq("id", call.id)
      .eq("resolution_conflict", true)
      .select("id");
    if (claimError) throw claimError;
    if (claimed && claimed.length > 0) stored = review;
    else {
      // Someone else decided meanwhile: theirs stands.
      const { data: again } = await admin
        .from("call_logs")
        .select("provider_metadata")
        .eq("id", call.id)
        .maybeSingle();
      stored = asObject(again?.provider_metadata)["operator_review"] as StoredReview | undefined;
      duplicate = true;
    }
  } else duplicate = true;
  if (!stored) throw new Error("This call is not waiting for review.");

  const contact =
    call.campaign_id && call.campaign_contact_id
      ? await applyToContact(admin, call, stored, metadata, input.now)
      : null;
  return { organizationId: call.organization_id, applied: stored, duplicate, contact };
}

/** The held campaign contact follows the stored decision, once (only while still held on this call). */
async function applyToContact(
  admin: SupabaseClient<Database>,
  call: { id: string; campaign_id: string | null; campaign_contact_id: string | null },
  review: StoredReview,
  metadata: Record<string, unknown>,
  now: Date | undefined,
): Promise<string | null> {
  let patch: { status: string; next_attempt_at: string | null; outcome?: string };
  if (review.decision === "call_confirmed") {
    const reported = String(asObject(metadata["late_provider_report"])["status"] ?? "");
    const final = ["completed", "no_answer", "busy", "failed"].includes(reported)
      ? reported
      : "failed";
    patch = { status: final, next_attempt_at: null, outcome: final };
  } else if (review.allowRetry) {
    const [{ data: campaign, error: ce }, { data: contact, error: te }] = await Promise.all([
      admin
        .from("campaigns")
        .select("max_attempts, retry_after_minutes, retry_statuses")
        .eq("id", call.campaign_id!)
        .maybeSingle(),
      admin
        .from("campaign_contacts")
        .select("attempts")
        .eq("id", call.campaign_contact_id!)
        .maybeSingle(),
    ]);
    if (ce) throw ce;
    if (te) throw te;
    if (!campaign || !contact) throw new Error("Campaign or contact not found.");
    const d = decideCampaignContactOutcome(
      "failed",
      contact.attempts,
      {
        maxAttempts: campaign.max_attempts,
        retryAfterMinutes: campaign.retry_after_minutes,
        retryStatuses: campaign.retry_statuses,
      },
      null,
      now,
    );
    patch = { status: d.status, next_attempt_at: d.nextAttemptAt };
  } else patch = { status: "failed", next_attempt_at: null };

  const { data, error } = await admin
    .from("campaign_contacts")
    .update(patch)
    .eq("id", call.campaign_contact_id!)
    .eq("current_call_id", call.id)
    .eq("status", "outcome_unknown")
    .select("status");
  if (error) throw error;
  return data && data.length > 0 ? patch.status : null;
}
