import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft, Lock, Unlock, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { getCustomerDetail, setFeatureLock, adjustWallet } from "@/lib/admin.functions";
import { getProvisioningReadiness } from "@/lib/admin-clients.functions";
import { getProfitAnalytics } from "@/lib/admin-finance.functions";
import {
  PageHeader,
  SectionCard,
  StatCard,
  LoadingState,
  ErrorState,
  StatusPill,
  EmptyState,
} from "@/components/app/primitives";
import { PLATFORM_FEATURES } from "@/lib/features";
import { formatMoney } from "@/lib/pricing";
import { ACCOUNT_STATUS_LABEL, agentStatusLabel, type AccountStatus } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import { ClientLifecyclePanel } from "@/components/admin/ClientLifecyclePanel";
import { ClientAccessPanel } from "@/components/admin/ClientAccessPanel";
import { CustomerControlPanel } from "@/components/admin/CustomerControlPanel";
import { EntitlementsPanel } from "@/components/admin/EntitlementsPanel";
import { CrmPanel } from "@/components/admin/CrmPanel";
import { PricingOverridePanel } from "@/components/admin/PricingOverridePanel";
import type { LifecycleStatus } from "@/lib/lifecycle";
import type { ProvisioningCheckStatus } from "@/lib/provisioning-health.server";

/** Maps a Phase 1 readiness check's pass/warning/fail onto the HEALTHY/WARNING/BLOCKED vocabulary this page shows admins — same three states, no new health model. */
const HEALTH_LABEL: Record<
  ProvisioningCheckStatus,
  { label: string; tone: "live" | "ready" | "error" }
> = {
  pass: { label: "Healthy", tone: "live" },
  warning: { label: "Warning", tone: "ready" },
  fail: { label: "Blocked", tone: "error" },
};

export const Route = createFileRoute("/admin/customers/$orgId")({
  component: CustomerDetail,
});

