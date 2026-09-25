import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { HubGraphic } from "./hub-graphic";

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Full-bleed dark hero: left-aligned headline/copy/CTAs, right-aligned
 * hub-and-spoke integration graphic (hub-graphic.tsx) — matching the
 * requested reference layout's composition (badge → headline → subtext →
 * two buttons on the left, an animated node graphic on the right), built
 * as original ClickAI artwork and copy rather than any copied asset or
 * marketing text.
 */
export function Hero() {
  return (
    <section className="relative overflow-hidden bg-[#0a0a0d]">
      <div
        className="pointer-events-none absolute inset-0 grid-noise opacity-[0.35]"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -left-1/4 top-0 h-[600px] w-[600px] rounded-full bg-[#7fbf9f]/5 blur-[120px]"
        aria-hidden="true"
      />

      <div className="relative mx-auto grid max-w-[1400px] gap-16 px-5 pb-20 pt-14 sm:px-8 sm:pb-28 sm:pt-20 lg:grid-cols-2 lg:items-center lg:gap-8 lg:py-28">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/50">
            One AI Agent. Every Channel.
          </p>
          <h1 className="mt-5 font-serif text-[13vw] leading-[1.04] tracking-tight text-white sm:text-6xl lg:text-[64px]">
            AI Employees,
            <br />
            Unleashed.
          </h1>
          <p className="mt-6 max-w-md text-sm leading-relaxed text-white/55 sm:text-base">
            Automate sales, reception, bookings and support — effortlessly, across voice, WhatsApp,
            Instagram and your website, all from one shared AI brain.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button
              size="lg"
              onClick={() => scrollToSection("integrations")}
              className="rounded-full bg-white px-6 text-[#0a0a0d] hover:bg-white/90"
            >
              Explore Integrations
            </Button>
            <Link to="/contact">
              <Button
                size="lg"
                variant="outline"
                className="rounded-full border-white/25 bg-transparent px-6 text-white hover:bg-white/10"
              >
                Contact
              </Button>
            </Link>
          </div>

          <p className="mt-12 text-xs text-white/35">
            Built for growing businesses across every industry.
          </p>
        </div>

        <div className="lg:pl-8">
          <HubGraphic />
        </div>
      </div>
    </section>
  );
}
