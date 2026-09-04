import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { Wallet } from "lucide-react";
import { listWallets } from "@/lib/admin-finance.functions";
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

export const Route = createFileRoute("/admin/wallets")({
  component: AdminWallets,
});

function AdminWallets() {
  const fetchWallets = useServerFn(listWallets);
  const [search, setSearch] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-wallets"],
    queryFn: () => fetchWallets(),
  });

  const rows = useMemo(() => {
    if (!search.trim()) return data ?? [];
    const q = search.trim().toLowerCase();
    return (data ?? []).filter(
      (r) => r.customerName.toLowerCase().includes(q) || r.clientId.toLowerCase().includes(q),
    );
  }, [data, search]);

  if (isLoading) return <LoadingState label="Loading wallets" />;
  if (error)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load wallets"}
        onRetry={() => void refetch()}
      />
    );

  const totalBalance = (data ?? []).reduce((s, r) => s + r.balance, 0);
  const negativeCount = (data ?? []).filter((r) => r.balance < 0).length;
  const zeroCount = (data ?? []).filter((r) => r.balance === 0).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Wallets"
        description="Every customer's balance, computed live from the immutable ledger. Manual credits/debits happen from each customer's detail page."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Total wallet liability"
          value={formatMoney(totalBalance, "INR")}
          hint="Sum of all customer balances — unconsumed credit, not revenue"
        />
        <StatCard label="Zero balance" value={zeroCount} />
        <StatCard
          label="Negative balance"
          value={negativeCount}
          tone={negativeCount > 0 ? "accent" : "default"}
        />
      </div>

      <SectionCard
        title="Balances"
        description="Search by customer name or client ID."
        actions={
          <Input
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-56 text-xs"
          />
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No customers"
            description="No customers match the current search."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-4">Customer</th>
                  <th className="py-2 pr-4">Balance</th>
                  <th className="py-2 pr-4">Last activity</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.organizationId}>
                    <td className="py-2.5 pr-4">
                      <p className="font-medium">{r.customerName}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{r.clientId}</p>
                    </td>
                    <td className="py-2.5 pr-4 tabular">
                      {r.balance < 0 ? (
                        <StatusPill tone="error">{formatMoney(r.balance, "INR")}</StatusPill>
                      ) : r.balance === 0 ? (
                        <StatusPill tone="idle">₹0</StatusPill>
                      ) : (
                        formatMoney(r.balance, "INR")
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-muted-foreground">
                      {r.lastActivityAt
                        ? new Date(r.lastActivityAt).toLocaleDateString()
                        : "No activity yet"}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link
                        to="/admin/customers/$orgId"
                        params={{ orgId: r.organizationId }}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        View ledger →
                      </Link>
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
