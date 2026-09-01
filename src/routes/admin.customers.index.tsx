import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { Users } from "lucide-react";
import { listCustomers } from "@/lib/admin.functions";
import { PageHeader, LoadingState, ErrorState, EmptyState, StatusPill } from "@/components/app/primitives";
import { formatMoney } from "@/lib/pricing";
import { Input } from "@/components/ui/input";
import { ACCOUNT_STATUS_LABEL, type AccountStatus } from "@/lib/workspace";

const STATUSES = ["all", "payment_required", "setup_in_progress", "active", "suspended", "cancelled"] as const;

export const Route = createFileRoute("/admin/customers/")({
  validateSearch: (search: Record<string, unknown>) => ({
    status: (typeof search["status"] === "string" ? search["status"] : "all") as (typeof STATUSES)[number],
  }),
  component: AdminCustomers,
});

function AdminCustomers() {
  const { status } = Route.useSearch();
  const navigate = Route.useNavigate();
  const fetchCustomers = useServerFn(listCustomers);
  const [search, setSearch] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-customers"],
    queryFn: () => fetchCustomers(),
  });

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data ?? []).filter((c) => {
      if (status !== "all" && c.accountStatus !== status) return false;
      if (!term) return true;
      return [c.name, c.ownerEmail, c.ownerName, c.phoneNumber, c.id].some((v) => v?.toLowerCase().includes(term));
    });
  }, [data, status, search]);

  return (
    <div className="space-y-6">
      <PageHeader title="Customers" description="Every organization on the platform, with billing and access state." />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          placeholder="Search name, email, phone or organization ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-sm"
        />
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => navigate({ search: { status: s } })}
              className={`rounded-full border px-3 py-1 text-xs capitalize transition-colors ${
                status === s ? "border-primary/40 bg-primary/12 text-primary" : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <LoadingState label="Loading customers" />
      ) : error ? (
        <ErrorState message={error instanceof Error ? error.message : "Could not load customers"} onRetry={() => void refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Users} title="No customers match" description="Adjust the filters or search term to see more organizations." />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Organization</th>
                <th className="px-3 py-2.5 font-medium">Owner</th>
                <th className="px-3 py-2.5 font-medium">Business type</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Plan</th>
                <th className="px-3 py-2.5 font-medium">Number</th>
                <th className="px-3 py-2.5 font-medium">Wallet</th>
                <th className="px-4 py-2.5 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const meta = ACCOUNT_STATUS_LABEL[c.accountStatus as AccountStatus];
                return (
                  <tr key={c.id} className="border-b border-border/60 hover:bg-muted/40">
                    <td className="px-4 py-2.5">
                      <Link to="/admin/customers/$orgId" params={{ orgId: c.id }} className="font-medium hover:text-primary">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{c.ownerEmail ?? "—"}</td>
                    <td className="px-3 py-2.5 capitalize text-muted-foreground">{c.businessType?.replace(/_/g, " ") ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      <StatusPill tone={meta?.tone ?? "idle"}>{meta?.label ?? c.accountStatus}</StatusPill>
                    </td>
                    <td className="px-3 py-2.5 capitalize">{c.plan ?? "—"}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">{c.phoneNumber ?? "—"}</td>
                    <td className="px-3 py-2.5 tabular">{formatMoney(c.walletBalance)}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground tabular">{new Date(c.createdAt).toLocaleDateString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
