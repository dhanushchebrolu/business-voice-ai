import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, ArrowLeft } from "lucide-react";
import { Logo, StatusPill } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — Vaani AI receptionist" },
      { name: "description", content: "Simple monthly plans for AI phone receptionists, with usage-based call minutes." },
      { property: "og:title", content: "Pricing — Vaani AI receptionist" },
      { property: "og:description", content: "Starter, Professional and Business plans with included call minutes." },
    ],
  }),
  component: Pricing,
});

export const PLANS = [
  {
    id: "starter",
    name: "Starter",
    price: 2999,
    blurb: "A single location getting its first AI receptionist.",
    features: ["1 business profile", "1 phone number", "500 call minutes / month", "Calls, transcripts & leads", "Email support"],
  },
  {
    id: "professional",
    name: "Professional",
    price: 7999,
    blurb: "Growing teams that live on the phone.",
    features: [
      "1 business profile",
      "3 phone numbers",
      "2,000 call minutes / month",
      "Multilingual agent + custom voice",
      "Knowledge documents",
      "Priority support",
    ],
    highlighted: true,
  },
  {
    id: "business",
    name: "Business",
    price: 19999,
    blurb: "Multi-location operations with outbound campaigns.",
    features: [
      "Multiple locations",
      "10 phone numbers",
      "6,000 call minutes / month",
      "Outbound campaigns",
      "Team roles & audit log",
      "Dedicated onboarding",
    ],
  },
];

function Pricing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <Link to="/">
            <Logo />
          </Link>
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> Home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-16">
        <StatusPill tone="accent">Plans</StatusPill>
        <h1 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">Pay for a receptionist, not a platform</h1>
        <p className="mt-3 max-w-xl text-sm text-muted-foreground">
          Every plan starts with a 14-day trial. Call minutes beyond your plan are billed from your wallet at your
          workspace rate.
        </p>

        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className={
                plan.highlighted
                  ? "panel relative border-primary/40 p-6 shadow-[var(--shadow-panel)]"
                  : "panel p-6"
              }
            >
              {plan.highlighted ? (
                <span className="absolute -top-2.5 left-6">
                  <StatusPill tone="accent" dot={false}>
                    Most popular
                  </StatusPill>
                </span>
              ) : null}
              <h2 className="text-sm font-semibold">{plan.name}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{plan.blurb}</p>
              <p className="mt-5 text-3xl font-semibold tabular">
                ₹{plan.price.toLocaleString("en-IN")}
                <span className="ml-1 text-sm font-normal text-muted-foreground">/ month</span>
              </p>
              <Link to="/auth" search={{ mode: "signup", plan: plan.id }} className="mt-5 block">
                <Button className="w-full" variant={plan.highlighted ? "default" : "secondary"}>
                  Start 14-day trial
                </Button>
              </Link>
              <ul className="mt-6 space-y-2.5">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-10 rounded-lg border border-border bg-surface/50 p-4 text-xs text-muted-foreground">
          Card payments are not switched on for this workspace yet. Trials start immediately and the billing screen will
          show a clear “payment provider not connected” state until Razorpay is configured.
        </p>
      </main>
    </div>
  );
}
