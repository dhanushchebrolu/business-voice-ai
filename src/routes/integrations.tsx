import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { LandingNav } from "@/components/landing/landing-nav";
import { LandingFooter } from "@/components/landing/landing-footer";

const TITLE = "Integrations | ClickAI";
const DESC =
  "What ClickAI connects to today: WhatsApp Business, voice telephony, Google Calendar, Instagram and Razorpay, plus what is planned or built as custom work.";

export const Route = createFileRoute("/integrations")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:url", content: "https://clickai.in/integrations" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/integrations" }],
  }),
  component: Integrations,
});

type Status = "Available" | "In development" | "Custom integration";

/**
 * "Available" is limited to what has a connect flow in the dashboard
 * (see IntegrationsSection and app.integrations): WhatsApp Business,
 * voice telephony, website chat, Instagram, Google Calendar and Razorpay.
 * Everything else is not live; an existing public API does not make it so.
 */
const GROUPS: { heading: string; items: { name: string; status: Status }[] }[] = [
  {
    heading: "Communication",
    items: [
      { name: "WhatsApp Business", status: "Available" },
      { name: "Voice telephony", status: "Available" },
      { name: "Website chat", status: "Available" },
      { name: "Instagram", status: "Available" },
      { name: "SMS", status: "In development" },
      { name: "Email", status: "In development" },
    ],
  },
  {
    heading: "Calendars",
    items: [
      { name: "Google Calendar", status: "Available" },
      { name: "Outlook / Microsoft 365", status: "Custom integration" },
    ],
  },
  {
    heading: "CRM",
    items: [
      { name: "HubSpot", status: "In development" },
      { name: "Zoho CRM", status: "In development" },
      { name: "Salesforce", status: "Custom integration" },
      { name: "Pipedrive", status: "Custom integration" },
    ],
  },
  { heading: "Payments", items: [{ name: "Razorpay", status: "Available" }] },
  {
    heading: "Databases and e-commerce",
    items: [
      { name: "Your database", status: "Custom integration" },
      { name: "Shopify", status: "In development" },
      { name: "WooCommerce", status: "In development" },
    ],
  },
  {
    heading: "Automation and APIs",
    items: [
      { name: "Webhooks", status: "Custom integration" },
      { name: "Your own APIs", status: "Custom integration" },
    ],
  },
];

const STYLE: Record<Status, string> = {
  Available: "border-emerald-200 bg-emerald-50 text-emerald-700",
  "In development": "border-amber-200 bg-amber-50 text-amber-700",
  "Custom integration": "border-slate-200 bg-slate-50 text-slate-600",
};

function Integrations() {
  return (
    <div className="theme-light min-h-screen bg-white text-slate-900">
      <LandingNav />
      <main className="mx-auto max-w-[1100px] px-5 py-16 sm:px-8 sm:py-20">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-violet-600">
          Integrations
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
          What ClickAI connects to
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-slate-600">
          <strong className="font-medium text-slate-900">Available</strong> means you can connect it
          from your dashboard today. <strong className="font-medium">In development</strong> is not
          live yet. <strong className="font-medium">Custom integration</strong> is built for your
          project and quoted separately.
        </p>

        <div className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
          {GROUPS.map((g) => (
            <section key={g.heading} aria-labelledby={`int-${g.heading}`}>
              <h2
                id={`int-${g.heading}`}
                className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500"
              >
                {g.heading}
              </h2>
              <ul className="mt-4 space-y-2">
                {g.items.map((it) => (
                  <li
                    key={it.name}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-4 py-2.5"
                  >
                    <span className="text-sm text-slate-800">{it.name}</span>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${STYLE[it.status]}`}
                    >
                      {it.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="mt-14 flex flex-wrap items-center gap-4">
          <Link to="/contact">
            <Button size="lg" className="rounded-full bg-violet-600 px-6 text-white">
              Ask about an integration
            </Button>
          </Link>
          <span className="text-sm text-slate-500">
            Using something not listed? Tell us and we will scope it.
          </span>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
