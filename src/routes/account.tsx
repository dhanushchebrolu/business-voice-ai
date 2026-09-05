import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { AuthenticatedShell } from "@/components/app/AuthenticatedShell";

export const Route = createFileRoute("/account")({
  head: () => ({
    meta: [
      { title: "Your account — Vaani" },
      { name: "description", content: "Profile, settings and workspace status." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountLayout,
});

function AccountLayout() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth" });
  }, [loading, session, navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (!session) return null;

  return (
    <AuthenticatedShell>
      <Outlet />
    </AuthenticatedShell>
  );
}
