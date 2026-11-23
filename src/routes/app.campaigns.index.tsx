import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Megaphone, Plus, Search } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, campaignsQuery } from "@/lib/workspace";
import {
  PageHeader,
  EmptyState,
  LoadingState,
  ErrorState,
  SectionCard,
} from "@/components/app/primitives";
import { CampaignSetupPill, CampaignStatusPill, formatDate } from "@/components/app/CampaignStatus";
import { describeQueryError } from "@/lib/query-error";
import { ServiceLocked } from "@/components/app/ServiceLocked";
import { featureLocksQuery } from "@/lib/access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/app/campaigns/")({
  head: () => ({
    meta: [
      { title: "Campaigns — ClickAI" },
      {
        name: "description",
        content: "Automatically call your customers and leads with your AI receptionist.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CampaignsPage,
});

const STATUS_FILTERS = [
  "all",
  "draft",
  "scheduled",
  "running",
  "paused",
  "completed",
  "cancelled",
  "failed",
];

function CampaignsPage() {
  const { user } = useAuth();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const orgId = ws?.organization?.id;
  const { data: campaigns, isLoading, isError, error, refetch } = useQuery(campaignsQuery(orgId));
  const { data: locks } = useQuery(featureLocksQuery(orgId));
  const phoneLocked = locks?.["phone"] === true;
  const lifecycle = ws?.organization?.lifecycle_status ?? "not_provisioned";
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (campaigns ?? []).filter(
      (c) =>
        (status === "all" || c.status === status) &&
        (!q || c.name.toLowerCase().includes(q) || (c.objective ?? "").toLowerCase().includes(q)),
    );
  }, [campaigns, search, status]);

  const createButton = (
    <Link to="/app/campaigns/new">
      <Button size="sm">
        <Plus className="mr-1.5 size-3.5" /> Create campaign
      </Button>
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Campaigns"
        description="Have your AI receptionist call a list of customers or leads for one purpose."
        actions={createButton}
      />

      {phoneLocked ? <ServiceLocked feature="phone" lifecycle={lifecycle} compact /> : null}

      {isLoading ? (
        <LoadingState label="Loading campaigns" />
      ) : isError ? (
        <ErrorState
          message={describeQueryError(error, "Could not load your campaigns.")}
          onRetry={() => void refetch()}
        />
      ) : campaigns?.length ? (
        <SectionCard
          title={`${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search campaigns"
                  placeholder="Search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 w-44 pl-8"
                />
              </div>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="h-8 w-36" aria-label="Filter by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTERS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s === "all" ? "All statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        >
          {visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No campaigns match this search.
            </p>
          ) : (
            <div className="-mx-5 overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Campaign</th>
                    <th className="px-3 py-2 font-medium">Business</th>
                    <th className="px-3 py-2 font-medium">Agent</th>
                    <th className="px-3 py-2 text-right font-medium">Contacts</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Starts</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                    <th className="px-5 py-2 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => {
                    const startDate = (c.schedule as { startDate?: string } | null)?.startDate;
                    return (
                      <tr
                        key={c.id}
                        className="border-b border-border/60 transition-colors hover:bg-accent/40"
                      >
                        <td className="max-w-[260px] px-5 py-2.5">
                          <Link
                            to="/app/campaigns/$campaignId"
                            params={{ campaignId: c.id }}
                            className="font-medium hover:underline"
                          >
                            {c.name}
                          </Link>
                          <p className="truncate text-xs text-muted-foreground">
                            {c.objective ?? "No purpose set"}
                          </p>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {c.business_id && c.business_id === ws?.business?.id
                            ? ws.business.name
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {c.agent_configs?.agent_name ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular">
                          {c.campaign_contacts?.[0]?.count ?? 0}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1.5">
                            <CampaignStatusPill status={c.status} />
                            {c.status === "draft" ? (
                              <CampaignSetupPill reviewedAt={c.context_reviewed_at} />
                            ) : null}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground tabular">
                          {startDate ? formatDate(`${startDate}T00:00:00`) : "When launched"}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground tabular">
                          {formatDate(c.created_at)}
                        </td>
                        <td className="px-5 py-2.5 text-xs text-muted-foreground tabular">
                          {formatDate(c.updated_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      ) : (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          description="Create a campaign to have your AI receptionist call a list of customers: appointment reminders, follow-ups or check-ups. Nothing is called until a campaign is launched."
          action={createButton}
        />
      )}
    </div>
  );
}
