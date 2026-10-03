import { Link } from "@tanstack/react-router";
import { Sparkles, PhoneCall, Users, AudioLines } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeroVoiceDemo } from "./hero-voice-demo";

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const FEATURES = [
  { label: "Live Call Handling", icon: PhoneCall },
  { label: "Human Handoff", icon: Users },
  { label: "Natural Voice", icon: AudioLines },
];

/**
 * White + violet hero: left-aligned headline/copy/two CTAs/feature strip,
 * right-aligned real audio player (hero-voice-demo.tsx) a visitor can
 * actually press play on — built as original ClickAI artwork and copy.
 *
 * "Book a Demo" links to the real /contact route (same CTA final-cta.tsx
 * uses); "Test Agent" scrolls to the real #voice-demo section further down
 * the page (feature-showcase.tsx) rather than linking to the authenticated,
 * per-business testAgentText dashboard feature, which requires a signed-in
 * account and an existing agent config neither of which a visitor has yet.
 */
export function Hero() {
  return (
    <section className="relative overflow-hidden bg-white">
      <div
        className="pointer-events-none absolute inset-0 grid-noise opacity-40"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -left-1/4 top-0 h-[600px] w-[600px] rounded-full bg-violet-100/60 blur-[120px]"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -right-1/4 bottom-0 h-[500px] w-[500px] rounded-full bg-sky-50 blur-[120px]"
        aria-hidden="true"
      />

      <div className="relative mx-auto grid max-w-[1400px] gap-16 px-5 pb-20 pt-14 sm:px-8 sm:pb-28 sm:pt-20 lg:grid-cols-2 lg:items-center lg:gap-8 lg:py-28">
        <div>
          <p className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-violet-700">
            <Sparkles className="size-3" /> One AI Agent. Every Channel.
          </p>
          <h1 className="mt-5 font-serif text-[12vw] leading-[1.08] tracking-tight sm:text-6xl lg:text-[60px]">
            <span className="block text-slate-900">Answer every customer,</span>
            <span className="block text-slate-900">never miss a call or lead,</span>
            <span className="block text-slate-400">completely hands-free.</span>
          </h1>
          <p className="mt-6 max-w-md text-sm leading-relaxed text-slate-500 sm:text-base">
            Automate sales, reception, bookings and support — effortlessly, across voice, WhatsApp,
            Instagram and your website, all from one shared AI brain.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link to="/contact">
              <Button
                size="lg"
                className="rounded-full bg-violet-600 px-6 text-white hover:bg-violet-700"
              >
                Book a Demo
              </Button>
            </Link>
            <Button
              size="lg"
              variant="outline"
              onClick={() => scrollToSection("voice-demo")}
              className="rounded-full border-slate-300 bg-transparent px-6 text-slate-900 hover:bg-slate-50"
            >
              Test Agent
            </Button>
          </div>

          <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2">
            {FEATURES.map(({ label, icon: Icon }) => (
              <span key={label} className="flex items-center gap-1.5 text-xs text-slate-500">
                <Icon className="size-3.5 text-violet-600" /> {label}
              </span>
            ))}
          </div>

          <p className="mt-10 text-xs text-slate-400">
            Built for growing businesses across every industry.
          </p>
        </div>

        <div className="lg:pl-8">
          <HeroVoiceDemo />
        </div>
      </div>
    </section>
  );
}
