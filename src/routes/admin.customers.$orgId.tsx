import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft, Lock, Unlock, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { getCustomerDetail, setFeatureLock, setAccountStatus, adjustWallet } from "@/lib/admin.functions";
import { PageHeader, SectionCard, StatCard, LoadingState, ErrorState, StatusPill, EmptyState } from "@/components/app/primitives";
import { PLATFORM_FEATURES } from "@/lib/features";
import { formatMoney } from "@/lib/pricing";
import { ACCOUNT_STATUS_LABEL, type AccountStatus } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import type { Database } from "@/integrations/supabase/types";

type Status = Database["public"]["Enums"]["account_status"];

export const Route = createFileRoute("/admin/customers/$orgId")({
  component: CustomerDetail,
});

function CustomerDetail() {
  const { orgId } = Route.useParams();
  const fetchDetail = useServerFn(getCustomerDetail);
  const saveLock = useServerFn(setFeatureLock);
  const saveStatus = useServerFn(setAccountStatus);
  const saveWallet = useServerFn(adjustWallet);
  const queryClient = useQueryClient();

  const [lockTarget, setLockTarget] = useState<{ feature: string; locked: boolean | null; label: string } | null>(null);
  const [statusTarget, setStatusTarget] = useState<Status | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletAmount, setWalletAmount] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-customer", orgId],
    queryFn: () => fetchDetail({ data: { orgId } }),
  });

  if (isLoading) return <LoadingState label="Loading customer" />;
  if (error || !data)
    return <ErrorState message={error instanceof Error ? error.message : "Could not load this customer"} onRetry={() => void refetch()} />;

  const org = data.organization;
  const meta = ACCOUNT_STATUS_LABEL[org.account_status as AccountStatus];
  const lockMap = new Map(data.locks.map((l) => [l.feature, l.locked]));

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin-customer", orgId] });
    await queryClient.invalidateQueries({ queryKey: ["admin-customers"] });
  };

  return (
    <div className="space-y-6">
      <Link to="/admin/customers" search={{ status: "all" }} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> All customers
      </Link>

      <PageHeader
        title={org.name}
        description={`${data.business?.business_type?.replace(/_/g, " ") ?? "No business configured"} · ${org.id}`}
        actions={<StatusPill tone={meta?.tone ?? "idle"}>{meta?.label ?? org.account_status}</StatusPill>}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Wallet balance" value={formatMoney(data.walletBalance)} tone="accent" />
        <StatCard label="Payments" value={data.payments.filter((p) => p.status === "captured").length} />
        <StatCard label="Calls (recent)" value={data.calls.length} />
        <StatCard label="Numbers" value={data.numbers.length} />
      </div>

      <SectionCard
        title="Feature access"
        description="Locked features require payment. Unlocked features are free for this customer, overriding the platform default."
      >
        <ul className="divide-y divide-border">
          {PLATFORM_FEATURES.map((feature) => {
            const override = lockMap.get(feature.key);
            const effective = override ?? true;
            return (
              <li key={feature.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">{feature.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {feature.description}
                    {override === undefined ? " · using platform default" : " · customer override"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={effective ? "error" : "live"}>{effective ? "Locked" : "Unlocked"}</StatusPill>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setLockTarget({ feature: feature.key, locked: !effective, label: feature.label })}
                  >
                    {effective ? <Unlock className="mr-1.5 size-3.5" /> : <Lock className="mr-1.5 size-3.5" />}
                    {effective ? "Unlock" : "Lock"}
                  </Button>
                  {override !== undefined ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setLockTarget({ feature: feature.key, locked: null, label: feature.label })}
                    >
                      <RotateCcw className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard title="Account status" description="Suspending an account stops dashboard and service access immediately.">
        <div className="flex flex-wrap gap-2">
          {(["payment_required", "setup_in_progress", "active", "suspended", "cancelled"] as Status[]).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={org.account_status === s ? "default" : "outline"}
              disabled={org.account_status === s}
              onClick={() => setStatusTarget(s)}
            >
              {ACCOUNT_STATUS_LABEL[s as AccountStatus]?.label ?? s}
            </Button>
          ))}
        </div>
      </SectionCard>

      <Tabs defaultValue="wallet">
        <TabsList>
          <TabsTrigger value="wallet">Wallet</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="calls">Calls</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="wallet" className="mt-4">
          <SectionCard
            title="Wallet ledger"
            description="Immutable transactions. Balance is the sum of every entry — records are never edited."
            actions={
              <Button size="sm" onClick={() => setWalletOpen(true)}>
                Add adjustment
              </Button>
            }
          >
            {data.wallet.length ? (
              <ul className="divide-y divide-border">
                {data.wallet.map((tx) => (
                  <li key={tx.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div>
                      <p className="capitalize">{tx.kind.replace(/_/g, " ")}</p>
                      <p className="text-xs text-muted-foreground">{tx.description ?? "—"}</p>
                    </div>
                    <span className="text-xs text-muted-foreground tabular">{new Date(tx.created_at).toLocaleString()}</span>
                    <span className={`tabular font-medium ${tx.amount < 0 ? "text-destructive" : "text-success"}`}>
                      {tx.amount < 0 ? "-" : "+"}
                      {formatMoney(Math.abs(tx.amount), tx.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No wallet activity" description="Credits, debits and usage charges will appear here." />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="payments" className="mt-4">
          <SectionCard title="Payments" description="Confirmed server-side by the payment provider webhook.">
            {data.payments.length ? (
              <ul className="divide-y divide-border">
                {data.payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="capitalize">{p.purpose.replace(/_/g, " ")}</span>
                    <span className="text-xs text-muted-foreground">{p.status}</span>
                    <span className="text-xs text-muted-foreground tabular">
                      {new Date(p.captured_at ?? p.created_at).toLocaleString()}
                    </span>
                    <span className="tabular font-medium">{formatMoney(p.amount, p.currency)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No payments" description="This customer has not completed any payment yet." />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="invoices" className="mt-4">
          <SectionCard title="Invoices" description="Issued automatically for each confirmed payment.">
            {data.invoices.length ? (
              <ul className="divide-y divide-border">
                {data.invoices.map((inv) => (
                  <li key={inv.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="font-mono text-xs">{inv.number}</span>
                    <span className="text-xs text-muted-foreground">{inv.status}</span>
                    <span className="tabular">{formatMoney(inv.amount, inv.currency)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No invoices" description="Invoices are generated when a payment is confirmed." />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="calls" className="mt-4">
          <SectionCard title="Recent calls" description="The latest calls handled for this customer.">
            {data.calls.length ? (
              <ul className="divide-y divide-border">
                {data.calls.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="capitalize">{c.direction}</span>
                    <span className="text-xs text-muted-foreground">{c.status}</span>
                    <span className="tabular text-xs">{Math.round((c.duration_seconds ?? 0) / 60)} min</span>
                    <span className="text-xs text-muted-foreground tabular">{new Date(c.started_at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No calls yet" description="Calls appear once the receptionist starts handling traffic." />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="team" className="mt-4">
          <SectionCard title="Organization members" description="Customer-side roles only — these never grant platform admin access.">
            <ul className="divide-y divide-border">
              {data.members.map((m) => (
                <li key={m.user_id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span>{m.profile?.full_name ?? m.profile?.email ?? m.user_id}</span>
                  <span className="text-xs text-muted-foreground">{m.profile?.email}</span>
                  <StatusPill tone="idle">{m.role}</StatusPill>
                </li>
              ))}
            </ul>
          </SectionCard>
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <SectionCard title="Audit history" description="Privileged actions taken on this customer.">
            {data.audit.length ? (
              <ul className="divide-y divide-border">
                {data.audit.map((a) => (
                  <li key={a.id} className="py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{a.action}</span>
                      <span className="text-xs text-muted-foreground tabular">{new Date(a.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {a.admin_email ?? "system"} · {a.reason ?? "no reason recorded"}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No admin actions yet" description="Every privileged change will be recorded here." />
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>

      <ReasonDialog
        open={lockTarget !== null}
        onOpenChange={(open) => !open && setLockTarget(null)}
        title={
          lockTarget?.locked === null
            ? `Clear override for ${lockTarget?.label}?`
            : lockTarget?.locked
              ? `Lock ${lockTarget?.label}?`
              : `Unlock ${lockTarget?.label}?`
        }
        description={
          lockTarget?.locked === null
            ? "This feature will follow the platform default again."
            : lockTarget?.locked
              ? "The customer must pay before using this feature. Enforced server-side."
              : "The customer gets free access to this feature, even while payment enforcement is on."
        }
        onConfirm={async (reason) => {
          await saveLock({ data: { orgId, feature: lockTarget!.feature, locked: lockTarget!.locked, reason } });
          toast.success("Access updated");
          setLockTarget(null);
          await invalidate();
        }}
      />

      <ReasonDialog
        open={statusTarget !== null}
        onOpenChange={(open) => !open && setStatusTarget(null)}
        title={`Set account status to ${statusTarget ?? ""}?`}
        description="This changes what the customer can reach immediately, enforced on the server."
        onConfirm={async (reason) => {
          await saveStatus({ data: { orgId, status: statusTarget!, reason } });
          toast.success("Account status updated");
          setStatusTarget(null);
          await invalidate();
        }}
      />

      <ReasonDialog
        open={walletOpen}
        onOpenChange={setWalletOpen}
        title="Wallet adjustment"
        description="Positive credits, negative debits. Amount in rupees. This writes a new immutable ledger entry."
        confirmLabel="Post transaction"
        extra={
          <Input
            placeholder="Amount in ₹ (e.g. 500 or -250)"
            value={walletAmount}
            onChange={(e) => setWalletAmount(e.target.value)}
          />
        }
        onConfirm={async (reason) => {
          const rupees = Number(walletAmount);
          if (!Number.isFinite(rupees) || rupees === 0) throw new Error("Enter a non-zero amount");
          await saveWallet({ data: { orgId, amount: Math.round(rupees * 100), kind: "manual_adjustment", reason } });
          toast.success("Wallet updated");
          setWalletAmount("");
          await invalidate();
        }}
      />
    </div>
  );
}
