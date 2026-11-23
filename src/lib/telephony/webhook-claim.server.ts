import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * Fenced, crash-safe claims on telephony webhook events (migration
 * 20261126090000). Receipt is not completion: an event is claimed with a
 * lease and a token, marked processed only after its effects are applied,
 * and an unfinished one is taken over (new token) once its lease expires or
 * it recorded an error. A processor that lost its claim can neither apply the
 * call status (apply_call_event_fenced) nor complete / fail the event (both
 * match the token).
 */

type Client = SupabaseClient<Database>;
type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** Longer than any normal processing (status write + finalization); only a stuck one waits this long. */
export const WEBHOOK_CLAIM_LEASE_SECONDS = 120;
/** Automatic tries per event (deliveries + reconciler); operators are never capped. */
export const WEBHOOK_MAX_ATTEMPTS = 10;

export interface WebhookClaim {
  provider: string;
  eventId: string;
  token: string;
}

export type ClaimResult =
  | { result: "claimed"; claim: WebhookClaim; attempt: number; reclaimed: boolean }
  | { result: "processed" }
  | { result: "in_progress"; attempts: number }
  | { result: "exhausted"; attempts: number; error: string | null };

/** The processor's claim was taken over: it applied nothing and must stop. */
export class WebhookClaimLostError extends Error {
  constructor(eventId: string) {
    super(`The claim on webhook event ${eventId} was taken over; this processor stopped.`);
    this.name = "WebhookClaimLostError";
  }
}

export async function claimWebhookEvent(
  admin: Client,
  input: {
    provider: string;
    eventId: string;
    eventType: string | null;
    /** Identifiers only, as before; never the raw webhook. */
    payload: Record<string, unknown>;
    /** null: no attempt cap (operator resolution). */
    maxAttempts: number | null;
  },
): Promise<ClaimResult> {
  const rpc = admin.rpc.bind(admin) as unknown as Rpc;
  const { data, error } = await rpc("claim_webhook_event", {
    _provider: input.provider,
    _event_id: input.eventId,
    _event_type: input.eventType,
    _payload: input.payload,
    _lease_seconds: WEBHOOK_CLAIM_LEASE_SECONDS,
    _max_attempts: input.maxAttempts,
  });
  if (error) throw error;
  const r = (data ?? {}) as Record<string, unknown>;
  switch (r["result"]) {
    case "claimed":
      if (typeof r["token"] !== "string") break;
      if (r["reclaimed"] === true)
        console.warn("webhook_claim:reclaimed", {
          provider: input.provider,
          event_id: input.eventId,
          attempt: r["attempt"],
        });
      return {
        result: "claimed",
        claim: { provider: input.provider, eventId: input.eventId, token: r["token"] },
        attempt: Number(r["attempt"] ?? 1),
        reclaimed: r["reclaimed"] === true,
      };
    case "processed":
      return { result: "processed" };
    case "in_progress":
      return { result: "in_progress", attempts: Number(r["attempts"] ?? 0) };
    case "exhausted":
      console.error("webhook_claim:exhausted", {
        provider: input.provider,
        event_id: input.eventId,
        attempts: r["attempts"],
      });
      return {
        result: "exhausted",
        attempts: Number(r["attempts"] ?? 0),
        error: typeof r["error"] === "string" ? r["error"] : null,
      };
  }
  throw new Error("claim_webhook_event returned an unreadable answer.");
}

/** Marks the event done, only for the current claim. False: the claim was taken over meanwhile. */
export async function completeWebhookEvent(admin: Client, claim: WebhookClaim): Promise<boolean> {
  return finishClaim(admin, claim, { processed_at: new Date().toISOString(), error: null });
}

/** Records a failed pass (retryable at once), only for the current claim. */
export async function failWebhookEvent(
  admin: Client,
  claim: WebhookClaim,
  message: string,
): Promise<boolean> {
  return finishClaim(admin, claim, { error: message.slice(0, 1000) || "failed" });
}

async function finishClaim(
  admin: Client,
  claim: WebhookClaim,
  patch: { processed_at?: string; error: string | null },
): Promise<boolean> {
  const { data, error } = await admin
    .from("webhook_events")
    .update(patch)
    .eq("provider", claim.provider)
    .eq("event_id", claim.eventId)
    .eq("claim_token", claim.token)
    .is("processed_at", null)
    .select("id");
  if (error) throw error;
  if (data && data.length > 0) return true;
  console.warn("webhook_claim:lost", { provider: claim.provider, event_id: claim.eventId });
  return false;
}

/**
 * Observability for the reconcile sweep: Sarvam events still unfinished past
 * the lease (a crashed or stuck processor; the next delivery or the reconciler
 * takes them over) and those that hit the attempt cap (need an operator).
 */
export async function staleWebhookClaims(
  admin: Client,
  now: Date = new Date(),
): Promise<{ stale: number; exhausted: number }> {
  const cutoff = new Date(now.getTime() - WEBHOOK_CLAIM_LEASE_SECONDS * 1000).toISOString();
  const unfinished = () =>
    admin
      .from("webhook_events")
      .select("id", { count: "exact", head: true })
      .eq("provider", "sarvam")
      .is("processed_at", null);
  const [stale, exhausted] = await Promise.all([
    unfinished().or(`claimed_at.lt.${cutoff},and(claimed_at.is.null,created_at.lt.${cutoff})`),
    unfinished().gte("attempts", WEBHOOK_MAX_ATTEMPTS),
  ]);
  if (stale.error) throw stale.error;
  if (exhausted.error) throw exhausted.error;
  const result = { stale: stale.count ?? 0, exhausted: exhausted.count ?? 0 };
  if (result.stale > 0 || result.exhausted > 0) console.warn("webhook_claim:unfinished", result);
  return result;
}

/** The call-status write of a claimed event: 'applied', 'already_final' or (throws) claim lost. */
export async function applyCallEventFenced(
  admin: Client,
  claim: WebhookClaim,
  callId: string,
  patch: Record<string, unknown>,
): Promise<"applied" | "already_final"> {
  const rpc = admin.rpc.bind(admin) as unknown as Rpc;
  const { data, error } = await rpc("apply_call_event_fenced", {
    _provider: claim.provider,
    _event_id: claim.eventId,
    _token: claim.token,
    _call: callId,
    _patch: patch,
  });
  if (error) throw error;
  if (data === "claim_lost") throw new WebhookClaimLostError(claim.eventId);
  if (data === "applied" || data === "already_final") return data;
  throw new Error("apply_call_event_fenced returned an unreadable answer.");
}
