/**
 * Razorpay customer-payment webhook processing (Phase 4). Server-side
 * verification here is the ONLY thing that may ever transition
 * payment_requests.status to CAPTURED/FAILED/EXPIRED/CANCELLED — nothing
 * else in this codebase writes those values. Deliberately a SEPARATE
 * stream from ClickAI's own platform-billing webhook
 * (src/routes/api/public/webhooks/razorpay.ts): its own idempotency
 * ledger (payment_webhook_events, not webhook_events), its own signing
 * secret (RAZORPAY_CUSTOMER_PAYMENTS_WEBHOOK_SECRET), never touching
 * payment_orders/payments/invoices.
 *
 * Tenant identity is NEVER trusted from the webhook payload. Every
 * payment_requests row is resolved by matching an identifier THIS
 * codebase itself generated at payment-request-creation time
 * (provider_payment_link_id, then provider_order_id, then
 * provider_payment_id) against the payload — never by any organization_id
 * /business_id claim inside the payload itself.
 *
 * Payload shape caveat: this session has no network egress to
 * razorpay.com and could not independently verify Razorpay's exact
 * Payment Link webhook event names/payload field names against live
 * documentation (same constraint as razorpay-payments.server.ts and
 * razorpay-config.server.ts). Rather than branch primarily on the
 * `event` name string (the least-verified part), this module resolves
 * the payment_requests row by matching whatever identifier fields are
 * present (multi-field defensive read, same pattern as readAccountId()
 * in razorpay-oauth.server.ts), and determines the resulting status from
 * the entity's own `status` field via the already-tested
 * mapProviderPaymentLinkStatus(). THIS MUST BE VERIFIED AGAINST LIVE
 * RAZORPAY DOCUMENTATION BEFORE PRODUCTION USE.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { mapProviderPaymentLinkStatus } from "../razorpay/razorpay-payments.server.ts";
import {
  recordPaymentDomainEvent,
  dispatchPaymentDomainEvent,
  type DispatchConsumers,
  type PaymentDomainEventRow,
} from "./payment-events.server.ts";

type Client = SupabaseClient<Database>;

export function getCustomerPaymentsWebhookSecret(): string | null {
  return process.env["RAZORPAY_CUSTOMER_PAYMENTS_WEBHOOK_SECRET"] ?? null;
}

interface ParsedEntity {
  paymentLinkId: string | undefined;
  orderId: string | undefined;
  paymentId: string | undefined;
  rawStatus: string | undefined;
  amountPaid: number | undefined;
  currency: string | undefined;
}

function readStr(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" ? v : undefined;
}
function readNum(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = obj?.[key];
  return typeof v === "number" ? v : undefined;
}

function parseWebhookPayload(raw: string): { eventName: string | undefined; entity: ParsedEntity } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PaymentWebhookError("Invalid JSON payload.", 400);
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  const eventName = typeof body["event"] === "string" ? (body["event"] as string) : undefined;
  const payload = (body["payload"] ?? {}) as Record<string, unknown>;

  const linkEntity = (payload["payment_link"] as { entity?: Record<string, unknown> } | undefined)
    ?.entity;
  const paymentEntity = (payload["payment"] as { entity?: Record<string, unknown> } | undefined)
    ?.entity;
  const orderEntity = (payload["order"] as { entity?: Record<string, unknown> } | undefined)
    ?.entity;

  return {
    eventName,
    entity: {
      // A `payment.failed`/`payment.captured` event on a payment made
      // through a Payment Link commonly carries the link's own id on the
      // payment entity itself (field name unverified live — see the
      // module doc comment — read defensively rather than assumed).
      paymentLinkId: readStr(linkEntity, "id") ?? readStr(paymentEntity, "payment_link_id"),
      orderId: readStr(orderEntity, "id") ?? readStr(paymentEntity, "order_id"),
      paymentId: readStr(paymentEntity, "id"),
      rawStatus: readStr(linkEntity, "status") ?? readStr(paymentEntity, "status"),
      amountPaid: readNum(linkEntity, "amount_paid") ?? readNum(paymentEntity, "amount"),
      currency: readStr(linkEntity, "currency") ?? readStr(paymentEntity, "currency"),
    },
  };
}

export class PaymentWebhookError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type PaymentRequestRow = Database["public"]["Tables"]["payment_requests"]["Row"];

/** Resolves a payment_requests row ONLY by an identifier we ourselves generated — never by anything else in the payload. Tries each identifier in turn, stopping at the first match. */
async function resolvePaymentRequest(
  supabaseAdmin: Client,
  entity: ParsedEntity,
): Promise<PaymentRequestRow | null> {
  const lookups: {
    column: "provider_payment_link_id" | "provider_order_id" | "provider_payment_id";
    value: string | undefined;
  }[] = [
    { column: "provider_payment_link_id", value: entity.paymentLinkId },
    { column: "provider_order_id", value: entity.orderId },
    { column: "provider_payment_id", value: entity.paymentId },
  ];
  for (const { column, value } of lookups) {
    if (!value) continue;
    const { data, error } = await supabaseAdmin
      .from("payment_requests")
      .select("*")
      .eq(column, value)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }
  return null;
}

