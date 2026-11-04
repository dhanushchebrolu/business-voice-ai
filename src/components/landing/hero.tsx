import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { HeroOrb } from "./hero-orb";

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Only integrations that can be connected from the dashboard today (see /integrations). */
const WORKS_WITH = [
  "WhatsApp Business Platform",
  "Voice telephony",
  "Google Calendar",
  "Instagram",
  "Razorpay",
];

/**
 * Dark hero: positioning and CTAs on the left, the live website assistant on
 * the right, set directly on the dark surface (no card) with concentric rings
 * and a single glow behind the orb. "Book a Demo" links to the real /contact
 * route; "Explore Products" scrolls to the #products showcase below.
 */
export function Hero() {
  return (
    <section className="relative isolate overflow-hidden bg-ink-950 text-white">
      {/* Fine grid, faded out toward the edges; decorative only. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 opacity-[0.07] [background-image:linear-gradient(white_1px,transparent_1px),linear-gradient(90deg,white_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_70%_60%_at_65%_40%,black,transparent)]"
      />
      {/* The one glow: sits behind the assistant to anchor it. */}
      <div
        aria-hidden="true"
        className="absolute right-[-10%] top-[8%] -z-10 h-[560px] w-[560px] rounded-full bg-[radial-gradient(closest-side,rgba(37,99,235,0.35),rgba(124,92,255,0.12)_60%,transparent)]"
      />

      <div className="mx-auto grid max-w-[1200px] gap-14 px-5 pb-16 pt-14 sm:px-8 sm:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-10 lg:pb-24 lg:pt-24">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-sky-300">
            Voice · WhatsApp · Appointments · Workflows
          </p>
          <h1 className="mt-5 font-serif text-[clamp(2.75rem,7vw,4.75rem)] leading-[1.02] tracking-tight">
            AI Employees for Your Business,{" "}
            <span className="bg-gradient-to-r from-sky-300 to-violet-300 bg-clip-text text-transparent">
              24/7
            </span>
          </h1>
          <p className="mt-6 max-w-lg text-base leading-relaxed text-slate-300 sm:text-lg">
            Automate customer conversations, answer business calls, manage appointments and
            streamline everyday workflows with AI employees built around your business.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link to="/contact">
              <Button
                size="lg"
                className="h-12 rounded-full bg-violet-600 px-7 text-white shadow-[0_8px_30px_-8px_rgba(37,99,235,0.7)] transition-[transform,background-color] hover:bg-violet-500 active:scale-[0.98]"
              >
                Book a Demo
              </Button>
            </Link>
            <Button
              size="lg"
              variant="outline"
              onClick={() => scrollToSection("products")}
              className="h-12 rounded-full border-white/25 bg-transparent px-7 text-white transition-[transform,background-color] hover:bg-white/10 hover:text-white active:scale-[0.98]"
            >
              Explore Products
            </Button>
          </div>

          <dl className="mt-12 max-w-lg border-t border-white/10 pt-6">
            <dt className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400">
              Connects with
            </dt>
            <dd className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-slate-300">
              {WORKS_WITH.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </dd>
          </dl>
        </div>

        <HeroOrb />
      </div>
    </section>
  );
}
