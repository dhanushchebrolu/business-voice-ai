import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { runProvisioning, type ProvisioningTrigger } from "../provisioning-runs.server.ts";

/**
 * ClickAI's own (platform) Razorpay webhook: setup fee, monthly plan and
 * phone service fee payments. The route verifies the signature; this module
 * owns idempotency and every database effect.
 *
 * Idempotency, in two layers:
 *  - Event ledger (webhook_events, unique per provider + event id): an event
 *    already marked processed is acknowledged without work. An event that
 *    was recorded but failed (no processed_at) is processed again when
 *    Razorpay redelivers it — a failure is never turned into a silent "ok".
 *  - Payment level (record_razorpay_capture, one transaction keyed by the
 *    Razorpay payment id): payment.captured and order.paid for the same
 *    payment, and concurrent deliveries, produce one payment, one invoice
 *    and one billing extension. Provisioning goes through provisioning_runs
 *    (one active run per organization).
 *
 * Every database error is thrown, so the route answers 500 and Razorpay
 * retries; nothing is reported as done unless it was written.
 */

type Admin = SupabaseClient<Database>;

export interface RazorpayEvent {
  event?: string;
  payload?: {
    payment?: { entity?: Record<string, unknown> };
    refund?: { entity?: Record<string, unknown> };
  };
}

export type LedgerDecision = { process: true } | { process: false; reason: "already_processed" };

/** Records the event, or decides whether a previously recorded one still needs work. */
export async function claimWebhookEvent(
  admin: Admin,
  eventId: string,
  event: RazorpayEvent,
  raw: unknown,
): Promise<LedgerDecision> {
  const { error } = await admin.from("webhook_events").insert({
    provider: "razorpay",
    event_id: eventId,
    event_type: event.event ?? null,
    payload: raw as Database["public"]["Tables"]["webhook_events"]["Insert"]["payload"],
  });
  if (!error) return { process: true };
  if ((error as { code?: string }).code !== "23505") throw error;

  const { data: existing, error: readError } = await admin
    .from("webhook_events")
    .select("processed_at")
    .eq("provider", "razorpay")
    .eq("event_id", eventId)
    .single();
  if (readError) throw readError;
  return existing.processed_at
    ? { process: false, reason: "already_processed" }
    : { process: true };
}

export async function markWebhookEvent(
  admin: Admin,
  eventId: string,
  outcome: { processed: true; note?: string | null } | { processed: false; error: string },
): Promise<void> {
  const { error } = await admin
    .from("webhook_events")
    .update(
      outcome.processed
        ? { processed_at: new Date().toISOString(), error: outcome.note ?? null }
        : { error: outcome.error },
    )
    .eq("provider", "razorpay")
    .eq("event_id", eventId);
  if (error) throw error;
}

interface CaptureResult {
  found: boolean;
  mismatch?: boolean;
  order_id?: string;
  organization_id?: string;
  purpose?: string;
  payment_id?: string;
  first_capture?: boolean;
  expected_amount?: number;
  expected_currency?: string;
}

export interface ProcessOutcome {
  /** Stored on the ledger row; set for anything an operator should look at. */
  note: string | null;
  provisioningRunId?: string;
}

const PROVISIONING_TRIGGERS: Record<string, ProvisioningTrigger | undefined> = {
  setup_fee: "setup_fee",
  phone_service_fee: "phone_service_fee",
};

export interface ProcessDeps {
  runProvisioning: typeof runProvisioning;
}

export async function processRazorpayPlatformEvent(
  admin: Admin,
  event: RazorpayEvent,
  deps: ProcessDeps = { runProvisioning },
): Promise<ProcessOutcome> {
  const entity = event.payload?.payment?.entity as
    | {
        id?: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        method?: string;
        created_at?: number;
      }
    | undefined;

  if ((event.event === "payment.captured" || event.event === "order.paid") && entity?.order_id) {
    if (!entity.id) throw new Error("Captured payment has no payment id.");
    const capturedAt =
      typeof entity.created_at === "number"
        ? new Date(entity.created_at * 1000).toISOString()
        : new Date().toISOString();
    const { data, error } = await admin.rpc("record_razorpay_capture", {
      p_provider_order_id: entity.order_id,
      p_provider_payment_id: entity.id,
      p_amount: entity.amount ?? -1,
      p_currency: entity.currency ?? "",
      p_method: entity.method ?? null,
      p_captured_at: capturedAt,
    });
    if (error) throw error;
    const capture = data as unknown as CaptureResult;

    // Not one of ClickAI's own orders (customer-to-business payments have
    // their own webhook): nothing to do.
    if (!capture.found) return { note: "order not found" };
    if (capture.mismatch) {
      console.error("razorpay:amount_mismatch", capture.order_id, entity.amount, entity.currency);
      return {
        note: `amount mismatch: paid ${entity.amount} ${entity.currency}, order is ${capture.expected_amount} ${capture.expected_currency}; nothing activated`,
      };
    }

    const trigger = capture.purpose ? PROVISIONING_TRIGGERS[capture.purpose] : undefined;
    if (trigger && capture.organization_id) {
      const run = await deps.runProvisioning(admin, {
        organizationId: capture.organization_id,
        trigger,
        sourcePaymentId: capture.payment_id ?? null,
      });
      console.log(
        "razorpay:webhook_provisioning",
        capture.organization_id,
        run.runId,
        run.claimed ? run.status : "already running",
      );
      return { note: null, provisioningRunId: run.runId };
    }
    return { note: null };
  }

  if (event.event === "payment.failed" && entity?.order_id) {
    // Never regress an order another event already marked paid.
    const { error } = await admin
      .from("payment_orders")
      .update({ status: "failed" })
      .eq("provider_order_id", entity.order_id)
      .neq("status", "paid");
    if (error) throw error;
    return { note: null };
  }

  if (event.event === "refund.processed" || event.event === "refund.failed") {
    const refund = event.payload?.refund?.entity as { id?: string } | undefined;
    if (refund?.id) {
      const processed = event.event === "refund.processed";
      const { error } = await admin
        .from("refunds")
        .update({
          status: processed ? "processed" : "failed",
          processed_at: processed ? new Date().toISOString() : null,
        })
        .eq("provider_refund_id", refund.id);
      if (error) throw error;
    }
    return { note: null };
  }

  return { note: null };
}