function CustomerDetail() {
  const { orgId } = Route.useParams();
  const fetchDetail = useServerFn(getCustomerDetail);
  const fetchReadiness = useServerFn(getProvisioningReadiness);
  const fetchProfit = useServerFn(getProfitAnalytics);
  const saveLock = useServerFn(setFeatureLock);
  const saveWallet = useServerFn(adjustWallet);
  const queryClient = useQueryClient();

  const [lockTarget, setLockTarget] = useState<{
    feature: string;
    locked: boolean | null;
    label: string;
  } | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletAmount, setWalletAmount] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-customer", orgId],
    queryFn: () => fetchDetail({ data: { orgId } }),
  });

  const { data: readiness } = useQuery({
    queryKey: ["admin-customer-readiness", orgId],
    queryFn: () => fetchReadiness({ data: { orgId } }),
  });

  // getProfitAnalytics is the existing, platform-wide margin computation
  // (admin-finance.functions.ts) — reused as-is and filtered to this one
  // org rather than re-deriving revenue/provider-cost/margin here.
  const { data: profit } = useQuery({
    queryKey: ["admin-profit-analytics"],
    queryFn: () => fetchProfit(),
  });

  if (isLoading) return <LoadingState label="Loading customer" />;
  if (error || !data)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load this customer"}
        onRetry={() => void refetch()}
      />
    );

  const org = data.organization;
  const meta = ACCOUNT_STATUS_LABEL[org.account_status as AccountStatus];
  const lockMap = new Map(data.locks.map((l) => [l.feature, l.locked]));
  const financeRow = profit?.rows.find((r) => r.orgId === org.id) ?? null;
  const walletCredits = data.wallet.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const walletDebits = data.wallet.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  const walletCheck = readiness?.checks.find((c) => c.key === "wallet") ?? null;
  const lastActivity = data.calls[0]?.started_at ?? data.audit[0]?.created_at ?? null;
  const hasActivePhoneNumber = data.numbers.some((n) => n.status === "active");

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin-customer", orgId] });
    await queryClient.invalidateQueries({ queryKey: ["admin-customer-readiness", orgId] });
    await queryClient.invalidateQueries({ queryKey: ["admin-customers"] });
    await queryClient.invalidateQueries({ queryKey: ["admin-profit-analytics"] });
  };

  return (
    <div className="space-y-6">
      <Link
        to="/admin/customers"
        search={{ status: "all" }}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> All customers
      </Link>

      <PageHeader
        title={org.name}
        description={`${data.business?.business_type?.replace(/_/g, " ") ?? "No business configured"} · ${org.id}`}
        actions={
          <StatusPill tone={meta?.tone ?? "idle"}>{meta?.label ?? org.account_status}</StatusPill>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Customer" description="Contact and account identity.">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Customer ID</dt>
              <dd className="font-mono text-xs">{org.client_id ?? org.id}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Contact person</dt>
              <dd>{org.contact_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Contact email</dt>
              <dd className="truncate">{org.contact_email ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Contact phone</dt>
              <dd>{org.contact_phone ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Industry</dt>
              <dd>{org.industry ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Website</dt>
              <dd className="truncate">{org.website ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Timezone</dt>
              <dd>{org.timezone}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Currency</dt>
              <dd>{org.currency}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Created</dt>
              <dd>{new Date(org.created_at).toLocaleDateString()}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last activity</dt>
              <dd>{lastActivity ? new Date(lastActivity).toLocaleString() : "No activity yet"}</dd>
            </div>
          </dl>
        </SectionCard>

        <SectionCard
          title="Health"
          description="Every row below reflects a real check that just ran — never a fabricated status."
          actions={
            readiness ? (
              <StatusPill
                tone={
                  readiness.overall === "healthy"
                    ? "live"
                    : readiness.overall === "warning"
                      ? "ready"
                      : "error"
                }
              >
                {readiness.overall}
              </StatusPill>
            ) : null
          }
        >
          {readiness ? (
            <ul className="divide-y divide-border">
              {readiness.checks.map((check) => (
                <li
                  key={check.key}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <div>
                    <p className="font-medium">{check.label}</p>
                    <p className="text-xs text-muted-foreground">{check.detail}</p>
                  </div>
                  <StatusPill tone={HEALTH_LABEL[check.status].tone}>
                    {HEALTH_LABEL[check.status].label}
                  </StatusPill>
                </li>
              ))}
            </ul>
          ) : (
            <LoadingState label="Running health checks" />
          )}
        </SectionCard>
      </div>

      <ClientLifecyclePanel
        orgId={org.id}
        clientId={(org as { client_id?: string }).client_id ?? org.id.slice(0, 8)}
        name={org.name}
        current={
          ((org as { lifecycle_status?: string }).lifecycle_status ?? "lead") as LifecycleStatus
        }
        onChanged={invalidate}
      />

      <ClientAccessPanel
        orgId={org.id}
        defaultEmail={(org as { contact_email?: string | null }).contact_email ?? null}
      />

      <CustomerControlPanel
        orgId={org.id}
        lifecycle={
          ((org as { lifecycle_status?: string }).lifecycle_status ??
            "not_provisioned") as LifecycleStatus
        }
        paymentOverride={Boolean((org as { payment_override?: boolean }).payment_override)}
        readiness={readiness ?? null}
        onChanged={invalidate}
      />

      <EntitlementsPanel
        orgId={org.id}
        entitlements={data.entitlements ?? []}
        onChanged={invalidate}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Agent" description="Voice agent configuration and publish state.">
          {data.agent ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Agent name</dt>
                <dd>{data.agent.agent_name ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Status</dt>
                <dd>
                  {(() => {
                    const s = agentStatusLabel(data.agent, hasActivePhoneNumber);
                    return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
                  })()}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Active version</dt>
                <dd>{data.agent.active_version || "Not published"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Last publish</dt>
                <dd>
                  {data.lastPublish
                    ? `v${data.lastPublish.version} · ${new Date(data.lastPublish.created_at).toLocaleString()}`
                    : "Never published"}
                </dd>
                {data.lastPublish?.change_note ? (
                  <dd className="mt-0.5 text-xs text-muted-foreground">
                    {data.lastPublish.change_note}
                  </dd>
                ) : null}
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Sarvam app ID</dt>
                <dd className="font-mono text-xs">{data.agent.sarvam_app_id ?? "Not mapped"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Sarvam app version</dt>
                <dd>{data.agent.sarvam_app_version ?? "—"}</dd>
              </div>
            </dl>
          ) : (
            <EmptyState
              title="No agent configured"
              description="This customer has not set up an agent yet."
            />
          )}
        </SectionCard>

        <SectionCard
          title="Phone"
          description="Assigned numbers and provider mapping (admin-only fields shown)."
        >
          {data.numbers.length ? (
            <ul className="divide-y divide-border">
              {data.numbers.map((n) => (
                <li key={n.id} className="space-y-1.5 py-2.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono">{n.display_number ?? n.e164}</span>
                    <StatusPill
                      tone={
                        n.status === "active" ? "live" : n.status === "suspended" ? "error" : "idle"
                      }
                    >
                      {n.status}
                    </StatusPill>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {n.provider}
                    {n.provider_number_id ? ` · ${n.provider_number_id}` : ""}
                    {n.provider_deployment_id ? ` · deployment ${n.provider_deployment_id}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Inbound {n.inbound_enabled ? "on" : "off"} · Outbound{" "}
                    {n.outbound_enabled ? "on" : "off"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No phone number"
              description="No number has been assigned to this customer yet."
            />
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Wallet">
          <div className="space-y-2 text-sm">
            <StatCard label="Balance" value={formatMoney(data.walletBalance)} tone="accent" />
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Credits" value={formatMoney(walletCredits)} />
              <StatCard label="Debits" value={formatMoney(Math.abs(walletDebits))} />
            </div>
            {walletCheck && walletCheck.status !== "pass" ? (
              <p className="text-xs text-warning">{walletCheck.detail}</p>
            ) : null}
          </div>
        </SectionCard>

        <SectionCard title="Usage">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <StatCard label="Calls today" value={data.usage.callsToday} />
            <StatCard label="Calls this month" value={data.usage.callsThisMonth} />
            <StatCard label="Minutes today" value={data.usage.minutesToday} />
            <StatCard label="Minutes this month" value={data.usage.minutesThisMonth} />
          </div>
        </SectionCard>

        <SectionCard title="Finance" description="Provider cost and margin — admin-only.">
          {financeRow ? (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <StatCard label="Revenue" value={formatMoney(financeRow.revenue)} tone="accent" />
              <StatCard label="Provider cost" value={formatMoney(financeRow.providerCost)} />
              <StatCard label="Gross profit" value={formatMoney(financeRow.grossProfit)} />
              <StatCard
                label="Margin"
                value={financeRow.marginPct === null ? "—" : `${financeRow.marginPct.toFixed(1)}%`}
              />
            </div>
          ) : (
            <LoadingState label="Loading finance" />
          )}
        </SectionCard>
      </div>

      <SectionCard title="Recent calls" description="The latest handled calls, admin view.">
        {data.calls.length ? (
          <ul className="divide-y divide-border">
            {data.calls.slice(0, 5).map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div>
                  <p className="capitalize">
                    {c.direction} · {c.caller_number ?? "—"} → {c.destination_number ?? "—"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {c.outcome ?? c.status}
                    {c.failure_reason ? ` · ${c.failure_reason}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="tabular text-xs text-muted-foreground">
                    {new Date(c.started_at).toLocaleString()}
                  </p>
                  <p className="tabular text-xs">
                    {Math.round((c.duration_seconds ?? 0) / 60)} min
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No calls yet"
            description="Calls appear once the receptionist starts handling traffic."
          />
        )}
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Wallet balance" value={formatMoney(data.walletBalance)} tone="accent" />
        <StatCard
          label="Payments"
          value={data.payments.filter((p) => p.status === "captured").length}
        />
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
              <li
                key={feature.key}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="text-sm font-medium">{feature.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {feature.description}
                    {override === undefined ? " · using platform default" : " · customer override"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={effective ? "error" : "live"}>
                    {effective ? "Locked" : "Unlocked"}
                  </StatusPill>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setLockTarget({
                        feature: feature.key,
                        locked: !effective,
                        label: feature.label,
                      })
                    }
                  >
                    {effective ? (
                      <Unlock className="mr-1.5 size-3.5" />
                    ) : (
                      <Lock className="mr-1.5 size-3.5" />
                    )}
                    {effective ? "Unlock" : "Lock"}
                  </Button>
                  {override !== undefined ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setLockTarget({ feature: feature.key, locked: null, label: feature.label })
                      }
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

      <Tabs defaultValue="wallet">
        <TabsList>
          <TabsTrigger value="wallet">Wallet</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="calls">Calls</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="crm">CRM</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
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
                  <li
                    key={tx.id}
                    className="flex items-center justify-between gap-3 py-2.5 text-sm"
                  >
                    <div>
                      <p className="capitalize">{tx.kind.replace(/_/g, " ")}</p>
                      <p className="text-xs text-muted-foreground">{tx.description ?? "—"}</p>
                    </div>
                    <span className="text-xs text-muted-foreground tabular">
                      {new Date(tx.created_at).toLocaleString()}
                    </span>
                    <span
                      className={`tabular font-medium ${tx.amount < 0 ? "text-destructive" : "text-success"}`}
                    >
                      {tx.amount < 0 ? "-" : "+"}
                      {formatMoney(Math.abs(tx.amount), tx.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No wallet activity"
                description="Credits, debits and usage charges will appear here."
              />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="payments" className="mt-4">
          <SectionCard
            title="Payments"
            description="Confirmed server-side by the payment provider webhook."
          >
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
              <EmptyState
                title="No payments"
                description="This customer has not completed any payment yet."
              />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="invoices" className="mt-4">
          <SectionCard
            title="Invoices"
            description="Issued automatically for each confirmed payment."
          >
            {data.invoices.length ? (
              <ul className="divide-y divide-border">
                {data.invoices.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between gap-3 py-2.5 text-sm"
                  >
                    <span className="font-mono text-xs">{inv.number}</span>
                    <span className="text-xs text-muted-foreground">{inv.status}</span>
                    <span className="tabular">{formatMoney(inv.amount, inv.currency)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No invoices"
                description="Invoices are generated when a payment is confirmed."
              />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="calls" className="mt-4">
          <SectionCard
            title="Recent calls"
            description="The latest calls handled for this customer."
          >
            {data.calls.length ? (
              <ul className="divide-y divide-border">
                {data.calls.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="capitalize">{c.direction}</span>
                    <span className="text-xs text-muted-foreground">{c.status}</span>
                    <span className="tabular text-xs">
                      {Math.round((c.duration_seconds ?? 0) / 60)} min
                    </span>
                    <span className="text-xs text-muted-foreground tabular">
                      {new Date(c.started_at).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No calls yet"
                description="Calls appear once the receptionist starts handling traffic."
              />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="team" className="mt-4">
          <SectionCard
            title="Organization members"
            description="Customer-side roles only — these never grant platform admin access."
          >
            <ul className="divide-y divide-border">
              {data.members.map((m) => (
                <li
                  key={m.user_id}
                  className="flex items-center justify-between gap-3 py-2.5 text-sm"
                >
                  <span>{m.profile?.full_name ?? m.profile?.email ?? m.user_id}</span>
                  <span className="text-xs text-muted-foreground">{m.profile?.email}</span>
                  <StatusPill tone="idle">{m.role}</StatusPill>
                </li>
              ))}
            </ul>
          </SectionCard>
        </TabsContent>

        <TabsContent value="crm" className="mt-4">
          <CrmPanel
            orgId={org.id}
            stage={(org as { crm_stage?: string }).crm_stage ?? "new"}
            followUpAt={(org as { follow_up_at?: string | null }).follow_up_at ?? null}
            onChanged={invalidate}
          />
        </TabsContent>

        <TabsContent value="pricing" className="mt-4">
          <PricingOverridePanel orgId={org.id} />
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <SectionCard
            title="Audit history"
            description="Privileged actions taken on this customer."
          >
            {data.audit.length ? (
              <ul className="divide-y divide-border">
                {data.audit.map((a) => (
                  <li key={a.id} className="py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{a.action}</span>
                      <span className="text-xs text-muted-foreground tabular">
                        {new Date(a.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {a.admin_email ?? "system"} · {a.reason ?? "no reason recorded"}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No admin actions yet"
                description="Every privileged change will be recorded here."
              />
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
          await saveLock({
            data: { orgId, feature: lockTarget!.feature, locked: lockTarget!.locked, reason },
          });
          toast.success("Access updated");
          setLockTarget(null);
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
          await saveWallet({
            data: { orgId, amount: Math.round(rupees * 100), kind: "manual_adjustment", reason },
          });
          toast.success("Wallet updated");
          setWalletAmount("");
          await invalidate();
        }}
      />
    </div>
  );
}
