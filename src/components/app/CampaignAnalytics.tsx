import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { getCampaignAnalytics, getCampaignCallDetail } from "@/lib/campaigns.functions";
import {
  contactsToCsv,
  type CampaignAnalytics as Report,
  type ContactReportRow,
} from "@/lib/campaign-analytics";
import { OUTCOME_LABEL, type Outcome } from "@/lib/call-analysis";
import { describeQueryError } from "@/lib/query-error";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  SectionCard,
  StatCard,
  StatusPill,
} from "./primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const UNAVAILABLE = "Unavailable";
const pct = (v: number | null) => (v === null ? UNAVAILABLE : `${v}%`);
const rupees = (paise: number | null) =>
  paise === null
    ? UNAVAILABLE
    : `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const duration = (seconds: number | null) => {
  if (seconds === null) return UNAVAILABLE;
  const m = Math.floor(seconds / 60);
  return m > 0 ? `${m}m ${seconds % 60}s` : `${seconds}s`;
};

function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Bars({
  items,
  empty,
}: {
  items: { label: string; count: number; tone?: string }[];
  empty: string;
}) {
  const total = items.reduce((s, i) => s + i.count, 0);
  if (total === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items
        .filter((i) => i.count > 0)
        .map((i) => (
          <li key={i.label}>
            <div className="flex items-baseline justify-between text-xs">
              <span>{i.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {i.count} · {Math.round((i.count / total) * 100)}%
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${i.tone ?? "bg-primary"}`}
                style={{ width: `${(i.count / total) * 100}%` }}
              />
            </div>
          </li>
        ))}
    </ul>
  );
}

const FILTERS = [
  ["all", "All contacts"],
  ["answered", "Answered"],
  ["not_answered", "Not answered"],
  ["interested", "Interested"],
  ["not_interested", "Not interested"],
  ["callback", "Callback requested"],
  ["follow_up", "Follow-up needed"],
  ["appointment", "Appointment booked, moved or cancelled"],
  ["opted_out", "Asked not to be called"],
  ["pending", "Awaiting analysis"],
] as const;
type Filter = (typeof FILTERS)[number][0];

const matches = (r: ContactReportRow, f: Filter): boolean => {
  const a = r.analysis;
  switch (f) {
    case "answered":
      return Boolean(r.lastCall?.answered);
    case "not_answered":
      return Boolean(r.lastCall) && !r.lastCall!.answered;
    case "interested":
      return Boolean(
        a &&
        [
          "interested",
          "appointment_booked",
          "appointment_rescheduled",
          "appointment_confirmed",
        ].includes(a.outcome),
      );
    case "not_interested":
      return a?.outcome === "not_interested";
    case "callback":
      return Boolean(a?.callback.requested);
    case "follow_up":
      return Boolean(a?.follow_up_required);
    case "appointment":
      return Boolean(a && a.appointment.outcome !== "none");
    case "opted_out":
      return a?.outcome === "opted_out" || r.status === "opted_out";
    case "pending":
      return r.analysisState === "pending";
    default:
      return true;
  }
};

const SORTS = [
  ["recent", "Most recent call"],
  ["name", "Name"],
  ["duration", "Longest conversation"],
  ["outcome", "Outcome"],
] as const;
type Sort = (typeof SORTS)[number][0];

function sortRows(rows: ContactReportRow[], sort: Sort): ContactReportRow[] {
  const copy = rows.slice();
  switch (sort) {
    case "name":
      return copy.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    case "duration":
      return copy.sort(
        (a, b) => (b.lastCall?.durationSeconds ?? -1) - (a.lastCall?.durationSeconds ?? -1),
      );
    case "outcome":
      return copy.sort((a, b) =>
        (a.analysis?.outcome ?? "~").localeCompare(b.analysis?.outcome ?? "~"),
      );
    default:
      return copy.sort(
        (a, b) =>
          Date.parse(b.lastCall?.startedAt ?? "1970-01-01") -
          Date.parse(a.lastCall?.startedAt ?? "1970-01-01"),
      );
  }
}

