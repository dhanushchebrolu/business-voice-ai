import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery } from "@/lib/workspace";
import { featureLocksQuery } from "@/lib/access";
import { Shell } from "@/components/app/Shell";
import { AccountLocked } from "@/components/app/AccountLocked";
import { NoWorkspace } from "@/components/app/NoWorkspace";

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [
      { title: "Dashboard — Vaani" },
      {
        name: "description",
        content: "Manage your AI receptionist, calls, leads and phone numbers.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AppLayout,
});

function AppLayout() {
  const { session, loading, user } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: ws, isLoading } = useQuery(workspaceQuery(user?.id));

  const { data: locks } = useQuery(featureLocksQuery(ws?.organization?.id));

  const org = ws?.organization;
  const lifecycle = org?.lifecycle_status ?? "not_provisioned";
  // Customer-level lock (admin suspend, or cancellation) — everything blocked,
  // data preserved. Independent of the emergency 'dashboard' feature-lock,
  // which an admin can also set without changing lifecycle at all.
  const customerLocked =
    lifecycle === "suspended" || lifecycle === "cancelled" || lifecycle === "archived";
  const dashboardForceLocked = locks?.["dashboard"] === true;
  // Dashboard ACCESS (can the customer reach a workspace at all) is distinct
  // from SERVICE access (can they use a specific billable feature). Setup
  // payment gates the latter, not the former — the customer can always see
  // their setup/payment state once a workspace has been provisioned for them.
  const setupPending = lifecycle === "not_provisioned" || lifecycle === "setup_payment_pending";
  const showLockedScreen = customerLocked || dashboardForceLocked || setupPending;

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth" });
  }, [loading, session, navigate]);

  useEffect(() => {
    if (!isLoading && ws && !showLockedScreen && !ws.business && pathname !== "/app/onboarding") {
      navigate({ to: "/app/onboarding" });
    }
  }, [isLoading, ws, showLockedScreen, pathname, navigate]);

  if (loading || (session && isLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading your workspace…
      </div>
    );
  }

  if (!session) return null;

  // A signed-in user with no workspace at all: they have an account but no
  // admin has created a customer for them yet. This is a real, expected
  // state now that signup no longer auto-provisions a workspace (Phase B
  // §1) — distinct from a provisioned-but-unpaid workspace, which shows
  // AccountLocked instead.
  if (!org) {
    return <NoWorkspace />;
  }

  // The dashboard itself is still "access" even in this state — it shows the
  // setup/payment or suspended view rather than a blank or missing page.
  if (org && showLockedScreen) {
    return <AccountLocked lifecycle={lifecycle} clientId={org.client_id} name={org.name} />;
  }

  if (pathname === "/app/onboarding") return <Outlet />;

  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
