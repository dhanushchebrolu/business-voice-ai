import { createFileRoute, Link } from "@tanstack/react-router";
import { LandingNav } from "@/components/landing/landing-nav";
import { LandingFooter } from "@/components/landing/landing-footer";
import { PageHero } from "@/components/landing/page-hero";
import { FinalCta } from "@/components/landing/final-cta";
import {
  INTEGRATION_GROUPS as GROUPS,
  type IntegrationStatus as Status,
} from "@/lib/integrations-catalog";

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

const STYLE: Record<Status, string> = {
  Available: "text-emerald-700",
  "In development": "text-amber-700",
  "Custom integration": "text-slate-500",
};

function Integrations() {
  return (
    <div className="theme-light min-h-screen bg-white text-slate-900">
      <LandingNav />
      <PageHero
        eyebrow="Integrations"
        title="What ClickAI connects to"
        intro="Available means you can connect it from your dashboard today. In development is not live yet. Custom integration is built for your project and quoted separately."
      />
      <main className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8 sm:py-24">
        <div className="grid gap-x-16 gap-y-12 md:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.heading} aria-labelledby={`int-${g.heading}`}>
              <h2 id={`int-${g.heading}`} className="font-serif text-2xl tracking-tight">
                {g.heading}
              </h2>
              <ul className="mt-4">
                {g.items.map((it) => (
                  <li
                    key={it.name}
                    className="flex items-center justify-between gap-4 border-t border-slate-200 py-3 text-sm"
                  >
                    <span className="font-medium text-slate-900">{it.name}</span>
                    <span className={`shrink-0 text-xs font-medium ${STYLE[it.status]}`}>
                      {it.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-14 text-sm text-slate-600">
          Using something not listed?{" "}
          <Link to="/contact" className="font-medium text-violet-600 underline underline-offset-4">
            Tell us and we will scope it.
          </Link>
        </p>
      </main>
      <FinalCta />
      <LandingFooter />
    </div>
  );
}
