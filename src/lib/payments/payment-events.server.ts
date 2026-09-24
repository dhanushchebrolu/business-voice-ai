/**
 * PaymentCaptured/Failed/Expired domain event dispatch (Phase 4). The
 * Razorpay customer-payment webhook route (and, later, the expiration
 * cron) never call the calendar/WhatsApp/voice consumers directly — they
 * write exactly one payment_domain_events row via
 * recordPaymentDomainEvent(), then dispatchPaymentDomainEvent() below fans
 * out to whichever consumers are provided, synchronously and in-process
 * (this codebase has no message-queue/pub-sub infrastructure to defer to
 * — see the Phase 4 architecture assessment). Each consumer is
 * independently fault-isolated: a failure in one (e.g. a transient
 * WhatsApp delivery error) never blocks, rolls back, or re-triggers
 * another, and is recorded on the domain event row itself for later
 * reconciliation rather than raised back to the webhook's HTTP response —
 * the payment's own state has already been durably recorded by the time
 * dispatch runs, and a downstream notification failure must never cause
 * Razorpay to retry a webhook whose payment-truth was already correct.
 *
 * This is what keeps "payment truth" (payment_requests.status +
 * payment_domain_events existing) structurally separate from "who got
 * notified" (the *_dispatched_at/*_error columns).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;
type DomainEventUpdate = Database["public"]["Tables"]["payment_domain_events"]["Update"];

export type PaymentDomainEventType =
  "PAYMENT_CAPTURED" | "PAYMENT_FAILED" | "PAYMENT_EXPIRED" | "PAYMENT_CAPTURED_AFTER_EXPIRY";

export interface PaymentDomainEventRow {
  id: string;
  event_type: PaymentDomainEventType;
  organization_id: string;
  business_id: string;
  payment_request_id: string;
  booking_id: string;
  payload: Record<string, unknown>;
}

/**
 * Persists one domain event row. Always call this BEFORE dispatching —
 * the row existing is itself the durable record that a state transition
 * happened, independent of whether any consumer ever successfully runs.
 */
export async function recordPaymentDomainEvent(
  supabaseAdmin: Client,
  input: {
    eventType: PaymentDomainEventType;
    organizationId: string;
    businessId: string;
    paymentRequestId: string;
    bookingId: string;
    payload?: Record<string, unknown>;
  },
): Promise<PaymentDomainEventRow> {
  const { data, error } = await supabaseAdmin
    .from("payment_domain_events")
    .insert({
      event_type: input.eventType,
      organization_id: input.organizationId,
      business_id: input.businessId,
      payment_request_id: input.paymentRequestId,
      booking_id: input.bookingId,
      payload: (input.payload ?? {}) as Json,
    })
    .select("id, event_type, organization_id, business_id, payment_request_id, booking_id, payload")
    .single();
  if (error) throw error;
  return data as PaymentDomainEventRow;
}

export type PaymentDomainEventConsumer = (
  supabaseAdmin: Client,
  event: PaymentDomainEventRow,
  fetchImpl: typeof fetch,
) => Promise<void>;

export interface DispatchConsumers {
  calendar?: PaymentDomainEventConsumer;
  whatsapp?: PaymentDomainEventConsumer;
  voice?: PaymentDomainEventConsumer;
}

const CONSUMER_KEYS: (keyof DispatchConsumers)[] = ["calendar", "whatsapp", "voice"];

/**
 * Dispatches one already-persisted payment_domain_events row to each
 * provided consumer, in the fixed order calendar -> whatsapp -> voice.
 * Never throws — every consumer failure is caught, recorded on the row
 * (<key>_error), and dispatch continues to the next consumer. A consumer
 * that isn't provided (e.g. WhatsApp/voice not wired in yet) is simply
 * skipped, not treated as a failure.
 */
export async function dispatchPaymentDomainEvent(
  supabaseAdmin: Client,
  event: PaymentDomainEventRow,
  consumers: DispatchConsumers,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (const key of CONSUMER_KEYS) {
    const consumer = consumers[key];
    if (!consumer) continue;
    try {
      await consumer(supabaseAdmin, event, fetchImpl);
      await supabaseAdmin
        .from("payment_domain_events")
        .update(dispatchedUpdate(key, new Date().toISOString()))
        .eq("id", event.id);
    } catch (err) {
      await supabaseAdmin
        .from("payment_domain_events")
        .update(errorUpdate(key, err instanceof Error ? err.message : "Unknown dispatch error."))
        .eq("id", event.id);
    }
  }
}

/** Builds a typed Update payload for one consumer's dispatch columns — avoids a dynamic computed-key object literal, which the generated Update type (an exact-property union) rejects. */
function dispatchedUpdate(
  key: "calendar" | "whatsapp" | "voice",
  timestamp: string,
): DomainEventUpdate {
  switch (key) {
    case "calendar":
      return { calendar_dispatched_at: timestamp, calendar_error: null };
    case "whatsapp":
      return { whatsapp_dispatched_at: timestamp, whatsapp_error: null };
    case "voice":
      return { voice_dispatched_at: timestamp, voice_error: null };
  }
}

function errorUpdate(key: "calendar" | "whatsapp" | "voice", message: string): DomainEventUpdate {
  switch (key) {
    case "calendar":
      return { calendar_error: message };
    case "whatsapp":
      return { whatsapp_error: message };
    case "voice":
      return { voice_error: message };
  }
}