async function markWebhookEvent(
  supabaseAdmin: Client,
  eventId: string,
  fields: {
    paymentRequestId?: string | undefined;
    eventType?: string | undefined;
    error?: string | undefined;
  },
): Promise<void> {
  await supabaseAdmin
    .from("payment_webhook_events")
    .update({
      processed_at: new Date().toISOString(),
      ...(fields.paymentRequestId ? { payment_request_id: fields.paymentRequestId } : {}),
      ...(fields.eventType ? { event_type: fields.eventType } : {}),
      ...(fields.error ? { error: fields.error } : {}),
    })
    .eq("provider", "razorpay_customer_payment")
    .eq("event_id", eventId);
}

export type WebhookOutcome =
  | "duplicate"
  | "no_matching_request"
  | "amount_mismatch"
  | "currency_mismatch"
  | "captured"
  | "already_captured"
  | "failed"
  | "expired"
  | "ignored";

export interface ProcessWebhookResult {
  outcome: WebhookOutcome;
  domainEvent?: PaymentDomainEventRow;
}

/**
 * Processes one already-signature-verified Razorpay customer-payment
 * webhook delivery. Idempotent: a duplicate event_id (from Razorpay's own
 * at-least-once delivery, or a retried delivery) is detected before any
 * business logic runs and short-circuits safely.
 */