const STATE_LABEL = {
  ai: "Analysed",
  basic: "Basic (no transcript)",
  pending: "Awaiting analysis",
  none: "Not connected",
} as const;

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function ContactDetail({ campaignId, row }: { campaignId: string; row: ContactReportRow }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const a = row.analysis;
  const detail = useQuery({
    queryKey: ["campaign-call-detail", campaignId, row.lastCall?.id],
    enabled: showTranscript && Boolean(row.lastCall),
    queryFn: () => getCampaignCallDetail({ data: { campaignId, callId: row.lastCall!.id } }),
  });
  return (
    <div className="space-y-4 border-t border-border bg-muted/30 px-5 py-4 text-sm">
      {!a ? (
        <p className="text-muted-foreground">
          {row.lastCall?.answered
            ? "This call has not been analysed yet. It is picked up automatically within a few minutes."
            : "This contact did not reach a conversation, so there is nothing to analyse."}
        </p>
      ) : (
        <>
          {a.summary ? <p>{a.summary}</p> : null}
          {row.analysisState === "basic" ? (
            <p className="text-xs text-muted-foreground">
              Basic analysis from the call result only: a summary and what the person said are
              unavailable.
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Outcome</p>
              <p>{OUTCOME_LABEL[a.outcome as Outcome]}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Intent / interest
              </p>
              <p>
                {a.intent ?? UNAVAILABLE} · {a.interest_level ?? UNAVAILABLE}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Sentiment / response
              </p>
              <p>
                {a.sentiment ?? UNAVAILABLE} · {a.response ?? UNAVAILABLE}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Purchase likelihood
              </p>
              <p>{a.purchase_intent ?? UNAVAILABLE}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Price sensitivity
              </p>
              <p>{a.price_sensitivity ?? UNAVAILABLE}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Appointment
              </p>
              <p>
                {a.appointment.outcome === "none"
                  ? "None"
                  : `${a.appointment.outcome}${a.appointment.booking_id ? ` (booking ${a.appointment.booking_id.slice(0, 8)})` : ""}`}
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <List title="What the customer said" items={a.customer_said} />
            <List title="Objections or concerns" items={a.objections} />
            <List title="Questions asked" items={a.questions} />
            <List title="Preferences" items={a.preferences} />
            <List title="Competitors mentioned" items={a.competitors} />
          </div>
          {a.callback.requested || a.follow_up_required ? (
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Follow-up
              </p>
              <p>
                {a.callback.requested
                  ? `Asked to be contacted${a.callback.when ? `: ${a.callback.when}` : ""}. `
                  : ""}
                {a.next_action ?? "Follow-up needed."}
              </p>
            </div>
          ) : null}
          {Object.keys(a.extracted).length > 0 ? (
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Extracted data
              </p>
              <dl className="mt-1 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {Object.entries(a.extracted).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{k.replace(/_/g, " ")}</dt>
                    <dd>{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </>
      )}
      {row.lastCall?.answered ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" onClick={() => setShowTranscript((s) => !s)}>
            {showTranscript ? "Hide transcript" : "Show transcript"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {row.lastCall.hasRecording
              ? "Recording available below."
              : "Recording not available for this call."}
          </span>
        </div>
      ) : null}
      {showTranscript ? (
        detail.isLoading ? (
          <LoadingState label="Loading transcript" />
        ) : detail.isError ? (
          <ErrorState
            message={describeQueryError(detail.error, "Could not load the transcript.")}
            onRetry={() => void detail.refetch()}
          />
        ) : detail.data ? (
          <div className="space-y-2">
            {detail.data.recordingUrl ? (
              <audio controls src={detail.data.recordingUrl} className="w-full" />
            ) : null}
            {detail.data.transcript.length === 0 ? (
              <p className="text-muted-foreground">No transcript was recorded for this call.</p>
            ) : (
              <ol className="space-y-1.5">
                {detail.data.transcript.map((t, i) => (
                  <li key={i}>
                    <span className="mr-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                      {t.role === "agent" ? "Assistant" : "Customer"}
                    </span>
                    {t.text}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ) : null
      ) : null}
    </div>
  );
}

function downloadCsv(rows: ContactReportRow[]) {
  const blob = new Blob([contactsToCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "campaign-report.csv";
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The campaign report: what the campaign accomplished, from the real calls and the stored
 * analysis of each (campaign-analytics.ts). Figures that cannot be worked out yet say
 * "Unavailable"; nothing is estimated.
 */
export function CampaignAnalytics({ campaignId }: { campaignId: string }) {
  const q = useQuery({
    queryKey: ["campaign-analytics", campaignId],
    queryFn: () => getCampaignAnalytics({ data: { campaignId } }),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [open, setOpen] = useState<string | null>(null);

  const report: Report | undefined = q.data?.analytics;
  const rows = useMemo(() => {
    if (!report) return [];
    const needle = search.trim().toLowerCase();
    return sortRows(
      report.contacts.filter(
        (r) =>
          matches(r, filter) &&
          (!needle ||
            [r.name, r.phone, r.analysis?.summary, r.resultLabel]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(needle))),
      ),
      sort,
    );
  }, [report, search, filter, sort]);

  if (q.isLoading) return <LoadingState label="Loading report" />;
  if (q.isError)
    return (
      <SectionCard title="Campaign report">
        <ErrorState
          message={describeQueryError(q.error, "Could not load the campaign report.")}
          onRetry={() => void q.refetch()}
        />
      </SectionCard>
    );
  if (!report) return null;
  if (report.totals.callsAttempted === 0)
    return (
      <SectionCard title="Campaign report" description="What this campaign has accomplished.">
        <EmptyState
          title="No calls yet"
          description="The report fills in as calls are placed and finish."
        />
      </SectionCard>
    );

  const t = report.totals;
  const r = report.rates;
  const c = report.coverage;
  const outcomes = (Object.entries(report.outcomes) as [Outcome, number][]).map(([o, count]) => ({
    label: OUTCOME_LABEL[o],
    count,
  }));
  const followUps = report.contacts.filter((x) => x.analysis?.follow_up_required);
  const appointments = report.contacts.filter(
    (x) => x.analysis && x.analysis.appointment.outcome !== "none",
  );

  return (
    <div className="space-y-6">
      <SectionCard
        title="Campaign report"
        description="Calculated from this campaign's real calls and the analysis of each finished call."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Contacts" value={t.contacts} hint={`${t.eligibleContacts} callable`} />
          <StatCard label="Calls attempted" value={t.callsAttempted} />
          <StatCard
            label="Answered"
            value={t.answered}
            hint={`${t.noAnswer} no answer · ${t.busy} busy · ${t.failed} failed`}
          />
          <StatCard
            label="Conversations"
            value={t.conversations}
            hint="Answered by the person, not voicemail"
          />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Average conversation" value={duration(t.avgConversationSeconds)} />
          <Metric label="Total connected time" value={duration(t.connectedSeconds)} />
          <Metric
            label="Contact success rate"
            value={pct(r.contactSuccessRate)}
            hint="Contacts reached ÷ callable contacts"
          />
          <Metric
            label="Conversion rate"
            value={pct(r.conversionRate)}
            hint="Conversations that reached the goal"
          />
        </div>
        {c.pending > 0 || c.basic > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {c.analysed} of {c.calls} answered calls are fully analysed
            {c.basic > 0 ? `, ${c.basic} from the call result only (no transcript)` : ""}
            {c.pending > 0 ? `, ${c.pending} waiting for analysis` : ""}. Figures that depend on the
            analysis update as it completes.
          </p>
        ) : null}
        {q.data?.truncated ? (
          <p className="mt-2 text-xs text-warning">
            This campaign is larger than one report can read; the figures cover its first 5,000
            rows.
          </p>
        ) : null}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard title="Outcomes" description="Each contact's latest conversation.">
          <Bars items={outcomes} empty="No analysed conversations yet." />
        </SectionCard>
        <SectionCard title="Interested vs not interested">
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Interested" value={pct(r.interestedPct)} />
            <Metric label="Not interested" value={pct(r.notInterestedPct)} />
            <Metric label="Callback" value={pct(r.callbackPct)} />
          </div>
        </SectionCard>
        <SectionCard title="Sentiment">
          <Bars
            empty="No analysed conversations yet."
            items={[
              { label: "Positive", count: report.sentiment.positive, tone: "bg-success" },
              { label: "Neutral", count: report.sentiment.neutral, tone: "bg-muted-foreground" },
              { label: "Mixed", count: report.sentiment.mixed, tone: "bg-warning" },
              { label: "Negative", count: report.sentiment.negative, tone: "bg-destructive" },
              { label: "Not stated", count: report.sentiment.unknown, tone: "bg-border" },
            ]}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Response: {pct(r.positivePct)} positive · {pct(r.neutralPct)} neutral ·{" "}
            {pct(r.negativePct)} negative
          </p>
        </SectionCard>
      </div>

      <SectionCard title="Results and cost">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Appointments booked" value={report.appointments.booked} />
          <Metric label="Appointments rescheduled" value={report.appointments.rescheduled} />
          <Metric label="Appointments cancelled" value={report.appointments.cancelled} />
          <Metric label="Leads captured" value={report.leadsCaptured} />
          <Metric label="Follow-up required" value={report.followUps} />
          <Metric label="Do-not-call requests" value={report.doNotCall} />
          <Metric label="Campaign cost" value={rupees(report.cost.totalPaise)} />
          <Metric label="Cost per answered call" value={rupees(report.cost.perAnsweredCall)} />
          <Metric
            label="Cost per interested contact"
            value={rupees(report.cost.perInterestedContact)}
          />
          <Metric
            label="Cost per successful outcome"
            value={rupees(report.cost.perSuccessfulContact)}
          />
        </div>
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Follow-up list" description="People the business should contact next.">
          {followUps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No follow-ups needed.</p>
          ) : (
            <ul className="divide-y divide-border">
              {followUps.map((x) => (
                <li key={x.id} className="py-2 text-sm">
                  <p className="font-medium">
                    {x.name ?? "Unnamed"}{" "}
                    <span className="font-normal text-muted-foreground">{x.phone}</span>
                  </p>
                  <p className="text-muted-foreground">
                    {x.analysis!.callback.when ? `${x.analysis!.callback.when} · ` : ""}
                    {x.analysis!.next_action ?? "Follow up"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard title="Appointments and conversions">
          {appointments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No appointments booked, moved or cancelled on these calls yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {appointments.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>
                    {x.name ?? "Unnamed"} <span className="text-muted-foreground">{x.phone}</span>
                  </span>
                  <StatusPill
                    tone={x.analysis!.appointment.outcome === "cancelled" ? "error" : "live"}
                  >
                    {x.analysis!.appointment.outcome}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Contact-by-contact report"
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => downloadCsv(rows)}
            disabled={rows.length === 0}
          >
            <Download className="mr-1.5 size-3.5" /> Download CSV ({rows.length})
          </Button>
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Input
            aria-label="Search contacts"
            placeholder="Search name, phone or summary"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <SelectTrigger aria-label="Filter contacts">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger aria-label="Sort contacts">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  Sort: {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No contacts match.</p>
        ) : (
          <ul className="-mx-5 divide-y divide-border border-y border-border">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center justify-between gap-2 px-5 py-3 text-left hover:bg-muted/40"
                  aria-expanded={open === row.id}
                  onClick={() => setOpen(open === row.id ? null : row.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {row.name ?? "Unnamed"}{" "}
                      <span className="font-normal text-muted-foreground">{row.phone}</span>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.analysis?.summary ?? row.resultLabel}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-xs">
                    {row.lastCall?.answered ? (
                      <span className="tabular-nums text-muted-foreground">
                        {duration(row.lastCall.durationSeconds)}
                      </span>
                    ) : null}
                    <StatusPill tone={row.lastCall?.answered ? "live" : "idle"} dot={false}>
                      {row.analysis
                        ? OUTCOME_LABEL[row.analysis.outcome as Outcome]
                        : row.resultLabel}
                    </StatusPill>
                    <span className="hidden text-muted-foreground sm:inline">
                      {STATE_LABEL[row.analysisState]}
                    </span>
                  </span>
                </button>
                {open === row.id ? <ContactDetail campaignId={campaignId} row={row} /> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
