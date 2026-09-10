import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "./primitives";
import { Button } from "@/components/ui/button";

/**
 * Normal-site shell for a signed-in user who has no customer workspace yet
 * (or is simply visiting their account area). This is deliberately NOT the
 * customer dashboard (`Shell.tsx` under /app) — it exposes only account-level
 * pages (profile, settings) and never customer/billing/telephony
 * functionality, which stays gated behind /app's workspace check.
 */
export function AuthenticatedShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const nav = [
    { to: "/account", label: "Account", exact: true },
    { to: "/account/settings", label: "Settings", exact: false },
  ] as const;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-4 lg:px-8">
        <Link to="/">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-1 sm:flex">
          {nav.map((item) => {
            const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">{user?.email}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await signOut();
              navigate({ to: "/auth" });
            }}
          >
            <LogOut className="mr-1.5 size-3.5" /> Sign out
          </Button>
        </div>
      </header>

      <nav className="flex items-center gap-1 border-b border-border px-4 py-2 sm:hidden">
        {nav.map((item) => {
          const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 lg:px-0">{children}</main>
    </div>
  );
}
