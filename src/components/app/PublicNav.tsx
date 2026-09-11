import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery } from "@/lib/workspace";
import { dashboardOverrideQuery } from "@/lib/access";
import { isDashboardLocked } from "@/lib/dashboard-access";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Whether the "Dashboard" button should render on public pages.
 *
 * This is backend-authoritative and uses the exact same rule /app itself
 * enforces (isDashboardLocked, src/lib/dashboard-access.ts) — the button is
 * never shown for access the route would then deny, and never hidden for
 * access the route would actually grant. Every input comes from a
 * server-verified source: `workspaceQuery` resolves the caller's own
 * organization membership through RLS (scoped to auth.uid(), never a
 * client-supplied organization id), and `dashboardOverrideQuery` reads the
 * admin's explicit per-customer override from the same
 * organization_feature_locks row the admin control centre writes to.
 * Nothing here is inferred from localStorage, URL parameters, or frontend
 * state.
 */
export function useDashboardAccess() {
  const { session, user } = useAuth();
  const { data: ws, isLoading: wsLoading } = useQuery({
    ...workspaceQuery(user?.id),
    enabled: Boolean(session),
  });
  const org = ws?.organization;
  const { data: dashboardOverride, isLoading: overrideLoading } = useQuery({
    ...dashboardOverrideQuery(org?.id),
    enabled: Boolean(session) && Boolean(org?.id),
  });

  const loading = Boolean(session) && (wsLoading || (Boolean(org?.id) && overrideLoading));
  const hasDashboard =
    Boolean(org) &&
    !isDashboardLocked({
      lifecycleStatus: org?.lifecycle_status ?? null,
      paymentOverride: org?.payment_override ?? false,
      dashboardOverride: dashboardOverride ?? null,
    });
  return { loading, hasDashboard };
}

/**
 * Public-site header nav.
 *
 * Three states, all backend-authoritative (never inferred from the mere
 * presence of a session):
 *   - Signed in -> identity + Sign out, plus a Dashboard button when (and
 *     only when) hasDashboard is true: Vaani | Pricing | Dashboard |
 *     user@email.com. Authentication is not customer entitlement: a signed-
 *     in visitor without dashboard access sees the normal public site (no
 *     Dashboard button, never a /app or /admin control), and is never shown
 *     Sign in / Get started again while authenticated.
 *   - Not signed in -> Sign in / Get started.
 */
export function PublicNav() {
  const { session, user, signOut } = useAuth();
  const { loading, hasDashboard } = useDashboardAccess();
  const navigate = useNavigate();

  if (session && !loading) {
    return (
      <nav className="flex items-center gap-2">
        <Link
          to="/pricing"
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          Pricing
        </Link>
        {hasDashboard ? (
          <Link to="/app">
            <Button size="sm">Dashboard</Button>
          </Link>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent">
              <span className="grid size-5 place-items-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                {(user?.email ?? "?").slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden max-w-[160px] truncate sm:inline">{user?.email}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
              {user?.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={async () => {
                await signOut();
                navigate({ to: "/" });
              }}
            >
              <LogOut className="mr-2 size-3.5" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
