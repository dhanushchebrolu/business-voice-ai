import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Minimal dashboard read for Phase 4 customer payments — spec: "no
 * secrets exposed." Selects only the columns a staff member needs to see
 * payment/booking-reconciliation state at a glance (status, amount,
 * currency, timestamps, provider reference, last_error) — never a
 * Razorpay access token, webhook secret, or anything from
 * razorpay_connections' own ciphertext columns.
 *
 * RLS-scoped read (payment_requests' own "tenant payment requests read"
 * policy already enforces is_org_member(organization_id)) — same
 * convention as bookings.functions.ts's listBookings: no supabaseAdmin,
 * no separate ownership check needed beyond what RLS already does.
 */

async function resolveOrgId(context: { supabase: unknown; userId: string }): Promise<string> {
  const supabase = context.supabase as import("@supabase/supabase-js").SupabaseClient<
    import("@/integrations/supabase/types").Database
  >;
  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", context.userId)
    .limit(1)
    .maybeSingle();
  if (!membership) throw new Error("No workspace found for your account.");
  return membership.organization_id;
}

export interface PaymentRequestListItem {
  id: string;
  businessId: string;
  bookingId: string;
  status: string;
  amountMinorUnits: number;
  currency: string;
  provider: string;
  providerReference: string | null;
  paymentLinkUrl: string | null;
  lastError: string | null;
  createdAt: string;
  capturedAt: string | null;
  expiresAt: string | null;
  bookingCustomerName: string | null;
  bookingStartAt: string | null;
}

const RECENT_LIMIT = 100;

export const listPaymentRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PaymentRequestListItem[]> => {
    const organizationId = await resolveOrgId(context);

    const { data: paymentRequests, error } = await context.supabase
      .from("payment_requests")
      .select(
        "id, business_id, booking_id, status, amount_minor_units, currency, provider, provider_payment_link_id, provider_order_id, provider_payment_id, payment_link_url, last_error, created_at, captured_at, expires_at",
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(RECENT_LIMIT);
    if (error) throw error;
    if (!paymentRequests || paymentRequests.length === 0) return [];

    const bookingIds = [...new Set(paymentRequests.map((pr) => pr.booking_id))];
    const { data: bookings, error: bookingsError } = await context.supabase
      .from("bookings")
      .select("id, customer_name, start_at")
      .in("id", bookingIds);
    if (bookingsError) throw bookingsError;
    const bookingsById = new Map((bookings ?? []).map((b) => [b.id, b]));

    return paymentRequests.map((pr) => {
      const booking = bookingsById.get(pr.booking_id);
      return {
        id: pr.id,
        businessId: pr.business_id,
        bookingId: pr.booking_id,
        status: pr.status,
        amountMinorUnits: pr.amount_minor_units,
        currency: pr.currency,
        provider: pr.provider,
        providerReference:
          pr.provider_payment_link_id ?? pr.provider_order_id ?? pr.provider_payment_id ?? null,
        paymentLinkUrl: pr.payment_link_url,
        lastError: pr.last_error,
        createdAt: pr.created_at,
        capturedAt: pr.captured_at,
        expiresAt: pr.expires_at,
        bookingCustomerName: booking?.customer_name ?? null,
        bookingStartAt: booking?.start_at ?? null,
      };
    });
  });