export async function processRazorpayPaymentWebhook(
  supabaseAdmin: Client,
  input: { rawBody: string; eventId: string },
  consumers: DispatchConsumers,
  fetchImpl: typeof fetch = fetch,
): Promise<ProcessWebhookResult> {
  let parsedForStorage: unknown;
  try {
    parsedForStorage = JSON.parse(input.rawBody);
  } catch {
    throw new PaymentWebhookError("Invalid JSON payload.", 400);
  }

  // Idempotency: the unique (provider, event_id) index rejects replays —
  // inserted BEFORE any business logic runs, exactly matching the
  // platform-billing webhook's own battle-tested pattern.
  const { error: dedupeError } = await supabaseAdmin.from("payment_webhook_events").insert({
    provider: "razorpay_customer_payment",
    event_id: input.eventId,
    payload: parsedForStorage as Json,
  });
  if (dedupeError) {
    if (dedupeError.code === "23505") return { outcome: "duplicate" };
    throw dedupeError;
  }

  const { eventName, entity } = parseWebhookPayload(input.rawBody);

  const paymentRequest = await resolvePaymentRequest(supabaseAdmin, entity);
  if (!paymentRequest) {
    await markWebhookEvent(supabaseAdmin, input.eventId, {
      eventType: eventName,
      error: "No matching payment_requests row for any identifier in this payload.",
    });
    return { outcome: "no_matching_request" };
  }

  await markWebhookEvent(supabaseAdmin, input.eventId, {
    paymentRequestId: paymentRequest.id,
    eventType: eventName,
  });

  // A captured payment is never regressed by any later event on this
  // request, regardless of what that later event claims.
  if (paymentRequest.status === "CAPTURED") {
    return { outcome: "already_captured" };
  }

  // A FAILED payment ATTEMPT against a still-open Payment Link does not
  // close the link — Razorpay's Payment Link product stays payable
  // (created/partially_paid) until it is explicitly paid in full, or it
  // expires, or it is cancelled; the customer can simply retry paying the
  // same link after one failed attempt. So this is notification-only:
  // emit PAYMENT_FAILED for a "that attempt didn't go through, want to
  // try again?" message, but deliberately leave payment_requests.status
  // untouched (still CREATED/PENDING, still payable) rather than treating
  // a single failed attempt as terminating the whole request.
  if (entity.rawStatus === "failed") {
    const domainEvent = await recordPaymentDomainEvent(supabaseAdmin, {
      eventType: "PAYMENT_FAILED",
      organizationId: paymentRequest.organization_id,
      businessId: paymentRequest.business_id,
      paymentRequestId: paymentRequest.id,
      bookingId: paymentRequest.booking_id,
      payload: { rawStatus: entity.rawStatus },
    });
    await dispatchPaymentDomainEvent(supabaseAdmin, domainEvent, consumers, fetchImpl);
    return { outcome: "failed", domainEvent };
  }

  const mappedStatus = entity.rawStatus
    ? mapProviderPaymentLinkStatus(entity.rawStatus)
    : undefined;
  if (!mappedStatus || mappedStatus === "PENDING" || mappedStatus === "CREATED") {
    return { outcome: "ignored" };
  }

  if (mappedStatus === "CAPTURED") {
    if (
      entity.amountPaid !== undefined &&
      entity.amountPaid !== paymentRequest.amount_minor_units
    ) {
      await markWebhookEvent(supabaseAdmin, input.eventId, {
        error: `Amount mismatch: payload reported ${entity.amountPaid}, expected ${paymentRequest.amount_minor_units}. Payment NOT captured.`,
      });
      return { outcome: "amount_mismatch" };
    }
    if (entity.currency !== undefined && entity.currency !== paymentRequest.currency) {
      await markWebhookEvent(supabaseAdmin, input.eventId, {
        error: `Currency mismatch: payload reported ${entity.currency}, expected ${paymentRequest.currency}. Payment NOT captured.`,
      });
      return { outcome: "currency_mismatch" };
    }

    // Conditional on NOT already CAPTURED (rather than an unconditional
    // update): Razorpay fires more than one webhook event per underlying
    // transaction (e.g. payment_link.paid and payment.captured/order.paid
    // each carry their own event_id, so the outer payment_webhook_events
    // dedupe does not catch them as literal duplicates), and two such
    // deliveries for the same capture can be processed concurrently — both
    // reading this row as still PENDING before either write commits. This
    // guard makes only the first writer actually apply the CAPTURED
    // transition; the loser below is treated as already_captured, so a
    // PaymentCaptured domain event (and the calendar/WhatsApp/voice
    // dispatch it triggers) is never recorded twice for one payment.
    // Scoped to `<> CAPTURED` specifically (not the exact previously-read
    // status) so this never interferes with the unrelated, legitimate race
    // against the expiration sweep — that transition targets EXPIRED, not
    // CAPTURED, and PAYMENT_CAPTURED_AFTER_EXPIRY already handles a booking
    // that has since moved on.
    const { data: capturedRow, error: captureError } = await supabaseAdmin
      .from("payment_requests")
      .update({
        status: "CAPTURED",
        provider_payment_id: entity.paymentId ?? paymentRequest.provider_payment_id,
        captured_at: new Date().toISOString(),
      })
      .eq("id", paymentRequest.id)
      .neq("status", "CAPTURED")
      .select("id")
      .maybeSingle();
    if (captureError) throw captureError;
    if (!capturedRow) {
      // Lost the race to a concurrent webhook delivery for the same
      // underlying transaction — the other delivery already completed
      // this exact capture. Never double-record/double-dispatch.
      await markWebhookEvent(supabaseAdmin, input.eventId, {
        error: "Payment was already captured by a concurrent webhook delivery.",
      });
      return { outcome: "already_captured" };
    }

    const { data: booking, error: bookingError } = await supabaseAdmin
      .from("bookings")
      .select("id, status")
      .eq("id", paymentRequest.booking_id)
      .maybeSingle();
    if (bookingError) throw bookingError;
    const bookingStillHeld = booking?.status === "PENDING_PAYMENT";

    const domainEvent = await recordPaymentDomainEvent(supabaseAdmin, {
      eventType: bookingStillHeld ? "PAYMENT_CAPTURED" : "PAYMENT_CAPTURED_AFTER_EXPIRY",
      organizationId: paymentRequest.organization_id,
      businessId: paymentRequest.business_id,
      paymentRequestId: paymentRequest.id,
      bookingId: paymentRequest.booking_id,
      payload: { rawStatus: entity.rawStatus, amountPaid: entity.amountPaid ?? null },
    });
    await dispatchPaymentDomainEvent(supabaseAdmin, domainEvent, consumers, fetchImpl);
    return { outcome: "captured", domainEvent };
  }

  // EXPIRED / CANCELLED — the link itself is now closed, unlike a single
  // failed attempt above. No payment_domain_events value exists for
  // CANCELLED specifically; it's recorded as PAYMENT_EXPIRED (the
  // meaningful distinction for downstream consumers is "no money moved,
  // this attempt is over", not why it ended).
  //
  // Same conditional-update race guard as the CAPTURED branch above (e.g.
  // Razorpay sending both payment_link.expired and payment_link.cancelled,
  // or a redelivery with a different event_id, for the same closed link):
  // only the first delivery to reach a still-CREATED/PENDING row actually
  // applies the transition and records/dispatches the domain event; a
  // second, concurrently-processed delivery for the same closure is a
  // no-op rather than a duplicate WhatsApp/voice notification.
  const { data: closedRow, error: updateError } = await supabaseAdmin
    .from("payment_requests")
    .update({ status: mappedStatus })
    .eq("id", paymentRequest.id)
    .in("status", ["CREATED", "PENDING"])
    .select("id")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!closedRow) {
    return { outcome: "ignored" };
  }

  const domainEvent = await recordPaymentDomainEvent(supabaseAdmin, {
    eventType: "PAYMENT_EXPIRED",
    organizationId: paymentRequest.organization_id,
    businessId: paymentRequest.business_id,
    paymentRequestId: paymentRequest.id,
    bookingId: paymentRequest.booking_id,
    payload: { rawStatus: entity.rawStatus },
  });
  await dispatchPaymentDomainEvent(supabaseAdmin, domainEvent, consumers, fetchImpl);
  return { outcome: "expired", domainEvent };
}
