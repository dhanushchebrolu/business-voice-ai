import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery } from "@/lib/workspace";
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

/**
 * Public-site header nav.
 *
 * Three states, all backend-authoritative (never inferred from the mere
 * presence of a session):
 *   - Signed in with a live workspace -> Dashboard button.
 *   - Signed in with no workspace -> identity + Sign out. Authentication is
 *     not customer entitlement: this visitor sees the normal public site,
 *     never a /app or /admin control, and is never shown Sign in / Get
 *     started again while authenticated.
 *   - Not signed in -> Sign in / Get started.
 */
export function PublicNav() {
  const { session, user, signOut } = useAuth();
  const { loading, hasDashboard } = useDashboardAccess();
  const navigate = useNavigate();

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

  if (session && !loading && !hasDashboard) {
    return (
      <nav className="flex items-center gap-2">
        <Link
          to="/pricing"
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          Pricing
        </Link>
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
