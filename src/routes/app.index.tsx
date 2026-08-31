import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PhoneCall, Users, Bot, Hash, ArrowUpRight } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, callsQuery, leadsQuery, numbersQuery, agentStatusLabel } from "@/lib/workspace";
import { PageHeader, StatCard, SectionCard, EmptyState, StatusPill, LoadingState } from "@/components/app/primitives";
import { getBusinessType } from "@/lib/business-types";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Overview — Vaani" },
      { name: "description", content: "Call volume, leads and receptionist status at a glance." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Overview,
});

function Overview() {
  const { user } = useAuth();
  const { data: ws, isLoading } = useQuery(workspaceQuery(user?.id));
  const orgId = ws?.organization?.id;
  const { data: calls } = useQuery(callsQuery(orgId));
  const { data: leads } = useQuery(leadsQuery(orgId));
  const { data: numbers } = useQuery(numbersQuery(orgId));

  if (isLoading) return <LoadingState label="Loading overview" />;

  const type = getBusinessType(ws?.business?.business_type);
  const activeNumber = numbers?.find((n) => n.status === "active");
  const status = agentStatusLabel(ws?.agent ?? null, Boolean(activeNumber));
  const totalMinutes = Math.round((calls ?? []).reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0) / 60);
  const trialEnds = ws?.subscription?.trial_ends_at ? new Date(ws.subscription.trial_ends_at) : null;
  const trialDays = trialEnds ? Math.max(0, Math.ceil((trialEnds.getTime() - Date.now()) / 86400000)) : null;

  const setupSteps = [
    { done: Boolean(ws?.business?.description), label: "Describe your business", to: "/app/business" },
    { done: (ws?.agent?.active_version ?? 0) > 0, label: "Publish your receptionist", to: "/app/agent" },
    { done: Boolean(activeNumber), label: "Connect a phone number", to: "/app/numbers" },
  ];
  const pending = setupSteps.filter((s) => !s.done);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Good to see you${ws?.business ? `, ${ws.business.name}` : ""}`}
        description={`Your ${type.label.toLowerCase()} receptionist, its call activity and the ${type.customerLabel.toLowerCase()} it captured.`}
        actions={
          <>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
            <Link to="/app/agent">
              <Button size="sm">Open receptionist</Button>
            </Link>
          </>
        }
      />

      <AccountStatusPanel />


      {pending.length ? (
        <SectionCard title="Finish your setup" description="Three steps stand between you and answered calls.">
          <ol className="space-y-2.5">
            {setupSteps.map((step, i) => (
              <li key={step.label} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
                <span className="flex items-center gap-3 text-sm">
                  <span
                    className={`grid size-5 place-items-center rounded-full text-[11px] font-semibold ${
                      step.done ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {step.done ? "✓" : i + 1}
                  </span>
                  <span className={step.done ? "text-muted-foreground line-through" : ""}>{step.label}</span>
                </span>
                {!step.done ? (
                  <Link to={step.to}>
                    <Button size="sm" variant="ghost">
                      Go <ArrowUpRight className="ml-1 size-3.5" />
                    </Button>
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        </SectionCard>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Calls answered" value={calls?.length ?? 0} hint="All time" />
        <StatCard label="Talk minutes" value={totalMinutes} hint="Billed per minute" />
        <StatCard label={type.customerLabel + " captured"} value={leads?.length ?? 0} tone="accent" />
        <StatCard label="Live numbers" value={numbers?.filter((n) => n.status === "active").length ?? 0} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Recent calls"
          description="Every answered call, with transcript and outcome."
          actions={
            <Link to="/app/calls">
              <Button size="sm" variant="ghost">
                View all
              </Button>
            </Link>
          }
        >
          {calls?.length ? (
            <ul className="divide-y divide-border">
              {calls.slice(0, 6).map((call) => (
                <li key={call.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="truncate">
                    <span className="font-medium">{call.caller_number ?? "Unknown caller"}</span>
                    <span className="ml-2 text-muted-foreground">{call.summary ?? call.outcome ?? "No summary"}</span>
                  </span>
                  <span className="shrink-0 tabular text-xs text-muted-foreground">
                    {Math.round((call.duration_seconds ?? 0) / 60)}m
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={PhoneCall}
              title="No calls yet"
              description="Once a phone number is connected and your receptionist is published, calls will appear here in real time."
              action={
                <Link to="/app/numbers">
                  <Button size="sm" variant="secondary">
                    <Hash className="mr-1.5 size-3.5" /> Connect a number
                  </Button>
                </Link>
              }
            />
          )}
        </SectionCard>

        <SectionCard
          title={`Recent ${type.customerLabel.toLowerCase()}`}
          description="Details the receptionist collected from callers."
          actions={
            <Link to="/app/leads">
              <Button size="sm" variant="ghost">
                View all
              </Button>
            </Link>
          }
        >
          {leads?.length ? (
            <ul className="divide-y divide-border">
              {leads.slice(0, 6).map((lead) => (
                <li key={lead.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="truncate">
                    <span className="font-medium">{lead.name ?? "Unnamed"}</span>
                    <span className="ml-2 text-muted-foreground">{lead.phone ?? lead.email ?? "No contact"}</span>
                  </span>
                  <StatusPill tone={lead.score === "hot" ? "accent" : "idle"} dot={false}>
                    {lead.score}
                  </StatusPill>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={Users}
              title="No captured contacts yet"
              description="When a caller shares their name, number or interest, the receptionist saves it here automatically."
            />
          )}
        </SectionCard>
      </div>

      {!ws?.agent ? (
        <EmptyState
          icon={Bot}
          title="Your receptionist isn't configured"
          description="Add your business information and publish a version to generate the agent's instructions."
          action={
            <Link to="/app/business">
              <Button size="sm">Configure business</Button>
            </Link>
          }
        />
      ) : null}
    </div>
  );
}
