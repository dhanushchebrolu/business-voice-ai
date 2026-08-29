import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, usageQuery, callsQuery } from "@/lib/workspace";
import { PageHeader, SectionCard, StatCard, EmptyState, StatusPill } from "@/components/app/primitives";
import { Wallet } from "lucide-react";

export const Route = createFileRoute("/app/billing")({
  head: () => ({
    meta: [
      { title: "Usage & billing — Vaani" },
      { name: "description", content: "Track call minutes, usage costs and your Vaani subscription." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: BillingPage,
});

function BillingPage() {
  const { user } = useAuth();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const orgId = ws?.organization?.id;
  const { data: usage } = useQuery(usageQuery(orgId));
  const { data: calls } = useQuery(callsQuery(orgId));

  const minutes = Math.round((calls ?? []).reduce((s, c) => s + (c.duration_seconds ?? 0), 0) / 60);
  const cost = (usage ?? []).reduce((s, u) => s + Number(u.billable_cost ?? 0), 0);
  const sub = ws?.subscription;
  const trialEnds = sub?.trial_ends_at ? new Date(sub.trial_ends_at) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage & billing"
        description="Metered call usage and your current plan. Figures come from recorded calls only."
        actions={sub ? <StatusPill tone={sub.status === "active" ? "live" : "ready"}>{sub.status}</StatusPill> : null}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Plan" value={sub?.plan ?? "—"} hint={trialEnds ? `Trial ends ${trialEnds.toLocaleDateString()}` : ""} />
        <StatCard label="Calls" value={calls?.length ?? 0} />
        <StatCard label="Minutes used" value={minutes} />
        <StatCard label="Usage cost" value={`₹${cost.toFixed(2)}`} tone="accent" />
      </div>

      <SectionCard title="Usage records" description="Each metered event recorded against your workspace.">
        {usage?.length ? (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Provider</th>
                  <th className="px-3 py-2 font-medium">Quantity</th>
                  <th className="px-5 py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={u.id} className="border-b border-border/60">
                    <td className="px-5 py-2.5 text-xs text-muted-foreground tabular">{new Date(u.occurred_at).toLocaleString()}</td>
                    <td className="px-3 py-2.5">{u.kind}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{u.provider}</td>
                    <td className="px-3 py-2.5 tabular">
                      {u.quantity} {u.unit}
                    </td>
                    <td className="px-5 py-2.5 tabular">₹{Number(u.billable_cost).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Wallet}
            title="No usage recorded yet"
            description="Usage appears once your receptionist starts handling calls. Nothing is estimated or simulated here."
          />
        )}
      </SectionCard>

      <SectionCard title="Payments" description="Plan changes and invoices.">
        <p className="text-sm text-muted-foreground">
          No payment provider is connected to this workspace yet, so plans cannot be changed from here. Your configuration and
          data remain available throughout your trial.
        </p>
      </SectionCard>
    </div>
  );
}
