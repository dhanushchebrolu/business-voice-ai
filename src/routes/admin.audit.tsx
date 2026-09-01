import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { listAuditLogs } from "@/lib/admin.functions";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/app/primitives";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/admin/audit")({
  component: AdminAudit,
});

function AdminAudit() {
  const fetchLogs = useServerFn(listAuditLogs);
  const [search, setSearch] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-audit"],
    queryFn: () => fetchLogs({ data: {} }),
  });

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return data ?? [];
    return (data ?? []).filter((r) =>
      [r.action, r.admin_email, r.entity_type, r.entity_id, r.reason].some((v) => v?.toLowerCase().includes(term)),
    );
  }, [data, search]);

  return (
    <div className="space-y-6">
      <PageHeader title="Audit logs" description="Immutable record of every privileged platform action." />

      <Input placeholder="Filter by action, admin, entity or reason" value={search} onChange={(e) => setSearch(e.target.value)} className="sm:max-w-sm" />

      {isLoading ? (
        <LoadingState label="Loading audit trail" />
      ) : error ? (
        <ErrorState message={error instanceof Error ? error.message : "Could not load audit logs"} onRetry={() => void refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={ScrollText} title="No audit entries" description="Privileged admin actions will be recorded here as they happen." />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-3 py-2.5 font-medium">Admin</th>
                <th className="px-3 py-2.5 font-medium">Action</th>
                <th className="px-3 py-2.5 font-medium">Entity</th>
                <th className="px-3 py-2.5 font-medium">Change</th>
                <th className="px-4 py-2.5 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60">
                  <td className="px-4 py-2.5 text-xs text-muted-foreground tabular">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-xs">{r.admin_email ?? "system"}</td>
                  <td className="px-3 py-2.5 font-medium">{r.action}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {r.entity_type}
                    {r.entity_id ? ` · ${r.entity_id}` : ""}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                    {JSON.stringify(r.old_value)} → {JSON.stringify(r.new_value)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{r.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
