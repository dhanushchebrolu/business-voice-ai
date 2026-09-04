import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RotateCcw } from "lucide-react";
import { listRefunds } from "@/lib/admin-finance.functions";
import {
  PageHeader,
  SectionCard,
  StatCard,
  LoadingState,
  ErrorState,
  EmptyState,
  StatusPill,
} from "@/components/app/primitives";
import { formatMoney } from "@/lib/pricing";

export const Route = createFileRoute("/admin/refunds")({
  component: AdminRefunds,
});

const TONE = { processed: "live", pending: "ready", failed: "error" } as const;

function AdminRefunds() {
  const fetchRefunds = useServerFn(listRefunds);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-refunds"],
    queryFn: () => fetchRefunds(),
  });

  if (isLoading) return <LoadingState label="Loading refunds" />;
  if (error)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load refunds"}
        onRetry={() => void refetch()}
      />
    );

  const rows = data ?? [];
  const processed = rows.filter((r) => r.status === "processed");
  const pending = rows.filter((r) => r.status === "pending");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Refunds"
        description="Every refund attempt, its provider status, and who requested it. Refunds are initiated from the Billing screen."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Processed"
          value={formatMoney(
            processed.reduce((s, r) => s + r.amount, 0),
            "INR",
          )}
        />
        <StatCard
          label="Pending provider confirmation"
          value={pending.length}
          tone={pending.length > 0 ? "accent" : "default"}
        />
        <StatCard label="Total refund requests" value={rows.length} />
      </div>

      <SectionCard title="Refund history">
        {rows.length === 0 ? (
          <EmptyState
            icon={RotateCcw}
            title="No refunds yet"
            description="Refunds requested from the Billing screen will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Customer</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Reason</th>
                  <th className="py-2 pr-4">Requested by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-2.5 pr-4">
                      <p className="font-medium">{r.customerName}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{r.clientId}</p>
                    </td>
                    <td className="py-2.5 pr-4 tabular">{formatMoney(r.amount, r.currency)}</td>
                    <td className="py-2.5 pr-4">
                      <StatusPill tone={TONE[r.status as keyof typeof TONE] ?? "idle"}>
                        {r.status}
                      </StatusPill>
                    </td>
                    <td
                      className="py-2.5 pr-4 max-w-[240px] truncate text-xs text-muted-foreground"
                      title={r.reason ?? ""}
                    >
                      {r.reason ?? "—"}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-muted-foreground">
                      {r.requested_by_email ?? "—"}
                    </td>
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
