import { createFileRoute } from "@tanstack/react-router";
import { LandingNav } from "@/components/landing/landing-nav";
import { Hero } from "@/components/landing/hero";
import { ValuePropositions } from "@/components/landing/value-propositions";
import { IndustriesSection } from "@/components/landing/industries-section";
import { ChannelsSection } from "@/components/landing/channels-section";
import { FeatureShowcase } from "@/components/landing/feature-showcase";
import { PaymentFeatureSection } from "@/components/landing/payment-feature-section";
import { MetricsSection } from "@/components/landing/metrics-section";
import { IntegrationsSection } from "@/components/landing/integrations-section";
import { FinalCta } from "@/components/landing/final-cta";
import { LandingFooter } from "@/components/landing/landing-footer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ClickAI — AI employees for sales, reception, bookings and support" },
      {
        name: "description",
        content:
          "ClickAI gives businesses AI employees that answer customers, capture leads, book appointments, process orders, collect payments and provide 24/7 support across voice and WhatsApp.",
      },
      {
        property: "og:title",
        content: "ClickAI — Automate. Engage. Grow.",
      },
      {
        property: "og:description",
        content:
          "AI-powered business solutions: AI Sales Executive, AI Receptionist, AI Booking & Order Agent and AI Customer Care, all on one white-label platform.",
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
      <IndustriesSection />
      <ChannelsSection />
      <FeatureShowcase />
      <PaymentFeatureSection />
      <IntegrationsSection />
      <MetricsSection />
      <FinalCta />
      <LandingFooter />
    </div>
  );
}
