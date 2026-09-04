import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Receipt, RotateCcw } from "lucide-react";
import {
  listBillingTransactions,
  requestRefund,
  type BillingTransactionRow,
} from "@/lib/admin-finance.functions";
import {
  PageHeader,
  SectionCard,
  StatCard,
  LoadingState,
  ErrorState,
  StatusPill,
  EmptyState,
} from "@/components/app/primitives";
import { formatMoney } from "@/lib/pricing";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/components/admin/ReasonDialog";

export const Route = createFileRoute("/admin/billing")({
  component: AdminBilling,
});

const STATUS_TONE: Record<string, "live" | "error" | "idle" | "ready"> = {
  captured: "live",
  failed: "error",
  created: "idle",
  attempted: "ready",
};

function AdminBilling() {
  const fetchTx = useServerFn(listBillingTransactions);
  const refund = useServerFn(requestRefund);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [refundTarget, setRefundTarget] = useState<BillingTransactionRow | null>(null);
  const [refundAmount, setRefundAmount] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-billing-transactions"],
    queryFn: () => fetchTx(),
  });

  const rows = useMemo(() => {
    let list = data ?? [];
    if (statusFilter !== "all") list = list.filter((r) => r.status === statusFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (r) =>
          r.customerName.toLowerCase().includes(q) ||
          r.clientId.toLowerCase().includes(q) ||
          r.purpose.toLowerCase().includes(q) ||
          (r.providerPaymentId ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [data, search, statusFilter]);

  const totals = useMemo(() => {
    const captured = (data ?? []).filter((r) => r.status === "captured");
    return {
      revenue: captured.reduce((s, r) => s + r.amount, 0),
      count: captured.length,
      refunded: (data ?? []).reduce((s, r) => s + r.refundedAmount, 0),
      failed: (data ?? []).filter((r) => r.status === "failed").length,
    };
  }, [data]);

  if (isLoading) return <LoadingState label="Loading transactions" />;
  if (error)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load transactions"}
        onRetry={() => void refetch()}
      />
    );

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["admin-billing-transactions"] });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        description="Every captured, failed, and refunded payment across the platform."
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard
          label="Captured revenue"
          value={formatMoney(totals.revenue, "INR")}
          tone="accent"
        />
        <StatCard label="Captured payments" value={totals.count} />
        <StatCard label="Refunded" value={formatMoney(totals.refunded, "INR")} />
        <StatCard label="Failed attempts" value={totals.failed} />
      </div>

      <SectionCard
        title="Transactions"
        description="Search by customer, client ID, purpose, or provider payment ID."
        actions={
          <div className="flex gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="all">All statuses</option>
              <option value="captured">Captured</option>
              <option value="failed">Failed</option>
              <option value="created">Created</option>
            </select>
            <Input
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-48 text-xs"
            />
          </div>
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No transactions"
            description="No payments match the current filters."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Customer</th>
                  <th className="py-2 pr-4">Purpose</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Refund</th>
                  <th className="py-2 pr-4">Invoice</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2.5 pr-4">
                      <p className="font-medium">{r.customerName}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{r.clientId}</p>
                    </td>
                    <td className="py-2.5 pr-4 capitalize">{r.purpose.replace(/_/g, " ")}</td>
                    <td className="py-2.5 pr-4 tabular">{formatMoney(r.amount, r.currency)}</td>
                    <td className="py-2.5 pr-4">
                      <StatusPill tone={STATUS_TONE[r.status] ?? "idle"}>{r.status}</StatusPill>
                    </td>
                    <td className="py-2.5 pr-4">
                      {r.refundStatus === "none" ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <StatusPill tone={r.refundStatus === "pending" ? "ready" : "info"}>
                          {r.refundStatus} {formatMoney(r.refundedAmount, r.currency)}
                        </StatusPill>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-[11px] text-muted-foreground">
                      {r.invoiceNumber ?? "—"}
                    </td>
                    <td className="py-2.5 pr-4">
                      {r.status === "captured" && r.refundStatus !== "full" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setRefundTarget(r);
                            setRefundAmount(((r.amount - r.refundedAmount) / 100).toString());
                          }}
                        >
                          <RotateCcw className="mr-1.5 size-3.5" /> Refund
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <ReasonDialog
        open={refundTarget !== null}
        onOpenChange={(open) => !open && setRefundTarget(null)}
        title={`Refund ${refundTarget?.customerName ?? ""}?`}
        description="Calls Razorpay server-side. The refund is only marked processed once Razorpay confirms it — instant methods confirm immediately, others stay pending until the webhook fires."
        extra={
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Refund amount (₹)</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={refundAmount}
              onChange={(e) => setRefundAmount(e.target.value)}
            />
          </div>
        }
        onConfirm={async (reason) => {
          const rupees = Number(refundAmount);
          if (!Number.isFinite(rupees) || rupees <= 0) {
            throw new Error("Enter a valid refund amount");
          }
          const result = await refund({
            data: { paymentId: refundTarget!.id, amount: Math.round(rupees * 100), reason },
          });
          toast.success(
            result.status === "processed"
              ? "Refund processed"
              : "Refund submitted — pending provider confirmation",
          );
          setRefundTarget(null);
          await invalidate();
        }}
      />
    </div>
  );
}
