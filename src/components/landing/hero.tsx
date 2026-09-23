import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ParticleWave } from "./particle-wave";

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-[#0a0a0d] pb-28 pt-8 sm:pb-40">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 top-40 opacity-70">
        <ParticleWave tone="on-dark" variant="hero" className="h-full w-full" />
      </div>
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.06),transparent_60%)]"
        aria-hidden="true"
      />

      <div className="relative mx-auto max-w-[1440px] px-5 pt-16 text-center sm:px-8 sm:pt-24">
        <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.03] px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-white/60">
          White-label AI for business conversations
        </span>

        <h1 className="mx-auto mt-8 max-w-4xl font-serif text-[13vw] leading-[0.98] tracking-tight text-white sm:text-7xl lg:text-8xl">
          AI that talks.
          <br />
          AI that works.
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-base text-white/55 sm:text-lg">
          Turn every customer conversation into intelligent action.
        </p>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-white/40 sm:text-base">
          ClickAI gives businesses AI voice agents, WhatsApp automation, outbound calling and
          intelligent customer engagement — all from one platform.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link to="/auth" search={{ mode: "signup" }}>
            <Button size="lg" className="rounded-full px-6">
              Get Started <ArrowRight className="ml-1.5 size-4" />
            </Button>
          </Link>
          <Button
            size="lg"
            variant="outline"
            className="rounded-full border-white/20 bg-transparent px-6 text-white hover:bg-white/10"
            onClick={() => scrollToSection("voice-demo")}
          >
            Explore ClickAI
          </Button>
        </div>
      </div>
    </section>
  );
}
