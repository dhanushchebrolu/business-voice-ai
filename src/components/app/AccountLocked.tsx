import { useQuery } from "@tanstack/react-query";
import { Lock, ShieldCheck, PhoneCall, MessageSquare, Bot, LogOut } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useCheckout } from "@/hooks/useCheckout";
import { pricingQuery, formatMoney } from "@/lib/pricing";
import { ACCOUNT_STATUS_LABEL, type AccountStatus } from "@/lib/workspace";
import { Logo, StatusPill } from "./primitives";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@tanstack/react-router";

const INCLUDED = [
  { icon: Bot, label: "AI receptionist configured for your business" },
  { icon: PhoneCall, label: "Inbound & outbound voice handling" },
  { icon: MessageSquare, label: "Website chat and WhatsApp channels" },
  { icon: ShieldCheck, label: "Calls, transcripts, leads and analytics" },
];

export function AccountLocked({ status }: { status: AccountStatus }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { data: pricing } = useQuery(pricingQuery());
  const { pay, pending } = useCheckout({ email: user?.email, name: user?.user_metadata?.["full_name"] as string });

  const setup = pricing?.["pricing.setup_fee"];
  const monthly = pricing?.["pricing.monthly_plan"];
  const phone = pricing?.["pricing.phone_service_fee"];
  const meta = ACCOUNT_STATUS_LABEL[status];

  const suspended = status === "suspended" || status === "cancelled";

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-4 lg:px-8">
        <Logo />
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

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <div className="rounded-xl border border-border bg-card p-6 lg:p-8">
          <div className="flex items-start justify-between gap-4">
            <div className="grid size-10 place-items-center rounded-lg border border-border bg-muted">
              <Lock className="size-4 text-muted-foreground" />
            </div>
            <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
          </div>

          <h1 className="mt-5 text-2xl font-semibold tracking-tight">
            {suspended ? "Your workspace is on hold" : "Activate your workspace"}
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            {suspended
              ? "Your account is currently suspended. Settle the outstanding amount to restore access — your configuration and data are preserved."
              : "Your dashboard unlocks as soon as the one-time setup payment is confirmed by our payment provider. Nothing is activated before that."}
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-primary/25 bg-primary/8 p-4">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {setup?.label ?? "Setup & configuration"}
              </p>
              <p className="mt-1 text-2xl font-semibold tabular">{formatMoney(setup?.amount, setup?.currency)}</p>
              <p className="mt-1 text-xs text-muted-foreground">One-time, due now</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Then monthly</p>
              <p className="mt-1 text-2xl font-semibold tabular">{formatMoney(monthly?.amount, monthly?.currency)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Phone &amp; AI Voice Service {formatMoney(phone?.amount, phone?.currency)}/month, billed separately
              </p>
            </div>
          </div>

          <ul className="mt-6 grid gap-2.5 sm:grid-cols-2">
            {INCLUDED.map((item) => (
              <li key={item.label} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <item.icon className="mt-0.5 size-4 shrink-0 text-primary" />
                {item.label}
              </li>
            ))}
          </ul>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button size="lg" disabled={pending !== null || !setup} onClick={() => pay("setup_fee")}>
              {pending === "setup_fee" ? "Opening secure checkout…" : `Pay ${formatMoney(setup?.amount, setup?.currency)} setup fee`}
            </Button>
            <p className="text-xs text-muted-foreground">
              Payments are processed securely. Access is granted only after server-side verification.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
