/**
 * createPaymentRequestForBooking — the one place a payment_requests row is
 * created. Sits between the AI tool layer (payment-tools.server.ts) and
 * PaymentProvider: resolves the booking + merchant connection, creates
 * the provider-side Payment Link, and inserts the row. Idempotent by
 * construction at two layers — an explicit pre-check against
 * idx_payment_requests_one_active_per_booking's intent (return the
 * existing live request instead of creating a second one) plus a
 * unique-violation fallback for the concurrent-retry race the pre-check
 * alone can't close.
 *
 * NEVER writes status: "CAPTURED" here — createPaymentRequest() itself
 * never returns that (a freshly created Payment Link cannot already be
 * paid), but the defensive downgrade below keeps that invariant true even
 * if that contract ever changes, matching the platform-wide rule that
 * only a verified webhook may move a payment to CAPTURED.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { RazorpayPaymentProvider } from "./razorpay-payment-provider.server.ts";
import { PaymentProviderError, type PaymentStatus } from "./payment-provider.ts";

type Client = SupabaseClient<Database>;
type PaymentRequestRow = Database["public"]["Tables"]["payment_requests"]["Row"];

export class PaymentRequestError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export interface PaymentRequestRecord {
  id: string;
  bookingId: string;
  status: PaymentStatus;
  amountMinorUnits: number;
  currency: string;
  paymentLinkUrl: string | null;
}

function toRecord(row: PaymentRequestRow): PaymentRequestRecord {
  return {
    id: row.id,
    bookingId: row.booking_id,
    status: row.status as PaymentStatus,
    amountMinorUnits: row.amount_minor_units,
    currency: row.currency,
    paymentLinkUrl: row.payment_link_url,
  };
}

async function findActivePaymentRequest(
  supabaseAdmin: Client,
  bookingId: string,
): Promise<PaymentRequestRow | null> {
  const { data, error } = await supabaseAdmin
    .from("payment_requests")
    .select("*")
    .eq("booking_id", bookingId)
    .in("status", ["CREATED", "PENDING", "CAPTURED"])
    .maybeSingle();
  if (error) throw error;
  return data;
}

export interface CreatePaymentRequestForBookingInput {
  organizationId: string;
  businessId: string;
  bookingId: string;
  amountMinorUnits: number;
  currency?: string | undefined;
  description?: string | undefined;
  idempotencyKey?: string | undefined;
  fetchImpl?: typeof fetch;
}

export async function createPaymentRequestForBooking(
  supabaseAdmin: Client,
  input: CreatePaymentRequestForBookingInput,
): Promise<PaymentRequestRecord> {
  const { data: booking, error: bookingError } = await supabaseAdmin
    .from("bookings")
    .select("id, organization_id, business_id, status, customer_name, customer_phone, start_at")
    .eq("id", input.bookingId)
    .maybeSingle();
  if (bookingError) throw bookingError;
  if (
    !booking ||
    booking.organization_id !== input.organizationId ||
    booking.business_id !== input.businessId
  ) {
    throw new PaymentRequestError(
      "That booking does not belong to your workspace.",
      "BOOKING_NOT_FOUND",
    );
  }
  if (booking.status !== "PENDING_PAYMENT") {
    throw new PaymentRequestError(
      `This booking is not awaiting payment (current status: ${booking.status}).`,
      "INVALID_BOOKING_STATE",
    );
  }

  const existing = await findActivePaymentRequest(supabaseAdmin, input.bookingId);
  if (existing) return toRecord(existing);

  const { data: connection, error: connectionError } = await supabaseAdmin
    .from("razorpay_connections")
    .select("id, connection_status")
    .eq("organization_id", input.organizationId)
    .eq("business_id", input.businessId)
    .maybeSingle();
  if (connectionError) throw connectionError;
  if (!connection || connection.connection_status !== "CONNECTED") {
    throw new PaymentRequestError(
      "This business has no connected Razorpay merchant account to collect payment with.",
      "MERCHANT_NOT_CONNECTED",
    );
  }

  const currency = input.currency ?? "INR";
  const idempotencyKey = input.idempotencyKey ?? `payment_request:${input.bookingId}`;

  const provider = new RazorpayPaymentProvider(
    {
      supabaseAdmin,
      organizationId: input.organizationId,
      businessId: input.businessId,
      connectionId: connection.id,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    },
    "CONNECTED",
  );

  let result;
  try {
    result = await provider.createPaymentRequest({
      amountMinorUnits: input.amountMinorUnits,
      currency,
      description: input.description ?? `Payment for booking on ${booking.start_at}`,
      customerName: booking.customer_name ?? undefined,
      customerPhone: booking.customer_phone ?? undefined,
      customerEmail: undefined,
      idempotencyKey,
      notes: { booking_id: input.bookingId },
    });
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      throw new PaymentRequestError(err.message, err.code);
    }
    throw err;
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("payment_requests")
    .insert({
      organization_id: input.organizationId,
      business_id: input.businessId,
      booking_id: input.bookingId,
      razorpay_connection_id: connection.id,
      provider: "razorpay",
      provider_payment_link_id: result.providerPaymentLinkId,
      amount_minor_units: input.amountMinorUnits,
      currency,
      status: result.status === "CAPTURED" ? "PENDING" : result.status,
      payment_link_url: result.paymentLinkUrl,
      idempotency_key: idempotencyKey,
    })
    .select("*")
    .single();

  if (insertError) {
    // A concurrent request (double-tap retry, two near-simultaneous tool
    // calls) can lose this race after our own pre-check above passed —
    // idx_payment_requests_one_active_per_booking or the idempotency_key
    // unique constraint catches it here; return the row the winner
    // created instead of erroring, so the caller never sees a duplicate.
    if (insertError.code === "23505") {
      const raceWinner = await findActivePaymentRequest(supabaseAdmin, input.bookingId);
      if (raceWinner) return toRecord(raceWinner);
    }
    throw insertError;
  }
  return toRecord(inserted);
}
