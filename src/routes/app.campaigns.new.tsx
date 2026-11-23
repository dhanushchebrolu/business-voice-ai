import { createFileRoute } from "@tanstack/react-router";
import { CampaignWizard } from "@/components/app/CampaignWizard";

export const Route = createFileRoute("/app/campaigns/new")({
  head: () => ({
    meta: [{ title: "Create campaign — ClickAI" }, { name: "robots", content: "noindex" }],
  }),
  component: () => <CampaignWizard mode="create" />,
});
