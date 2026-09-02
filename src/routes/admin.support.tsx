import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ShieldAlert, LogOut } from "lucide-react";
import { toast } from "sonner";
import { getSupportSessionView, endSupportSession } from "@/lib/admin-clients.functions";
import { PageHeader, SectionCard, StatCard, LoadingState, ErrorState, EmptyState, StatusPill } from "@/components/app/primitives";
import { formatMoney } from "@/lib/pricing";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/admin/support")({
  component: SupportSessionView,
});

interface StoredSession {
  id: string;
  token: string;
}

function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem("vaani.support");
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

/**
 * Read-only admin support session. The data is fetched server-side after the
 * session token, expiry and platform-admin role are re-verified; the admin
 * never receives customer credentials and cannot write through this view.
 */
function SupportSessionView() {
  const navigate = useNavigate();
  const [stored, setStored] = useState<StoredSession | null>(null);
  const fetchView = useServerFn(getSupportSessionView);
  const endSession = useServerFn(endSupportSession);

  useEffect(() => {
    setStored(readSession());
  }, []);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["support-session", stored?.id],
    enabled: Boolean(stored),
    refetchInterval: 60_000,
    queryFn: () => fetchView({ data: { sessionId: stored!.id, token: stored!.token } }),
  });

  if (!stored) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="No active support session"
        description="Start one from a customer's detail page — sessions are short-lived and fully audited."
      />
    );
  }

  if (isLoading) return <LoadingState label="Opening support session" />;
  if (error || !data)
    return <ErrorState message={error instanceof Error ? error.message : "Session unavailable"} onRetry={() => void refetch()} />;

  const org = data.organization;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
        <p className="text-sm">
          <span className="font-semibold">ADMIN SUPPORT SESSION</span> — read-only view of{" "}
          <span className="font-medium">{org?.name}</span>. Expires{" "}
          {new Date(data.session.expiresAt).toLocaleTimeString()}.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              await endSession({ data: { sessionId: stored.id } });
            } finally {
              sessionStorage.removeItem("vaani.support");
              toast.success("Support session ended");
              navigate({ to: "/admin/customers/$orgId", params: { orgId: org!.id } });
            }
          }}
        >
          <LogOut className="mr-1.5 size-3.5" /> End session
        </Button>
      </div>

      <PageHeader
        title={org?.name ?? "Customer workspace"}
        description={`${org?.client_id ?? ""} · viewing as platform support`}
        actions={<StatusPill tone="idle">{org?.account_status}</StatusPill>}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Wallet balance" value={formatMoney(data.walletBalance)} tone="accent" />
        <StatCard label="Numbers" value={data.numbers.length} />
        <StatCard label="Recent calls" value={data.calls.length} />
        <StatCard label="Recent leads" value={data.leads.length} />
      </div>

      <SectionCard title="Business profile" description="What the customer has configured.">
        {data.business ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Business</dt>
              <dd>{data.business.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Type</dt>
              <dd className="capitalize">{data.business.business_type?.replace(/_/g, " ")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Phone</dt>
              <dd>{data.business.primary_phone ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Timezone</dt>
              <dd>{data.business.timezone}</dd>
            </div>
          </dl>
        ) : (
          <EmptyState title="No business configured" description="The customer has not completed onboarding yet." />
        )}
      </SectionCard>

      <SectionCard title="Recent calls">
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
          <EmptyState title="No calls yet" description="Nothing has been handled for this customer." />
        )}
      </SectionCard>
    </div>
  );
}
