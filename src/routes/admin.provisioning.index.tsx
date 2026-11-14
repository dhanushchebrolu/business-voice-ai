import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Workflow } from "lucide-react";
import { listProvisioningQueue } from "@/lib/provisioning-admin.functions";
import { QUEUE_FILTERS, queueStatusTone, type QueueStatus } from "@/lib/provisioning-view";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusPill,
} from "@/components/app/primitives";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/admin/provisioning/")({
  component: ProvisioningQueue,
});

const when = (v: string) => new Date(v).toLocaleString();
const SEARCH_DEBOUNCE_MS = 300;

function ProvisioningQueue() {
  const fetchQueue = useServerFn(listProvisioningQueue);
  const [status, setStatus] = useState<QueueStatus | "all">("all");
  const [search, setSearch] = useState("");
  // One request after typing pauses, not one per keystroke (found in browser testing).
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-provisioning-queue", status, query],
    queryFn: () => fetchQueue({ data: { status, search: query } }),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Provisioning"
        description="Each customer's dedicated Sarvam agent, deployment and number. The latest provisioning job per customer."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search customers or numbers"
          placeholder="Search customer, client id or number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        {(["all", ...QUEUE_FILTERS] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-1 text-xs ${status === s ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
          >
            {s}
          </button>
        ))}
      </div>
      <SectionCard
        title="Jobs"
        description="Blocked = waiting on onboarding data, a number or a connection."
      >
        {isLoading ? (
          <LoadingState label="Loading provisioning jobs" />
        ) : error ? (
          <ErrorState
            message={error instanceof Error ? error.message : "Could not load jobs"}
            onRetry={() => void refetch()}
          />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={Workflow}
            title="No provisioning jobs"
            description="Jobs start when a customer pays or an admin retries."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1">Customer</th>
                <th>Number</th>
                <th>Status</th>
                <th>Current step</th>
                <th>Last error</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.runId} className="border-t border-border align-top">
                  <td className="py-1.5">
                    <Link
                      to="/admin/provisioning/$orgId"
                      params={{ orgId: r.organizationId }}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {r.customer}
                    </Link>
                    {r.clientId ? (
                      <div className="text-xs text-muted-foreground">{r.clientId}</div>
                    ) : null}
                  </td>
                  <td className="font-mono text-xs">{r.number ?? "—"}</td>
                  <td>
                    <StatusPill tone={queueStatusTone(r.status)}>{r.status}</StatusPill>
                  </td>
                  <td className="text-xs">{r.currentStep ?? "—"}</td>
                  <td className="max-w-xs text-xs text-destructive">{r.lastError ?? ""}</td>
                  <td className="text-xs text-muted-foreground">{when(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );
}
