/**
 * The three Phase 4 payment AI tools (create_payment_required_booking,
 * request_payment, check_payment_status) plus check_calendar_availability
 * is reused as-is from calendar-tools.server.ts — no separate "payments AI
 * brain" is introduced; these are additional tools in the same tool
 * surface, validated and dispatched the same way
 * (resolveCalendarContext/assertToolPermission, both reused here).
 *
 * HARD INVARIANT, enforced by construction rather than by convention: no
 * function in this file ever writes payment_requests.status = "CAPTURED",
 * and no function here creates a Google Calendar event. Both remain the
 * exclusive responsibility of the verified-webhook path
 * (payment-webhook.server.ts) and its calendar consumer
 * (payment-calendar-consumer.server.ts). The AI can request a payment and
 * read its current (server-authoritative) status; it cannot declare one
 * successful.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  resolveCalendarContext,
  assertToolPermission,
  fail,
  type ToolResult,
} from "../calendar/calendar-tools.server.ts";
import {
  createPaymentRequiredBooking,
  BookingError,
  type PaymentHoldRecord,
} from "../calendar/booking-service.server.ts";
import {
  createPaymentRequestForBooking,
  PaymentRequestError,
  type PaymentRequestRecord,
} from "./payment-request-service.server.ts";
import { RazorpayPaymentProvider } from "./razorpay-payment-provider.server.ts";
import { PaymentProviderError, type PaymentStatus } from "./payment-provider.ts";
import { sendWhatsAppPaymentMessage } from "../whatsapp/whatsapp-payments.server.ts";
import { CalendarProviderError } from "../calendar/calendar-provider.ts";
import { GoogleCalendarConnectionError } from "../google-calendar/google-calendar-connection.server.ts";

type Client = SupabaseClient<Database>;

function mapPaymentToolError<T>(err: unknown): ToolResult<T> {
  if (err instanceof BookingError) return fail(err.code, err.message);
  if (err instanceof PaymentRequestError) return fail(err.code, err.message);
  if (err instanceof PaymentProviderError) return fail(err.code, err.message);
  if (err instanceof CalendarProviderError) return fail(err.code, err.message);
  if (err instanceof GoogleCalendarConnectionError) return fail(err.code, err.message);
  return fail("UNKNOWN", "Something went wrong handling that payment request.");
}

export interface CreatePaymentRequiredBookingToolInput {
  organizationId: string;
  businessId: string;
  agentConfigId?: string | undefined;
  serviceId?: string | undefined;
  contactId?: string | undefined;
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  customerEmail?: string | undefined;
  startIso: string;
  endIso: string;
  source: "voice" | "whatsapp" | "website" | "manual";
  idempotencyKey: string;
  callId?: string | undefined;
}

/**
 * Checks availability implicitly (createPaymentRequiredBooking's own
 * atomic Postgres function re-checks the slot itself — see
 * create_booking_payment_hold — so a caller does not need to run
 * check_calendar_availability immediately beforehand for correctness,
 * only for a good user experience) and creates a PENDING_PAYMENT hold.
 * Never creates the Google Calendar event — that only happens after a
 * verified webhook capture (payment-calendar-consumer.server.ts).
 */
export async function create_payment_required_booking(
  supabaseAdmin: Client,
  input: CreatePaymentRequiredBookingToolInput,
): Promise<ToolResult<PaymentHoldRecord>> {
  const permissionError = await assertToolPermission(
    supabaseAdmin,
    input.organizationId,
    input.businessId,
    "booking_payment_required",
  );
  if (permissionError) return fail(permissionError.errorCode, permissionError.message);

  const ctx = await resolveCalendarContext(supabaseAdmin, input.organizationId, input.businessId);
  if ("errorCode" in ctx) return fail(ctx.errorCode, ctx.message);

  try {
    const hold = await createPaymentRequiredBooking(supabaseAdmin, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      calendarConnectionId: ctx.connectionId,
      serviceId: input.serviceId ?? null,
      agentConfigId: input.agentConfigId ?? null,
      contactId: input.contactId ?? null,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      customerEmail: input.customerEmail,
      startIso: input.startIso,
      endIso: input.endIso,
      timezone: ctx.timezone,
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      callId: input.callId,
    });
    return { success: true, data: hold };
  } catch (err) {
    return mapPaymentToolError(err);
  }
}

export interface RequestPaymentToolInput {
  organizationId: string;
  businessId: string;
  bookingId: string;
  amountMinorUnits: number;
  currency?: string | undefined;
  description?: string | undefined;
}

export interface RequestPaymentToolResult {
  paymentRequestId: string;
  status: PaymentStatus;
  paymentLinkUrl: string | null;
  whatsappSent: boolean;
}

/**
 * Wraps PaymentProvider.createPaymentRequest() (via
 * createPaymentRequestForBooking) and sends the initial WhatsApp
 * payment-link message. A WhatsApp delivery failure never fails this
 * tool call or the payment request itself — see
 * whatsapp-payments.server.ts's own doc comment: WhatsApp delivery is
 * never payment truth. The caller (voice/AI layer) should still tell the
 * customer the payment link exists even if whatsappSent is false — e.g.
 * by reading it aloud or via another channel.
 */
