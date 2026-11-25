import { useQuery } from "@tanstack/react-query";
import { getConcurrencyOverview } from "@/lib/outbound-concurrency.functions";
import { describeQueryError } from "@/lib/query-error";
import {
  ErrorState,
  LoadingState,
  SectionCard,
  StatCard,
  StatusPill,
} from "@/components/app/primitives";

/** Admin view: platform capacity and every customer's choice, running calls and limit. */
export function OutboundConcurrencyAdmin() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-concurrency-overview"],
    queryFn: () => getConcurrencyOverview(),
    refetchInterval: 15_000,
  });
  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState message={describeQueryError(error)} />;
  return (
    <SectionCard
      title="Outbound concurrency"
      description="ClickAI's shared call capacity (outbound and incoming) and each customer's outbound setting. Customers who have not chosen run at the default of 2."
    >
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Platform limit" value={data.slotLimit} />
        <StatCard label="In use now" value={data.inUse} />
        <StatCard label="Free" value={data.free} />
      </div>
      {data.customers.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No customer has chosen a setting or has outbound calls running.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-4">Customer</th>
                <th className="py-2 pr-4">Selected</th>
                <th className="py-2 pr-4">Effective limit</th>
                <th className="py-2 pr-4">Outbound now</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.customers.map((c) => (
                <tr key={c.organizationId} className="border-t border-border">
                  <td className="py-2 pr-4">{c.name ?? c.organizationId.slice(0, 8)}</td>
                  <td className="py-2 pr-4 tabular-nums">{c.selected ?? "Default (2)"}</td>
                  <td className="py-2 pr-4 tabular-nums">{c.cap}</td>
                  <td className="py-2 pr-4 tabular-nums">{c.activeOutbound}</td>
                  <td className="py-2">
                    {c.limitedBy === "customer_setting" ? (
                      <StatusPill tone="idle">Waiting: customer's limit</StatusPill>
                    ) : c.limitedBy === "platform" ? (
                      <StatusPill tone="error">Waiting: platform at capacity</StatusPill>
                    ) : (
                      <StatusPill tone="live">Free to start more</StatusPill>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
