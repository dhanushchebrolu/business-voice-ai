import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * Layout for /app/campaigns: the list (app.campaigns.index.tsx), the wizard
 * (app.campaigns.new.tsx) and a campaign (app.campaigns.$campaignId.tsx) all
 * render here. Without this Outlet the child pages never showed: every
 * campaign link kept rendering the list.
 */
export const Route = createFileRoute("/app/campaigns")({
  component: () => <Outlet />,
});
