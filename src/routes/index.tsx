import { createFileRoute } from "@tanstack/react-router";
import { LandingNav } from "@/components/landing/landing-nav";
import { Hero } from "@/components/landing/hero";
import { ValuePropositions } from "@/components/landing/value-propositions";
import { FeatureShowcase } from "@/components/landing/feature-showcase";
import { MetricsSection } from "@/components/landing/metrics-section";
import { IntegrationsSection } from "@/components/landing/integrations-section";
import { FinalCta } from "@/components/landing/final-cta";
import { LandingFooter } from "@/components/landing/landing-footer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ClickAI — AI voice agents, WhatsApp AI and business automation" },
      {
        name: "description",
        content:
          "ClickAI gives businesses AI voice agents, WhatsApp automation, outbound calling and intelligent customer engagement — all from one white-label platform.",
      },
      {
        property: "og:title",
        content: "ClickAI — AI that talks. AI that works.",
      },
      {
        property: "og:description",
        content:
          "Turn every customer conversation into intelligent action with AI voice agents, WhatsApp AI and business automation.",
      },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-[#0a0a0d]">
      <LandingNav />
      <Hero />
      <ValuePropositions />
      <FeatureShowcase />
      <MetricsSection />
      <IntegrationsSection />
      <FinalCta />
      <LandingFooter />
    </div>
  );
}
