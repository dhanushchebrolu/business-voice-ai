import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Wallet, Receipt } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, usageQuery, callsQuery, paymentsQuery, invoicesQuery } from "@/lib/workspace";
import { pricingQuery, formatMoney } from "@/lib/pricing";
import { PageHeader, SectionCard, StatCard, EmptyState } from "@/components/app/primitives";
import { AccountStatusPanel } from "@/components/app/AccountStatusPanel";

export const Route = createFileRoute("/app/billing")({
  head: () => ({
    meta: [
      { title: "Usage & billing — Vaani" },
      { name: "description", content: "Track call minutes, usage costs, payments and invoices for your workspace." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: BillingPage,
});

const RATE_KEYS = [
  "pricing.monthly_plan",
  "pricing.phone_service_fee",
  "pricing.voice_minute",
  "pricing.outbound_call",
  "pricing.whatsapp_message",
] as const;

function BillingPage() {
  const { user } = useAuth();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const orgId = ws?.organization?.id;
  const { data: usage } = useQuery(usageQuery(orgId));
  const { data: calls } = useQuery(callsQuery(orgId));
  const { data: payments } = useQuery(paymentsQuery(orgId));
  const { data: invoices } = useQuery(invoicesQuery(orgId));
  const { data: pricing } = useQuery(pricingQuery());

  const minutes = Math.round((calls ?? []).reduce((s, c) => s + (c.duration_seconds ?? 0), 0) / 60);
  const cost = (usage ?? []).reduce((s, u) => s + Number(u.billable_cost ?? 0), 0);
  const paid = (payments ?? []).filter((p) => p.status === "captured").reduce((s, p) => s + p.amount, 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Usage & billing" description="Your account state, what you have paid, and metered usage from real calls." />

      <AccountStatusPanel />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Calls" value={calls?.length ?? 0} />
        <StatCard label="Minutes used" value={minutes} />
        <StatCard label="Usage cost" value={`₹${cost.toFixed(2)}`} />
        <StatCard label="Total paid" value={formatMoney(paid)} tone="accent" />
      </div>

      <SectionCard title="Your rates" description="Prices applied to your workspace.">
        <ul className="divide-y divide-border">
          {RATE_KEYS.map((key) => {
            const price = pricing?.[key];
            if (!price) return null;
            return (
              <li key={key} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span>{price.label}</span>
                <span className="tabular font-medium">{formatMoney(price.amount, price.currency)}</span>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard title="Payments" description="Every payment confirmed by our payment provider.">
        {payments?.length ? (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">For</th>
                  <th className="px-3 py-2 font-medium">Method</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-5 py-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b border-border/60">
                    <td className="px-5 py-2.5 text-xs text-muted-foreground tabular">
                      {new Date(p.captured_at ?? p.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5">{p.purpose.replace(/_/g, " ")}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{p.method ?? "—"}</td>
                    <td className="px-3 py-2.5">{p.status}</td>
                    <td className="px-5 py-2.5 tabular">{formatMoney(p.amount, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Wallet}
            title="No payments yet"
            description="Payments appear here immediately after our payment provider confirms them server-side."
          />
        )}
      </SectionCard>

      <SectionCard title="Invoices" description="Issued automatically for each confirmed payment.">
        {invoices?.length ? (
          <ul className="divide-y divide-border">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="font-mono text-xs">{inv.number}</span>
                <span className="text-xs text-muted-foreground tabular">{new Date(inv.issued_at).toLocaleDateString()}</span>
                <span className="tabular font-medium">{formatMoney(inv.amount, inv.currency)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={Receipt} title="No invoices yet" description="An invoice is generated for every confirmed payment." />
        )}
      </SectionCard>

      <SectionCard title="Usage records" description="Each metered event recorded against your workspace.">
        {usage?.length ? (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Quantity</th>
                  <th className="px-5 py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={u.id} className="border-b border-border/60">
                    <td className="px-5 py-2.5 text-xs text-muted-foreground tabular">{new Date(u.occurred_at).toLocaleString()}</td>
                    <td className="px-3 py-2.5">{u.kind}</td>
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
    </div>
  );
}
