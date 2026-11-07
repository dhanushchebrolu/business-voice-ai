import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LayoutDashboard,
  PhoneCall,
  Users,
  Bot,
  Hash,
  Wallet,
  Settings,
  Building2,
  BookOpen,
  Menu,
  X,
  LogOut,
  ChevronDown,
  ChevronRight,
  Megaphone,
  Contact,
  MessageCircle,
  CalendarDays,
  Plug,
  Receipt,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo, StatusPill } from "./primitives";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, numbersQuery, agentStatusLabel } from "@/lib/workspace";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Icon = React.ComponentType<{ className?: string }>;

const NAV: { group: string; items: { to: string; label: string; icon: Icon }[] }[] = [
  {
    group: "Workspace",
    items: [
      { to: "/app", label: "Overview", icon: LayoutDashboard },
      { to: "/app/campaigns", label: "Campaigns", icon: Megaphone },
      { to: "/app/contacts", label: "Contacts", icon: Contact },
      { to: "/app/calls", label: "Calls", icon: PhoneCall },
      { to: "/app/leads", label: "Leads", icon: Users },
      { to: "/app/bookings", label: "Bookings", icon: CalendarDays },
      { to: "/app/payments", label: "Payments", icon: Receipt },
    ],
  },
  {
    group: "Configure",
    items: [
      { to: "/app/business", label: "Business", icon: Building2 },
      { to: "/app/knowledge", label: "Knowledge base", icon: BookOpen },
      { to: "/app/agent", label: "AI Receptionist", icon: Bot },
      { to: "/app/numbers", label: "Phone numbers", icon: Hash },
      { to: "/app/whatsapp", label: "WhatsApp", icon: MessageCircle },
      { to: "/app/integrations", label: "Integrations", icon: Plug },
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

const ALL_ITEMS = NAV.flatMap((g) => g.items);
const isActive = (to: string, pathname: string) =>
  to === "/app" ? pathname === "/app" : pathname === to || pathname.startsWith(`${to}/`);

/** "Campaigns > New" style trail built from the real route, never invented. */
function breadcrumbs(pathname: string): string[] {
  const section = ALL_ITEMS.filter((i) => i.to !== "/app" && isActive(i.to, pathname)).sort(
    (a, b) => b.to.length - a.to.length,
  )[0];
  if (!section) return ["Overview"];
  const rest = pathname.slice(section.to.length).split("/").filter(Boolean);
  if (!rest.length) return [section.label];
  return [section.label, rest[0] === "new" ? "New" : "Details"];
}

const COLLAPSE_KEY = "clickai-sidebar-collapsed";

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const { data: numbers } = useQuery(numbersQuery(ws?.organization?.id));
  const firstLink = useRef<HTMLAnchorElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  const activeNumber = numbers?.find((n) => n.status === "active");
  const status = agentStatusLabel(ws?.agent ?? null, Boolean(activeNumber), activeNumber?.provider);
  const businessName = ws?.business?.name ?? ws?.organization?.name ?? "Your workspace";
  const trail = breadcrumbs(pathname);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // storage unavailable: the sidebar just starts expanded
    }
  }, []);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        // not persisted; fine
      }
      return !c;
    });

  // Mobile drawer: Escape closes, page scroll locks, focus moves in and returns to the menu button.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    firstLink.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    const btn = menuButton.current;
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      btn?.focus();
    };
  }, [open]);

  return (
    <div className="flex min-h-screen bg-background">
      <aside
        data-open={open}
        aria-label="Main navigation"
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[264px] flex-col border-r border-sidebar-border bg-sidebar transition-[transform,width,visibility] duration-200 motion-reduce:transition-none lg:translate-x-0",
          collapsed ? "lg:w-[76px]" : "lg:w-[264px]",
          open ? "translate-x-0" : "max-lg:invisible -translate-x-full",
        )}
      >
        <div className="flex h-16 items-center justify-between gap-2 px-4">
          <Link
            to="/app"
            onClick={() => setOpen(false)}
            aria-label="ClickAI overview"
            className={cn("rounded-md", collapsed && "lg:hidden")}
          >
            <Logo />
          </Link>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            className={cn(
              "hidden size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground lg:grid",
              collapsed && "mx-auto",
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
          <button
            type="button"
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent lg:hidden"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className={cn("px-3 pb-2", collapsed && "lg:hidden")}>
          <div className="rounded-xl border border-border bg-surface px-3 py-2.5">
            <p className="app-label text-[10px] font-medium text-muted-foreground">Workspace</p>
            <p className="mt-0.5 truncate text-sm font-semibold" title={businessName}>
              {businessName}
            </p>
            {ws?.subscription?.plan ? (
              <p className="truncate text-xs text-muted-foreground">{ws.subscription.plan} plan</p>
            ) : null}
          </div>
        </div>

        <nav aria-label="Dashboard" className="flex-1 overflow-y-auto px-3 py-3">
          {NAV.map((group, gi) => (
            <div key={group.group} className="mb-5">
              <p
                className={cn(
                  "px-2.5 pb-1.5 app-label text-[10px] font-medium text-muted-foreground/80",
                  collapsed && "lg:sr-only",
                )}
              >
                {group.group}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item, ii) => {
                  const active = isActive(item.to, pathname);
                  return (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        ref={gi === 0 && ii === 0 ? firstLink : undefined}
                        onClick={() => setOpen(false)}
                        aria-current={active ? "page" : undefined}
                        title={collapsed ? item.label : undefined}
                        className={cn(
                          "relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                          collapsed && "lg:justify-center lg:px-0",
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                        )}
                      >
                        {active ? (
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-1.5 -left-3 w-[3px] rounded-r-full bg-primary"
                          />
                        ) : null}
                        <item.icon className={cn("size-[18px] shrink-0", active && "text-info")} />
                        <span className={cn(collapsed && "lg:sr-only")}>{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className={cn("flex items-center gap-2", collapsed && "lg:flex-col")}>
            <span
              className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-info"
              aria-hidden="true"
            >
              {(user?.email ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <div className={cn("min-w-0 flex-1", collapsed && "lg:hidden")}>
              <p className="truncate text-xs font-medium">{user?.email}</p>
              <Link
                to="/app/settings"
                onClick={() => setOpen(false)}
                className="text-[11px] text-muted-foreground hover:text-info"
              >
                Account settings
              </Link>
            </div>
            <button
              type="button"
              onClick={async () => {
                await signOut();
                navigate({ to: "/auth" });
              }}
              aria-label="Sign out"
              title="Sign out"
              className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-destructive"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      {open ? (
        <div
          className="fixed inset-0 z-30 bg-foreground/40 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      ) : null}

      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col transition-[padding] duration-200 motion-reduce:transition-none",
          collapsed ? "lg:pl-[76px]" : "lg:pl-[264px]",
        )}
      >
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur lg:px-8">
          <button
            ref={menuButton}
            type="button"
            className="grid size-9 place-items-center rounded-md hover:bg-muted lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
          >
            <Menu className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
              <span className="hidden max-w-[200px] truncate text-muted-foreground sm:inline">
                {businessName}
              </span>
              {trail.map((crumb, i) => (
                <span key={`${crumb}-${i}`} className="flex min-w-0 items-center gap-1.5">
                  <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground/60 sm:block" />
                  <span
                    className={cn(
                      "truncate",
                      i === trail.length - 1 ? "font-semibold" : "text-muted-foreground",
                      i < trail.length - 1 && "max-sm:hidden",
                    )}
                    aria-current={i === trail.length - 1 ? "page" : undefined}
                  >
                    {crumb}
                  </span>
                </span>
              ))}
            </nav>
          </div>
          <Link to="/app/agent" className="hidden sm:block" aria-label="Receptionist status">
            <StatusPill tone={status.tone}>{`Receptionist · ${status.label}`}</StatusPill>
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-2.5 text-xs transition-colors hover:bg-muted"
              >
                <span className="grid size-7 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-info">
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
              <DropdownMenuItem onClick={() => navigate({ to: "/app/settings" })}>
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate({ to: "/app/billing" })}>
                Usage & billing
              </DropdownMenuItem>
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

        <main id="main" className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-8 lg:px-8">
          <div className="space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
