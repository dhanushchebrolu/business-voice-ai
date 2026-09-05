import { useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Users,
  IndianRupee,
  SlidersHorizontal,
  ScrollText,
  ShieldCheck,
  Receipt,
  Wallet,
  RotateCcw,
  TrendingUp,
  Menu,
  X,
  LogOut,
  Phone,
  PhoneCall,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { StatusPill } from "@/components/app/primitives";

const NAV: {
  to:
    | "/admin"
    | "/admin/customers"
    | "/admin/numbers"
    | "/admin/calls"
    | "/admin/billing"
    | "/admin/wallets"
    | "/admin/refunds"
    | "/admin/margins"
    | "/admin/pricing"
    | "/admin/settings"
    | "/admin/website-ai"
    | "/admin/team"
    | "/admin/audit";
  label: string;
  icon: typeof Users;
  exact?: boolean;
}[] = [
  { to: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { to: "/admin/customers", label: "Customers", icon: Users },
  { to: "/admin/numbers", label: "Phone numbers", icon: Phone },
  { to: "/admin/calls", label: "Calls", icon: PhoneCall },
  { to: "/admin/billing", label: "Billing", icon: Receipt },
  { to: "/admin/wallets", label: "Wallets", icon: Wallet },
  { to: "/admin/refunds", label: "Refunds", icon: RotateCcw },
  { to: "/admin/margins", label: "Profit & margin", icon: TrendingUp },
  { to: "/admin/pricing", label: "Pricing", icon: IndianRupee },
  { to: "/admin/settings", label: "Platform settings", icon: SlidersHorizontal },
  { to: "/admin/website-ai", label: "Website AI", icon: Bot },
  { to: "/admin/team", label: "Admin team", icon: ShieldCheck },
  { to: "/admin/audit", label: "Audit logs", icon: ScrollText },
];

export function AdminShell({
  children,
  role,
  email,
}: {
  children: ReactNode;
  role: string;
  email: string | null;
}) {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const nav = (
    <nav className="flex flex-col gap-0.5 p-3">
      {NAV.map((item) => {
        const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={() => setOpen(false)}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-primary/12 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <span className="grid size-7 place-items-center rounded-md bg-foreground text-background text-[13px] font-bold">
            V
          </span>
          <div className="leading-tight">
            <p className="text-[13px] font-semibold">Vaani Control</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Platform admin
            </p>
          </div>
        </div>
        {nav}
        <div className="mt-auto border-t border-border p-3">
          <StatusPill tone="accent">{role.replace("_", " ")}</StatusPill>
          <p className="mt-2 truncate text-xs text-muted-foreground">{email}</p>
          <div className="mt-2 flex flex-col gap-1.5">
            <Button size="sm" variant="outline" onClick={() => navigate({ to: "/app" })}>
              Customer app
            </Button>
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
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border px-4 lg:hidden">
          <span className="text-sm font-semibold">Vaani Control</span>
          <Button size="icon" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </Button>
        </header>
        {open ? <div className="border-b border-border lg:hidden">{nav}</div> : null}
        <main className="min-w-0 flex-1 px-4 py-6 lg:px-8 lg:py-8">
          <div className="mx-auto max-w-7xl space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
