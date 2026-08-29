import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery } from "@/lib/workspace";
import { Shell } from "@/components/app/Shell";

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [
      { title: "Dashboard — Vaani" },
      { name: "description", content: "Manage your AI receptionist, calls, leads and phone numbers." },
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

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth" });
  }, [loading, session, navigate]);

  useEffect(() => {
    if (!isLoading && ws && !ws.business && pathname !== "/app/onboarding") {
      navigate({ to: "/app/onboarding" });
    }
  }, [isLoading, ws, pathname, navigate]);

  if (loading || (session && isLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading your workspace…
      </div>
    );
  }

  if (!session) return null;
  if (pathname === "/app/onboarding") return <Outlet />;

  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
