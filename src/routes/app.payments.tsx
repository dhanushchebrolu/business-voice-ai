import { createFileRoute } from "@tanstack/react-router";
import { useQuery, queryOptions } from "@tanstack/react-query";
import {
  PageHeader,
  SectionCard,
  StatusPill,
  LoadingState,
  EmptyState,
} from "@/components/app/primitives";
import { listPaymentRequests } from "@/lib/payments.functions";

/**
 * Minimal, read-only payments view (spec §11: "minimal /app/payments view
 * showing payment_request/business/booking/amount/currency/status/
 * created/expiration/provider reference/error-reconciliation state, no
 * secrets exposed") — same "don't build a huge system in this phase, keep
 * it extensible" scope discipline as app.bookings.tsx. No action buttons:
 * nothing here can transition a payment's status, since only a verified
 * Razorpay webhook may ever do that — this page is purely a
 * reconciliation window into server-authoritative state.
 */

export const Route = createFileRoute("/app/payments")({
  head: () => ({
    meta: [
      { title: "Payments — ClickAI" },
      {
        name: "description",
        content: "Payment requests your AI receptionist has created for customers.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PaymentsPage,
});

const paymentsQuery = queryOptions({
  queryKey: ["payment-requests"],
  queryFn: () => listPaymentRequests(),
});

const STATUS_TONE: Record<string, "live" | "ready" | "idle" | "error"> = {
  CREATED: "idle",
  PENDING: "ready",
  CAPTURED: "live",
  FAILED: "error",
  EXPIRED: "idle",
  CANCELLED: "idle",
};

function formatAmount(amountMinorUnits: number, currency: string): string {
  const major = (amountMinorUnits / 100).toFixed(2);
  return `${currency} ${major}`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function PaymentsPage() {
  const { data: paymentRequests, isLoading } = useQuery(paymentsQuery);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="Payment links your AI receptionist has requested from customers. Only a verified Razorpay webhook can mark one as paid."
      />

      {isLoading ? (
        <LoadingState label="Loading payments" />
      ) : !paymentRequests || paymentRequests.length === 0 ? (
        <EmptyState
          title="No payment requests yet"
          description="Once your AI agent requests a payment for a booking, it will show up here."
        />
      ) : (
        <SectionCard
          title="Recent payment requests"
          description={`${paymentRequests.length} request(s)`}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Customer / booking</th>
                  <th className="py-2 pr-4 font-medium">Amount</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Provider reference</th>
                  <th className="py-2 pr-4 font-medium">Created</th>
                  <th className="py-2 pr-4 font-medium">Captured / expires</th>
                  <th className="py-2 pr-0 font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {paymentRequests.map((pr) => (
                  <tr key={pr.id}>
                    <td className="py-2.5 pr-4">
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {pr.bookingCustomerName ?? "Unnamed customer"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {pr.bookingStartAt
                            ? formatDateTime(pr.bookingStartAt)
                            : "No booking time on file"}
                        </p>
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      {formatAmount(pr.amountMinorUnits, pr.currency)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusPill tone={STATUS_TONE[pr.status] ?? "idle"}>{pr.status}</StatusPill>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-muted-foreground">
                      {pr.providerReference ?? "—"}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(pr.createdAt)}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-xs text-muted-foreground">
                      {pr.status === "CAPTURED"
                        ? formatDateTime(pr.capturedAt)
                        : formatDateTime(pr.expiresAt)}
                    </td>
                    <td className="py-2.5 pr-0 max-w-[240px] truncate text-xs text-muted-foreground">
                      {pr.lastError ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
