import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Lock, Users2 } from "lucide-react";
import { campaignQuery } from "@/lib/workspace";
import { configEditBlockedReason, wizardStateFromCampaign } from "@/lib/campaign-wizard";
import type { CampaignSchedule } from "@/lib/campaign-schedule";
import { describeQueryError } from "@/lib/query-error";
import { CampaignWizard } from "@/components/app/CampaignWizard";
import { EmptyState, ErrorState, LoadingState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";

/**
 * Edit a saved campaign's configuration with the same wizard and rules as
 * creating one. The campaign is read through the signed-in user's own client
 * (RLS: only their organization's campaigns); the save is re-authorized
 * server-side (saveCampaignConfiguration).
 */
export const Route = createFileRoute("/app/campaigns/$campaignId_/edit")({
  head: () => ({
    meta: [{ title: "Edit campaign — ClickAI" }, { name: "robots", content: "noindex" }],
  }),
  component: EditCampaignPage,
});

function EditCampaignPage() {
  const { campaignId } = Route.useParams();
  const {
    data: campaign,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(campaignQuery(campaignId));

  if (isLoading) return <LoadingState label="Loading campaign" />;
  if (isError)
    return (
      <ErrorState
        message={describeQueryError(error, "Could not load this campaign.")}
        onRetry={() => void refetch()}
      />
    );
  if (!campaign)
    return (
      <EmptyState
        icon={Users2}
        title="Campaign not found"
        description="It may have been removed, or it belongs to another workspace."
      />
    );

  const blocked = configEditBlockedReason(campaign.status);
  if (blocked)
    return (
      <EmptyState
        icon={Lock}
        title="This campaign can't be edited right now"
        description={blocked}
        action={
          <Link to="/app/campaigns/$campaignId" params={{ campaignId }}>
            <Button size="sm" variant="secondary">
              Back to campaign
            </Button>
          </Link>
        }
      />
    );

  return (
    <CampaignWizard
      // Keyed by id only: a background refetch (another tab saved) must not reset the
      // form under the person; their save is refused as a conflict instead.
      key={campaign.id}
      mode="edit"
      campaignId={campaign.id}
      initial={wizardStateFromCampaign(campaign)}
      savedSchedule={(campaign.schedule ?? null) as CampaignSchedule | null}
      loadedUpdatedAt={campaign.updated_at}
    />
  );
}
