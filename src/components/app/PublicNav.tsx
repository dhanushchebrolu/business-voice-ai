import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery } from "@/lib/workspace";
import { Button } from "@/components/ui/button";

/**
 * Whether the "Dashboard" button should render on public pages.
 *
 * This is backend-authoritative: it comes from `workspaceQuery`, which
 * resolves the caller's organization membership server-side (RLS-scoped).
 * It is never inferred from localStorage, URL parameters, or an
 * organization/workspace id supplied by the browser.
 *
 * A workspace that has been archived does not count — an archived customer
 * should not see a live Dashboard entry point.
 */
export function useDashboardAccess() {
  const { session, user } = useAuth();
  const { data: ws, isLoading } = useQuery({
    ...workspaceQuery(user?.id),
    enabled: Boolean(session),
  });
  const org = ws?.organization;
  const hasDashboard = Boolean(org) && org?.lifecycle_status !== "archived";
  return { loading: Boolean(session) && isLoading, hasDashboard };
}

/** Public-site header nav. Shows Dashboard only when the backend confirms access; otherwise Sign in / Get started. */
export function PublicNav() {
  const { session } = useAuth();
  const { loading, hasDashboard } = useDashboardAccess();

  if (session && !loading && hasDashboard) {
    return (
      <nav className="flex items-center gap-2">
        <Link
          to="/pricing"
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          Pricing
        </Link>
        <Link to="/app">
          <Button size="sm">Dashboard</Button>
        </Link>
      </nav>
    );
  }

  return (
    <nav className="flex items-center gap-2">
      <Link
        to="/pricing"
        className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        Pricing
      </Link>
      <Link to="/auth">
        <Button size="sm" variant="ghost">
          Sign in
        </Button>
      </Link>
      <Link to="/auth" search={{ mode: "signup" }}>
        <Button size="sm">Get started</Button>
      </Link>
    </nav>
  );
}
