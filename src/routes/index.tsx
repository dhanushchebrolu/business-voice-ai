import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { CLICKAI_BRAND, CLICKAI_LEGAL_NAME, CLICKAI_ADDRESS_JSON_LD } from "@/lib/company-info";
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
      { rel: "canonical", href: "https://clickai.in/" },
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

/**
 * Organization structured data — only verified, real identity fields (name,
 * legal name, url, logo, contact point). Deliberately omits founding date,
 * employee count, social profiles, and ratings/awards: none of those are
 * verified facts available in this codebase, and inventing them would be a
 * fabricated claim, not a technical default.
 */
const ORGANIZATION_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: CLICKAI_BRAND,
  legalName: CLICKAI_LEGAL_NAME,
  url: "https://clickai.in",
  logo: "https://clickai.in/favicon.ico",
  email: "hello@clickai.in",
  telephone: "+91-76600-01231",
  address: CLICKAI_ADDRESS_JSON_LD,
  contactPoint: [
    {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: "hello@clickai.in",
      telephone: "+91-76600-01231",
      areaServed: "IN",
    },
  ],
};

/**
 * Lets a visitor arrive at e.g. /#industries from anywhere on the site
 * (LandingFooter's cross-page section links use `Link to="/" hash={id}`)
 * and land scrolled to that real section, the same way clicking the
 * equivalent in-page footer/nav link already does on the homepage itself.
 */
function useScrollToHashOnMount() {
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
}

function Landing() {
  useScrollToHashOnMount();
  return (
    <div className="theme-light min-h-screen bg-white">
      {/* Static, hardcoded JSON (ORGANIZATION_JSON_LD above) — never user input. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION_JSON_LD) }}
      />
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
