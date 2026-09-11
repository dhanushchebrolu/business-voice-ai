import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery } from "@/lib/workspace";
import { dashboardOverrideQuery } from "@/lib/access";
import { isDashboardLocked } from "@/lib/dashboard-access";
import { Shell } from "@/components/app/Shell";
import { AccountLocked } from "@/components/app/AccountLocked";

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

  const org = ws?.organization;
  const { data: dashboardOverride, isLoading: overrideLoading } = useQuery({
    ...dashboardOverrideQuery(org?.id),
    enabled: Boolean(org?.id),
  });

  const lifecycle = org?.lifecycle_status ?? "not_provisioned";
  // Dashboard ACCESS (can the customer reach a workspace at all) is distinct
  // from SERVICE access (can they use a specific billable feature). Setup
  // payment gates the latter, not the former — the customer can always see
  // their setup/payment state once a workspace has been provisioned for
  // them, unless an admin has explicitly overridden that (isDashboardLocked,
  // src/lib/dashboard-access.ts — the same rule PublicNav's Dashboard button
  // uses, so the two can never disagree). organizations.payment_override
  // (Phase B: setPaymentOverride / CustomerControlPanel's "Override payment
  // requirement") remains the existing, audited, per-customer demo/override
  // mechanism for the payment gate specifically — reused here, not
  // duplicated: the lifecycle stays exactly what it was (never fabricated to
  // "active"), no payment/invoice/subscription is created, only this one
  // gate opens.
  const showLockedScreen = isDashboardLocked({
    lifecycleStatus: org?.lifecycle_status ?? null,
    paymentOverride: org?.payment_override ?? false,
    dashboardOverride: dashboardOverride ?? null,
  });

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth" });
  }, [loading, session, navigate]);

  // A signed-in user with no workspace at all has an account but no admin
  // has created a customer for them yet — a real, expected state now that
  // signup no longer auto-provisions a workspace. /app is customer-only
  // functionality, so they're sent back to the public website instead of
  // being stranded here — authentication is not workspace provisioning.
  useEffect(() => {
    if (!loading && session && !isLoading && !org) navigate({ to: "/" });
  }, [loading, session, isLoading, org, navigate]);

  useEffect(() => {
    if (
      !isLoading &&
      ws &&
      org &&
      !showLockedScreen &&
      !ws.business &&
      pathname !== "/app/onboarding"
    ) {
      navigate({ to: "/app/onboarding" });
    }
  }, [isLoading, ws, org, showLockedScreen, pathname, navigate]);

  if (
    loading ||
    (session && isLoading) ||
    (session && !isLoading && !org) ||
    (session && org && overrideLoading)
  ) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading your workspace…
      </div>
    );
  }

  if (!session) return null;

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