export async function request_payment(
  supabaseAdmin: Client,
  input: RequestPaymentToolInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult<RequestPaymentToolResult>> {
  const permissionError = await assertToolPermission(
    supabaseAdmin,
    input.organizationId,
    input.businessId,
    "payment_request",
  );
  if (permissionError) return fail(permissionError.errorCode, permissionError.message);

  let paymentRequest: PaymentRequestRecord;
  try {
    paymentRequest = await createPaymentRequestForBooking(supabaseAdmin, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      bookingId: input.bookingId,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      description: input.description,
      fetchImpl,
    });
  } catch (err) {
    return mapPaymentToolError(err);
  }

  let whatsappSent = false;
  try {
    const { data: booking } = await supabaseAdmin
      .from("bookings")
      .select("customer_phone")
      .eq("id", input.bookingId)
      .maybeSingle();
    if (booking?.customer_phone) {
      const sendResult = await sendWhatsAppPaymentMessage(
        supabaseAdmin,
        {
          organizationId: input.organizationId,
          businessId: input.businessId,
          bookingId: input.bookingId,
          paymentRequestId: paymentRequest.id,
          customerPhone: booking.customer_phone,
          purpose: "payment_link",
          bodyText: paymentRequest.paymentLinkUrl
            ? `Please complete your payment here: ${paymentRequest.paymentLinkUrl}`
            : "We are preparing your payment link and will send it shortly.",
        },
        fetchImpl,
      );
      whatsappSent = sendResult.outcome === "sent";
    }
  } catch {
    // A delivery-path failure (crypto error, DB hiccup while sending the
    // WhatsApp message) must never undo or fail the payment request that
    // was already durably created above — whatsappSent simply stays
    // false, and the caller can decide how else to hand the link over
    // (e.g. read it aloud on the call).
  }

  return {
    success: true,
    data: {
      paymentRequestId: paymentRequest.id,
      status: paymentRequest.status,
      paymentLinkUrl: paymentRequest.paymentLinkUrl,
      whatsappSent,
    },
  };
}

export interface CheckPaymentStatusToolInput {
  organizationId: string;
  businessId: string;
  paymentRequestId: string;
}

export interface CheckPaymentStatusToolResult {
  /** The server-authoritative status — only a verified webhook can ever set this to CAPTURED. This is the value to trust. */
  status: PaymentStatus;
  /** Razorpay's own live-read status, when it could be fetched — informational only, never itself a state transition. Equal to `status` when a live read wasn't possible or wasn't needed. */
  providerStatus: PaymentStatus;
  amountMinorUnits: number;
  currency: string;
  paymentLinkUrl: string | null;
}

/**
 * Read-only. Wraps PaymentProvider.getPaymentRequestStatus() for an
 * informational live check, but the value the AI must actually trust and
 * act on is `status` — the row's own server-stored status, which only
 * processRazorpayPaymentWebhook ever advances to CAPTURED. If the live
 * provider read fails (network, auth), this still succeeds using the
 * stored status alone rather than failing the whole tool call.
 */
export async function check_payment_status(
  supabaseAdmin: Client,
  input: CheckPaymentStatusToolInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult<CheckPaymentStatusToolResult>> {
  const permissionError = await assertToolPermission(
    supabaseAdmin,
    input.organizationId,
    input.businessId,
    "payment_request",
  );
  if (permissionError) return fail(permissionError.errorCode, permissionError.message);

  const { data: pr, error } = await supabaseAdmin
    .from("payment_requests")
    .select("*")
    .eq("id", input.paymentRequestId)
    .maybeSingle();
  if (error) return mapPaymentToolError(error);
  if (!pr || pr.organization_id !== input.organizationId || pr.business_id !== input.businessId) {
    return fail(
      "PAYMENT_REQUEST_NOT_FOUND",
      "That payment request does not belong to your workspace.",
    );
  }

  const status = pr.status as PaymentStatus;
  const base = {
    status,
    providerStatus: status,
    amountMinorUnits: pr.amount_minor_units,
    currency: pr.currency,
    paymentLinkUrl: pr.payment_link_url,
  };

  if (!pr.provider_payment_link_id || status === "CAPTURED") {
    // Already server-verified captured, or nothing to look up yet — no
    // live read needed either way.
    return { success: true, data: base };
  }

  try {
    const provider = new RazorpayPaymentProvider(
      {
        supabaseAdmin,
        organizationId: input.organizationId,
        businessId: input.businessId,
        connectionId: pr.razorpay_connection_id,
        fetchImpl,
      },
      "CONNECTED",
    );
    const live = await provider.getPaymentRequestStatus(pr.provider_payment_link_id);
    return { success: true, data: { ...base, providerStatus: live.status } };
  } catch {
    // A live-read failure is informational-path only — fall back to the
    // stored status rather than failing the tool call.
    return { success: true, data: base };
  }
}
