import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Megaphone, Plus } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, campaignsQuery } from "@/lib/workspace";
import {
  PageHeader,
  EmptyState,
  LoadingState,
  SectionCard,
  StatusPill,
} from "@/components/app/primitives";
import { ServiceLocked } from "@/components/app/ServiceLocked";
import { featureLocksQuery } from "@/lib/access";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/app/campaigns")({
  head: () => ({
    meta: [
      { title: "Campaigns — Vaani" },
      {
        name: "description",
        content: "Automatically call your customers and leads with your AI receptionist.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CampaignsPage,
});

const STATUS_TONE: Record<string, "live" | "ready" | "idle" | "error"> = {
  draft: "idle",
  scheduled: "ready",
  queued: "ready",
  running: "live",
  paused: "idle",
  completed: "ready",
  failed: "error",
  cancelled: "error",
};

function CampaignsPage() {
  const { user } = useAuth();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const orgId = ws?.organization?.id;
  const { data: campaigns, isLoading } = useQuery(campaignsQuery(orgId));
  const { data: locks } = useQuery(featureLocksQuery(orgId));
  const phoneLocked = locks?.["phone"] === true;
  const lifecycle = ws?.organization?.lifecycle_status ?? "not_provisioned";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Campaigns"
        description="Have your AI receptionist automatically call a list of customers or leads."
        actions={
          <Link to="/app/campaigns/new">
            <Button size="sm">
              <Plus className="mr-1.5 size-3.5" /> Create campaign
            </Button>
          </Link>
        }
      />

      {phoneLocked ? <ServiceLocked feature="phone" lifecycle={lifecycle} compact /> : null}

      {isLoading ? (
        <LoadingState label="Loading campaigns" />
      ) : campaigns?.length ? (
        <SectionCard title={`${campaigns.length} campaigns`}>
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 font-medium">Objective</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-border/60 transition-colors hover:bg-accent/40"
                  >
                    <td className="px-5 py-2.5">
                      <Link
                        to="/app/campaigns/$campaignId"
                        params={{ campaignId: c.id }}
                        className="font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                    </td>
                    <td className="max-w-[280px] truncate px-3 py-2.5 text-muted-foreground">
                      {c.objective ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground tabular">
                      {new Date(c.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-2.5">
                      <StatusPill tone={STATUS_TONE[c.status] ?? "idle"} dot={false}>
                        {c.status}
                      </StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          description="Create a campaign to have your AI receptionist automatically call a list of customers — appointment reminders, follow-ups, or promotions."
        />
      )}
    </div>
  );
}
