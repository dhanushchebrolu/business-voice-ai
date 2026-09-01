import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { getAdminOverview, updatePlatformSetting } from "@/lib/admin.functions";
import { PageHeader, SectionCard, StatCard, LoadingState, ErrorState, StatusPill } from "@/components/app/primitives";
import { formatMoney } from "@/lib/pricing";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/admin/")({
  component: AdminOverview,
});

function AdminOverview() {
  const fetchOverview = useServerFn(getAdminOverview);
  const saveSetting = useServerFn(updatePlatformSetting);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => fetchOverview(),
  });

  if (isLoading) return <LoadingState label="Loading platform metrics" />;
  if (error || !data)
    return <ErrorState message={error instanceof Error ? error.message : "Could not load metrics"} onRetry={() => void refetch()} />;

  const enforcement = data.paymentEnforcement;

  const toggle = async () => {
    if (!reason.trim()) {
      toast.error("A reason is required");
      return;
    }
    setSaving(true);
    try {
      await saveSetting({ data: { key: "billing.payment_required", value: { enabled: !enforcement }, reason } });
      toast.success(enforcement ? "Payment enforcement disabled" : "Payment enforcement enabled");
      setConfirming(false);
      setReason("");
      await queryClient.invalidateQueries();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the setting");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Platform overview" description="Live operational state across every customer organization." />

      <SectionCard
        title="Payment enforcement"
        description="Global switch. When off, every customer uses the product without paying — enforced server-side, no redeploy."
        actions={<StatusPill tone={enforcement ? "live" : "idle"}>{enforcement ? "Enabled" : "Disabled"}</StatusPill>}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm text-muted-foreground">
            {enforcement
              ? "Customers who have not satisfied the configured payment requirements are locked out of the features you have marked as paid."
              : "All lock rules are bypassed. Every customer has free access to every feature until you re-enable enforcement."}
          </p>
          <Button variant={enforcement ? "outline" : "default"} onClick={() => setConfirming(true)}>
            {enforcement ? "Disable payments" : "Enable payments"}
          </Button>
        </div>
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <button className="text-left" onClick={() => navigate({ to: "/admin/customers", search: { status: "all" } })}>
          <StatCard label="Customers" value={data.customers.total} />
        </button>
        <button className="text-left" onClick={() => navigate({ to: "/admin/customers", search: { status: "active" } })}>
          <StatCard label="Active" value={data.customers.active} tone="accent" />
        </button>
        <button className="text-left" onClick={() => navigate({ to: "/admin/customers", search: { status: "payment_required" } })}>
          <StatCard label="Payment required" value={data.customers.paymentRequired} />
        </button>
        <button className="text-left" onClick={() => navigate({ to: "/admin/customers", search: { status: "suspended" } })}>
          <StatCard label="Suspended" value={data.customers.suspended} />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Revenue today" value={formatMoney(data.revenue.today)} />
        <StatCard label="Revenue this month" value={formatMoney(data.revenue.month)} tone="accent" />
        <StatCard label="Revenue all time" value={formatMoney(data.revenue.allTime)} />
        <StatCard label="Failed payments" value={data.revenue.failed} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Calls today" value={data.callsToday.total} hint={`${data.callsToday.inbound} in · ${data.callsToday.outbound} out`} />
        <StatCard label="Minutes today" value={data.callsToday.minutes} />
        <StatCard label="Phone numbers" value={data.numbers.total} hint={`${data.numbers.assigned} active`} />
        <StatCard label="AI agents" value={data.agents.total} hint={`${data.agents.live} live`} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Wallet balances" value={formatMoney(data.wallets.totalBalance)} />
        <StatCard label="Negative wallets" value={data.wallets.negative} />
        <StatCard label="Setup in progress" value={data.customers.setupInProgress} />
        <StatCard label="Enforcement" value={enforcement ? "On" : "Off"} />
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{enforcement ? "Disable payment enforcement?" : "Enable payment enforcement?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {enforcement
                ? "Every customer will get free access to all features immediately, regardless of payment state."
                : "All customers who do not satisfy the configured payment requirements may be restricted immediately."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input placeholder="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(e) => {
                e.preventDefault();
                void toggle();
              }}
            >
              {saving ? "Saving…" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
