import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  PhoneCall,
  Users,
  Bot,
  Hash,
  ArrowUpRight,
  Clock,
  MessageSquare,
  MessagesSquare,
  Check,
  CalendarCheck,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  workspaceQuery,
  callsQuery,
  leadsQuery,
  numbersQuery,
  agentStatusLabel,
} from "@/lib/workspace";
import { listWhatsAppConnections } from "@/lib/whatsapp-connection.functions";
import { callsByDay, countsByWeek, isAnswered, isMissed, percent } from "@/lib/overview-metrics";
import {
  PageHeader,
  StatCard,
  SectionCard,
  EmptyState,
  StatusPill,
  Skeleton,
} from "@/components/app/primitives";
import {
  ServiceCard,
  CallActivityChart,
  WeeklyBars,
  SplitBar,
} from "@/components/app/overview-widgets";
import { getBusinessType } from "@/lib/business-types";
import { Button } from "@/components/ui/button";
import { AccountStatusPanel } from "@/components/app/AccountStatusPanel";

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Overview — ClickAI" },
      { name: "description", content: "Call volume, leads and receptionist status at a glance." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Overview,
});

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

function Overview() {
  const { user } = useAuth();
  const { data: ws, isLoading } = useQuery(workspaceQuery(user?.id));
  const orgId = ws?.organization?.id;
  const { data: calls } = useQuery(callsQuery(orgId));
  const { data: leads } = useQuery(leadsQuery(orgId));
  const { data: numbers } = useQuery(numbersQuery(orgId));
  const getConnections = useServerFn(listWhatsAppConnections);
  const { data: whatsapp, isError: whatsappError } = useQuery({
    queryKey: ["whatsapp-connections", orgId],
    enabled: Boolean(orgId),
    queryFn: () => getConnections(),
  });
  // RLS-scoped, same as every other dashboard read; only used for the booking counts below.
  const { data: bookings } = useQuery({
    queryKey: ["overview-bookings", orgId],
    enabled: Boolean(orgId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select("id, status, created_at")
        .eq("organization_id", orgId!)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6" role="status" aria-label="Loading overview">
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const fullName = user?.user_metadata?.["full_name"];
  const firstName = typeof fullName === "string" ? fullName.split(" ")[0] : "";
  const type = getBusinessType(ws?.business?.business_type);
  const activeNumber = numbers?.find((n) => n.status === "active");
  const status = agentStatusLabel(ws?.agent ?? null, Boolean(activeNumber), activeNumber?.provider);
  const voicePublished = (ws?.agent?.active_version ?? 0) > 0;

  const allCalls = calls ?? [];
  const answeredCount = allCalls.filter(isAnswered).length;
  const missedCount = allCalls.filter(isMissed).length;
  const totalMinutes = Math.round(allCalls.reduce((s, c) => s + (c.duration_seconds ?? 0), 0) / 60);
  const answerRate = percent(answeredCount, answeredCount + missedCount);
  const days = callsByDay(allCalls, 14);
  const weeks = countsByWeek(
    (leads ?? []).map((l) => l.created_at),
    8,
  );

  const bookingRows = bookings ?? [];
  const confirmedBookings = bookingRows.filter((b) =>
    ["confirmed", "completed"].includes(b.status),
  ).length;
  const bookingRate = percent(confirmedBookings, answeredCount);

  const waConnected = whatsapp?.find((c) => c.status === "connected");
  const waAttention = whatsapp?.find((c) => c.status === "needs_attention" || c.status === "error");

  const setupSteps = [
    {
      done: Boolean(ws?.business?.description),
      label: "Describe your business",
      to: "/app/business",
    },
    { done: voicePublished, label: "Save your receptionist configuration", to: "/app/agent" },
    { done: Boolean(activeNumber), label: "Connect a phone number", to: "/app/numbers" },
  ];
  const pending = setupSteps.filter((s) => !s.done);

  return (
    <div className="space-y-6">
      <PageHeader
        {...(ws?.business?.name ? { eyebrow: ws.business.name } : {})}
        title={`${greeting()}${firstName ? `, ${firstName}` : ""}`}
        description={`Your ${type.label.toLowerCase()} receptionist, its call activity and the ${type.customerLabel.toLowerCase()} it captured.`}
        actions={
          <>
            <StatusPill tone={status.tone} className="sm:hidden">
              {status.label}
            </StatusPill>
            <Link to="/app/agent">
              <Button size="sm">
                {voicePublished ? "Open receptionist" : "Configure receptionist"}
              </Button>
            </Link>
          </>
        }
      />

      {pending.length ? (
        <SectionCard
          title="Finish your setup"
          description={`${setupSteps.length - pending.length} of ${setupSteps.length} steps done.`}
        >
          <ol className="grid gap-2.5 md:grid-cols-3">
            {setupSteps.map((step, i) => (
              <li key={step.label}>
                <Link
                  to={step.to}
                  className="flex h-full items-center gap-3 rounded-xl border border-border px-3.5 py-3 text-sm transition-colors hover:border-primary/40 hover:bg-primary/5"
                >
                  <span
                    className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                      step.done ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {step.done ? <Check className="size-3.5" /> : i + 1}
                  </span>
                  <span
                    className={step.done ? "text-muted-foreground line-through" : "font-medium"}
                  >
                    {step.label}
                  </span>
                  {!step.done ? <ArrowUpRight className="ml-auto size-4 text-primary" /> : null}
                </Link>
              </li>
            ))}
          </ol>
        </SectionCard>
      ) : null}

      <section aria-label="Service status" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <ServiceCard
          icon={PhoneCall}
          label="Phone"
          tone={activeNumber ? "live" : "idle"}
          statusLabel={activeNumber ? "Live" : "Not connected"}
          hint={activeNumber?.e164 ?? "Connect a number to answer calls."}
          to="/app/numbers"
          actionLabel={activeNumber ? "Manage numbers" : "Connect a number"}
        />
        <ServiceCard
          icon={Bot}
          label="Voice agent"
          tone={voicePublished ? "live" : "idle"}
          statusLabel={voicePublished ? "Published" : "Not published"}
          hint={
            voicePublished
              ? `Version ${ws?.agent?.active_version} is answering.`
              : "Save your configuration to publish."
          }
          to="/app/agent"
          actionLabel="Configure"
        />
        <ServiceCard
          icon={MessageSquare}
          label="WhatsApp"
          tone={waConnected ? "live" : waAttention ? "ready" : "idle"}
          statusLabel={
            waConnected
              ? "Connected"
              : waAttention
                ? "Needs attention"
                : whatsappError
                  ? "Unavailable"
                  : "Not connected"
          }
          hint={
            waConnected?.display_phone_number ??
            (waAttention ? "Reconnect to resume messaging." : "Connect a WhatsApp Business number.")
          }
          to="/app/whatsapp"
          actionLabel={waConnected ? "Manage" : "Set up"}
        />
        <ServiceCard
          icon={MessagesSquare}
          label="Website chatbot"
          tone="idle"
          statusLabel="Not connected"
          hint="No website chatbot is connected to this workspace."
        />
      </section>

      <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={PhoneCall}
          label="Calls answered"
          value={answeredCount}
          hint="Latest 200 calls"
          tone="accent"
        />
        <StatCard icon={Clock} label="Talk minutes" value={totalMinutes} hint="Billed per minute" />
        <StatCard
          icon={Users}
          label={`${type.customerLabel} captured`}
          value={leads?.length ?? 0}
        />
        <StatCard
          icon={Hash}
          label="Live numbers"
          value={numbers?.filter((n) => n.status === "active").length ?? 0}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title="Call activity"
          description="Answered and missed calls per day, last 14 days."
        >
          {allCalls.length ? (
            <CallActivityChart days={days} />
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No calls yet. Activity appears here once calls arrive.
            </p>
          )}
        </SectionCard>
        <SectionCard title="Answered vs missed" description="From your latest calls.">
          <SplitBar
            parts={[
              { label: "Answered", value: answeredCount, className: "bg-primary" },
              { label: "Missed", value: missedCount, className: "bg-muted-foreground/30" },
            ]}
          />
          <dl className="mt-5 space-y-3 border-t border-border pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Answer rate</dt>
              <dd className="font-medium tabular">
                {answerRate === null ? "No data" : `${answerRate}%`}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <CalendarCheck className="size-3.5" /> Bookings
              </dt>
              <dd className="font-medium tabular">
                {confirmedBookings}
                {bookingRate !== null ? (
                  <span className="ml-1 text-muted-foreground">({bookingRate}% of answered)</span>
                ) : null}
              </dd>
            </div>
          </dl>
        </SectionCard>
      </div>

      <SectionCard
        title={`${type.customerLabel} captured`}
        description="New contacts the receptionist saved, per week."
      >
        {leads?.length ? (
          <WeeklyBars weeks={weeks} noun={type.customerLabel.toLowerCase()} />
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing captured yet.</p>
        )}
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Recent calls"
          description="Latest calls, with summary and outcome."
          actions={
            <Link to="/app/calls">
              <Button size="sm" variant="ghost">
                View all
              </Button>
            </Link>
          }
        >
          {allCalls.length ? (
            <ul className="-my-2 divide-y divide-border">
              {allCalls.slice(0, 6).map((call) => (
                <li key={call.id}>
                  <Link
                    to="/app/calls"
                    className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-3 text-sm transition-colors hover:bg-muted/60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {call.caller_name ?? call.caller_number ?? "Unknown caller"}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {call.summary ?? call.outcome ?? "No summary"}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <StatusPill
                        tone={isAnswered(call) ? "live" : isMissed(call) ? "error" : "idle"}
                        dot={false}
                      >
                        {isAnswered(call)
                          ? "Answered"
                          : isMissed(call)
                            ? "Missed"
                            : call.status.replace("_", " ")}
                      </StatusPill>
                      <span className="tabular text-[11px] text-muted-foreground">
                        {new Date(call.started_at ?? call.created_at).toLocaleString(undefined, {
                          day: "numeric",
                          month: "short",
                          hour: "numeric",
                          minute: "2-digit",
                        })}{" "}
                        · {Math.round((call.duration_seconds ?? 0) / 60)}m
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={PhoneCall}
              title="No calls yet"
              description="Once a phone number is connected and your receptionist is saved and ready, calls will appear here."
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
            <ul className="-my-2 divide-y divide-border">
              {leads.slice(0, 6).map((lead) => (
                <li key={lead.id}>
                  <Link
                    to="/app/leads"
                    className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-3 text-sm transition-colors hover:bg-muted/60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{lead.name ?? "Unnamed"}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {lead.phone ?? lead.email ?? "No contact"}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <StatusPill tone={lead.score === "hot" ? "accent" : "idle"} dot={false}>
                        {lead.score}
                      </StatusPill>
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(lead.created_at).toLocaleDateString(undefined, {
                          day: "numeric",
                          month: "short",
                        })}
                      </span>
                    </span>
                  </Link>
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

      <AccountStatusPanel showChannels={false} />
    </div>
  );
}
