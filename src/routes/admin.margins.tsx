import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { TrendingUp } from "lucide-react";
import { getProfitAnalytics } from "@/lib/admin-finance.functions";
import {
  PageHeader,
  SectionCard,
  StatCard,
  LoadingState,
  ErrorState,
  EmptyState,
} from "@/components/app/primitives";
import { formatMoney } from "@/lib/pricing";

export const Route = createFileRoute("/admin/margins")({
  component: AdminMargins,
});

function AdminMargins() {
  const fetchAnalytics = useServerFn(getProfitAnalytics);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-profit-analytics"],
    queryFn: () => fetchAnalytics(),
  });

  if (isLoading) return <LoadingState label="Loading margin analytics" />;
  if (error)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load margin analytics"}
        onRetry={() => void refetch()}
      />
    );

  const { rows, totals } = data ?? { rows: [], totals: null };
  const rowsWithActivity = rows.filter(
    (r) => r.revenue !== 0 || r.payments !== 0 || r.walletBalance !== 0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Profit &amp; margin"
        description="Admin-only. Revenue and provider cost come from real usage and payment records — never fabricated, never shown to customers."
      />

      {totals ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Payments captured" value={formatMoney(totals.payments, "INR")} />
          <StatCard
            label="Usage revenue"
            value={formatMoney(totals.revenue, "INR")}
            hint="From billable_cost on usage_records"
          />
          <StatCard label="Provider cost" value={formatMoney(totals.providerCost, "INR")} />
          <StatCard
            label="Gross profit"
            value={formatMoney(totals.grossProfit, "INR")}
            tone="accent"
          />
          <StatCard
            label="Margin %"
            value={totals.marginPct !== null ? `${totals.marginPct.toFixed(1)}%` : "—"}
          />
        </div>
      ) : null}

      <SectionCard
        title="By customer"
        description="Usage revenue is billable_cost from real usage_records; it will read zero for every customer until call/WhatsApp usage charging exists (Phase D). Payments (setup fee, monthly plan) are already real."
      >
        {rowsWithActivity.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title="No billing activity yet"
            description="Once customers make payments or generate billed usage, their margin breakdown appears here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-4">Customer</th>
                  <th className="py-2 pr-4">Payments</th>
                  <th className="py-2 pr-4">Usage revenue</th>
                  <th className="py-2 pr-4">Provider cost</th>
                  <th className="py-2 pr-4">Gross profit</th>
                  <th className="py-2 pr-4">Margin %</th>
                  <th className="py-2 pr-4">Wallet balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rowsWithActivity.map((r) => (
                  <tr key={r.orgId}>
                    <td className="py-2.5 pr-4">
                      <p className="font-medium">{r.name}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{r.clientId}</p>
                    </td>
                    <td className="py-2.5 pr-4 tabular">{formatMoney(r.payments, "INR")}</td>
                    <td className="py-2.5 pr-4 tabular">{formatMoney(r.revenue, "INR")}</td>
                    <td className="py-2.5 pr-4 tabular">{formatMoney(r.providerCost, "INR")}</td>
                    <td className="py-2.5 pr-4 tabular font-medium">
                      {formatMoney(r.grossProfit, "INR")}
                    </td>
                    <td className="py-2.5 pr-4 tabular">
                      {r.marginPct !== null ? `${r.marginPct.toFixed(1)}%` : "—"}
                    </td>
                    <td className="py-2.5 pr-4 tabular">{formatMoney(r.walletBalance, "INR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
