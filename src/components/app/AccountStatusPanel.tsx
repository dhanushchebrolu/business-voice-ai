import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { PhoneCall, MessageSquare, Bot, MessagesSquare } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useCheckout } from "@/hooks/useCheckout";
import { pricingQuery, formatMoney } from "@/lib/pricing";
import { getBillingBypassStatus } from "@/lib/billing.functions";
import {
  ACCOUNT_STATUS_LABEL,
  workspaceQuery,
  numbersQuery,
  type AccountStatus,
} from "@/lib/workspace";
import { SectionCard, StatusPill } from "./primitives";
import { Button } from "@/components/ui/button";

type ChannelTone = "live" | "idle";

/**
 * Account, subscription and channel state. Every value comes from real
 * records — a channel is only "Active" when it is genuinely connected.
 */
export function AccountStatusPanel() {
  const { user } = useAuth();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const { data: numbers } = useQuery(numbersQuery(ws?.organization?.id));
  const { data: pricing } = useQuery(pricingQuery());
  const { pay, pending } = useCheckout({ email: user?.email });

  const getBypassStatus = useServerFn(getBillingBypassStatus);
  const { data: bypass } = useQuery({
    queryKey: ["billing-bypass-status"],
    queryFn: () => getBypassStatus(),
    staleTime: 30_000,
  });
  // TEMPORARY BACKEND TESTING BYPASS — REMOVE BEFORE PRODUCTION BILLING ENABLEMENT
  // Mirrors BYPASS_BILLING_GATES (see getBillingBypassStatus/feature-gate.server.ts).
  // Hides payment UI only — never affects the channel cards below, which
  // reflect genuine setup completeness (published agent, active number),
  // not payment/entitlement state.
  const billingBypassed = bypass?.bypassed === true;

  const status = (ws?.organization?.account_status ?? "payment_required") as AccountStatus;
  const meta = ACCOUNT_STATUS_LABEL[status];
  const nextBilling = ws?.organization?.next_billing_at
    ? new Date(ws.organization.next_billing_at)
    : null;
  const activeNumber = numbers?.find((n) => n.status === "active");
  const voiceReady = (ws?.agent?.active_version ?? 0) > 0;

  const channels: {
    icon: typeof PhoneCall;
    label: string;
    ok: boolean;
    tone: ChannelTone;
    hint: string;
  }[] = [
    {
      icon: PhoneCall,
      label: "Phone",
      ok: Boolean(activeNumber),
      tone: activeNumber ? "live" : "idle",
      hint: activeNumber?.e164 ?? "Setup required",
    },
    {
      icon: Bot,
      label: "Voice agent",
      ok: voiceReady,
      tone: voiceReady ? "live" : "idle",
      hint: voiceReady ? "Published" : "Not published",
    },
    { icon: MessageSquare, label: "WhatsApp", ok: false, tone: "idle", hint: "Setup required" },
    {
      icon: MessagesSquare,
      label: "Website chatbot",
      ok: false,
      tone: "idle",
      hint: "Setup required",
    },
  ];

  const monthly = pricing?.["pricing.monthly_plan"];
  const setup = pricing?.["pricing.setup_fee"];
  const needsSetupPayment = !ws?.organization?.setup_paid_at;

  return (
    <SectionCard
      title="Account & services"
      description="Your subscription state and which customer channels are actually live."
      actions={
        billingBypassed && status === "payment_required" ? undefined : (
          <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
        )
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <dl className={billingBypassed ? "grid gap-4" : "grid gap-4 sm:grid-cols-3"}>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Plan
            </dt>
            <dd className="mt-1 text-sm font-medium">
              {ws?.subscription?.plan ?? "—"}
              {!billingBypassed && monthly ? (
                <span className="ml-1.5 text-muted-foreground">
                  {formatMoney(monthly.amount, monthly.currency)}/mo
                </span>
              ) : null}
            </dd>
          </div>
          {billingBypassed ? null : (
            <>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Setup payment
                </dt>
                <dd className="mt-1 text-sm font-medium">
                  {ws?.organization?.setup_paid_at
                    ? `Paid ${new Date(ws.organization.setup_paid_at).toLocaleDateString()}`
                    : formatMoney(setup?.amount, setup?.currency) + " due"}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Next billing date
                </dt>
                <dd className="mt-1 text-sm font-medium tabular">
                  {nextBilling ? nextBilling.toLocaleDateString() : "—"}
                </dd>
              </div>
            </>
          )}
        </dl>

        {billingBypassed ? null : (
          <div className="flex flex-wrap gap-2">
            {needsSetupPayment ? (
              <Button size="sm" disabled={pending !== null} onClick={() => pay("setup_fee")}>
                {pending === "setup_fee" ? "Opening…" : "Pay setup fee"}
              </Button>
            ) : (
              <Button size="sm" disabled={pending !== null} onClick={() => pay("monthly_plan")}>
                {pending === "monthly_plan" ? "Opening…" : "Pay monthly subscription"}
              </Button>
            )}
            <Link to="/app/billing">
              <Button size="sm" variant="secondary">
                Billing
              </Button>
            </Link>
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {channels.map((c) => (
          <div
            key={c.label}
            className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5"
          >
            <c.icon className={c.ok ? "size-4 text-primary" : "size-4 text-muted-foreground"} />
            <div className="min-w-0">
              <p className="text-sm font-medium">{c.label}</p>
              <p className="truncate text-xs text-muted-foreground">{c.hint}</p>
            </div>
            <StatusPill tone={c.tone} dot={false} className="ml-auto">
              {c.ok ? "Active" : "Setup"}
            </StatusPill>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
