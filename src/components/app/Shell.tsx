import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import {
  LayoutDashboard,
  PhoneCall,
  Users,
  Bot,
  Hash,
  Wallet,
  Settings,
  Building2,
  Menu,
  X,
  LogOut,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo, StatusPill } from "./primitives";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, numbersQuery, agentStatusLabel } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const NAV: { group: string; items: { to: string; label: string; icon: React.ComponentType<{ className?: string }> }[] }[] = [
  {
    group: "Workspace",
    items: [
      { to: "/app", label: "Overview", icon: LayoutDashboard },
      { to: "/app/calls", label: "Calls", icon: PhoneCall },
      { to: "/app/leads", label: "Leads", icon: Users },
    ],
  },
  {
    group: "Configure",
    items: [
      { to: "/app/business", label: "Business", icon: Building2 },
      { to: "/app/agent", label: "AI Receptionist", icon: Bot },
      { to: "/app/numbers", label: "Phone numbers", icon: Hash },
    ],
  },
  {
    group: "Account",
    items: [
      { to: "/app/billing", label: "Usage & billing", icon: Wallet },
      { to: "/app/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const { data: numbers } = useQuery(numbersQuery(ws?.organization?.id));

  const status = agentStatusLabel(ws?.agent ?? null, Boolean(numbers?.some((n) => n.status === "active")));

  return (
    <div className="flex min-h-screen bg-background">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[250px] flex-col border-r border-sidebar-border bg-sidebar transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-4">
          <Link to="/app" onClick={() => setOpen(false)}>
            <Logo />
          </Link>
          <button className="lg:hidden" onClick={() => setOpen(false)} aria-label="Close navigation">
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {NAV.map((group) => (
            <div key={group.group} className="mb-5">
              <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                {group.group}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = item.to === "/app" ? pathname === "/app" : pathname.startsWith(item.to);
                  return (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        onClick={() => setOpen(false)}
                        className={cn(
                          "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors",
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                        )}
                      >
                        <item.icon className={cn("size-4", active && "text-primary")} />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className="rounded-md border border-sidebar-border bg-sidebar-accent/40 p-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Receptionist</span>
              <StatusPill tone={status.tone}>{status.label}</StatusPill>
            </div>
            <Link to="/app/agent" className="mt-2.5 block">
              <Button size="sm" variant="secondary" className="w-full">
                Open configuration
              </Button>
            </Link>
          </div>
        </div>
      </aside>

      {open ? (
        <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setOpen(false)} aria-hidden />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[250px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur lg:px-6">
          <button className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation">
            <Menu className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{ws?.business?.name ?? ws?.organization?.name ?? "Your workspace"}</p>
          </div>
          <StatusPill tone={status.tone} className="hidden sm:inline-flex">
            {status.label}
          </StatusPill>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent">
                <span className="grid size-5 place-items-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                  {(user?.email ?? "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden max-w-[140px] truncate sm:inline">{user?.email}</span>
                <ChevronDown className="size-3 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
                {user?.email}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate({ to: "/app/settings" })}>Settings</DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate({ to: "/app/billing" })}>Usage & billing</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={async () => {
                  await signOut();
                  navigate({ to: "/auth" });
                }}
              >
                <LogOut className="mr-2 size-3.5" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
