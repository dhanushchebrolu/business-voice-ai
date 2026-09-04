import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { PhoneCall } from "lucide-react";
import { listAllCalls } from "@/lib/telephony-admin.functions";
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
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/admin/calls")({
  component: AdminCalls,
});

const STATUS_TONE: Record<string, "live" | "ready" | "idle" | "error"> = {
  completed: "live",
  in_progress: "ready",
  answered: "ready",
  ringing: "idle",
  initiated: "idle",
  failed: "error",
  busy: "error",
  no_answer: "error",
  cancelled: "idle",
};

function AdminCalls() {
  const fetchCalls = useServerFn(listAllCalls);
  const [orgId, setOrgId] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-calls", orgId],
    queryFn: () => fetchCalls({ data: orgId.trim() ? { orgId: orgId.trim() } : {} }),
  });

  if (isLoading) return <LoadingState label="Loading calls" />;
  if (error)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load calls"}
        onRetry={() => void refetch()}
      />
    );

  const rows = data ?? [];
  const revenue = rows.reduce((s, r) => s + r.customerCharge, 0);
  const cost = rows.reduce((s, r) => s + r.providerCost, 0);
  const profit = rows.reduce((s, r) => s + r.grossProfit, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calls"
        description="Every call across every customer, with the real financials. Provider cost and margin are admin-only — customers never see this view."
        actions={
          <Input
            placeholder="Filter by organization ID"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            className="h-9 w-64"
          />
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Revenue" value={formatMoney(revenue, "INR")} />
        <StatCard label="Provider cost" value={formatMoney(cost, "INR")} />
        <StatCard
          label="Gross profit"
          value={formatMoney(profit, "INR")}
          tone={profit >= 0 ? "accent" : "default"}
        />
      </div>

      <SectionCard title={`${rows.length} calls`}>
        {rows.length === 0 ? (
          <EmptyState
            icon={PhoneCall}
            title="No calls yet"
            description="Calls will appear here as numbers go live."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-4">Customer</th>
                  <th className="py-2 pr-4">Direction</th>
                  <th className="py-2 pr-4">From / To</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Duration</th>
                  <th className="py-2 pr-4">Charge</th>
                  <th className="py-2 pr-4">Cost</th>
                  <th className="py-2 pr-4">Profit</th>
                  <th className="py-2 pr-4">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2.5 pr-4">
                      <p className="font-medium">{c.customerName}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{c.clientId}</p>
                    </td>
                    <td className="py-2.5 pr-4 text-xs capitalize">{c.direction}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs">
                      {c.callerNumber ?? "—"} → {c.destinationNumber ?? "—"}
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusPill tone={STATUS_TONE[c.status] ?? "idle"}>{c.status}</StatusPill>
                    </td>
                    <td className="py-2.5 pr-4 tabular text-xs">
                      {Math.floor(c.durationSeconds / 60)}m{" "}
                      {String(c.durationSeconds % 60).padStart(2, "0")}s
                    </td>
                    <td className="py-2.5 pr-4 tabular">
                      {formatMoney(c.customerCharge, c.currency)}
                    </td>
                    <td className="py-2.5 pr-4 tabular">
                      {formatMoney(c.providerCost, c.currency)}
                    </td>
                    <td className="py-2.5 pr-4 tabular">
                      {formatMoney(c.grossProfit, c.currency)}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(c.startedAt).toLocaleString()}
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
