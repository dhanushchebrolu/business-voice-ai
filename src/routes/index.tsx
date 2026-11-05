import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { CLICKAI_BRAND, CLICKAI_LEGAL_NAME, CLICKAI_ADDRESS_JSON_LD } from "@/lib/company-info";
import { Hero } from "@/components/landing/hero";
import { VxNav } from "@/components/landing/home/vx-nav";
import { ProductVisuals } from "@/components/landing/home/product-visuals";
import { THEME_INIT } from "@/components/landing/home/theme";
import { VxFooter } from "@/components/landing/home/vx-footer";
import { ConnectsWith, Gap, Loop } from "@/components/landing/home/sections-a";
import { Capabilities, Console, Integrations } from "@/components/landing/home/sections-b";
import { Controls, Cta, Faq, Pricing, Status, Today } from "@/components/landing/home/sections-c";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ClickAI — AI Employees for Your Business, 24/7" },
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
    scripts: [{ children: THEME_INIT }],
    links: [
      { rel: "canonical", href: "https://clickai.in/" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap",
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
    <div className="vx theme-light min-h-screen">
      {/* Static, hardcoded JSON (ORGANIZATION_JSON_LD above) — never user input. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION_JSON_LD) }}
      />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:bg-white focus:px-4 focus:py-2 focus:font-vmono focus:text-sm focus:text-[var(--vx-ink)]"
      >
        Skip to main content
      </a>
      <VxNav />
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero />
        <ProductVisuals />
        <ConnectsWith />
        <Gap />
        <Loop />
        <Capabilities />
        <Console />
        <Integrations />
        <Controls />
        <Today />
        <Status />
        <Pricing />
        <Faq />
        <Cta />
      </main>
      <VxFooter />
    </div>
  );
}
