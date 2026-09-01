import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { getAdminSession, claimPlatformAdmin } from "@/lib/admin.functions";
import { AdminShell } from "@/components/admin/AdminShell";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/admin")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Vaani Control — Platform administration" },
      { name: "description", content: "Internal Vaani platform control plane." },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AdminLayout,
});

export function useAdminSession() {
  const fetchSession = useServerFn(getAdminSession);
  const { session } = useAuth();
  return useQuery({
    queryKey: ["admin-session", session?.user.id],
    enabled: Boolean(session),
    queryFn: () => fetchSession(),
  });
}

function AdminLayout() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading, refetch } = useAdminSession();
  const claim = useServerFn(claimPlatformAdmin);

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth" });
  }, [loading, session, navigate]);

  if (loading || (session && isLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Verifying platform access…
      </div>
    );
  }

  if (!session) return null;

  if (!data?.admin) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-lg border border-border bg-muted">
            <ShieldAlert className="size-4 text-muted-foreground" />
          </span>
          <h1 className="mt-4 text-lg font-semibold">Platform administration</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This area is restricted to Vaani platform administrators. Your customer account role does not grant access here.
          </p>
          {data?.bootstrapAvailable ? (
            <Button
              className="mt-5 w-full"
              onClick={async () => {
                try {
                  await claim();
                  toast.success("You are now the platform super admin");
                  await refetch();
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Could not claim admin access");
                }
              }}
            >
              Claim super admin (first-time setup)
            </Button>
          ) : null}
          <Button variant="ghost" className="mt-2 w-full" onClick={() => navigate({ to: "/app" })}>
            Back to my dashboard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <AdminShell role={data.admin.role} email={data.admin.email}>
      <Outlet />
    </AdminShell>
  );
}
