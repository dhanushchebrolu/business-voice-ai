import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ParticleWave } from "./particle-wave";

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Matches the reference's hero composition: a dark headline block that
 * dissolves into white through the dotted wave, then a white illustration
 * block beneath it showing an abstract "assistant" silhouette flanked by
 * two floating product-UI cards. The silhouette and cards are original
 * artwork built for ClickAI (a generic bust silhouette + a mocked-up
 * Create Agent panel and a WhatsApp-style reply preview) — not a copy of
 * any reference image — and are purely decorative (aria-hidden), so they
 * never masquerade as clickable controls.
 */
export function Hero() {
  return (
    <>
      <section className="relative overflow-hidden bg-[#0a0a0d]">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#0a0a0d] via-[#0a0a0d] to-white" />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-72 sm:h-96"
          style={{
            maskImage: "linear-gradient(to bottom, transparent, black 75%)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent, black 75%)",
          }}
        >
          <ParticleWave tone="on-dark" variant="hero" className="h-full w-full" />
        </div>

        <div className="relative mx-auto max-w-3xl px-5 pb-16 pt-10 text-center sm:px-8 sm:pb-24 sm:pt-16">
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/50">
            AI-Powered Business Solutions
          </p>
          <h1 className="mx-auto mt-4 font-serif text-[10vw] leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-6xl">
            Automate. Engage. Grow.
          </h1>
          <p className="mx-auto mt-5 max-w-md text-sm leading-relaxed text-white/55 sm:text-base">
            AI employees that answer customers, capture leads, book appointments, process orders,
            collect payments and provide 24/7 support.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to="/auth" search={{ mode: "signup" }}>
              <Button
                size="lg"
                className="rounded-full bg-white px-6 text-[#0a0a0d] hover:bg-white/90"
              >
                Get Started with ClickAI
              </Button>
            </Link>
            <Button
              size="lg"
              variant="outline"
              onClick={() => scrollToSection("value-propositions")}
              className="rounded-full border-white/25 bg-transparent px-6 text-white hover:bg-white/10"
            >
              Explore AI Employees
            </Button>
          </div>
        </div>
      </section>

      <section className="relative -mt-1 bg-white pb-20 sm:pb-28">
        <div
          className="relative mx-auto flex max-w-md items-end justify-center pt-4"
          aria-hidden="true"
        >
          <svg viewBox="0 0 240 320" className="h-[260px] w-auto sm:h-[340px]">
            <defs>
              <linearGradient id="hero-bust" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1c1c22" />
                <stop offset="100%" stopColor="#050506" />
              </linearGradient>
            </defs>
            <path
              d="M10 320 C10 228 55 192 120 192 C185 192 230 228 230 320 Z"
              fill="url(#hero-bust)"
            />
            <rect x="98" y="150" width="44" height="58" rx="12" fill="url(#hero-bust)" />
            <path
              d="M120 40 C160 40 182 68 182 105 C182 112 190 114 196 120 C200 124 198 130 190 132 C192 140 186 148 176 148 C172 162 158 172 140 172 C104 172 78 146 78 108 C78 68 96 40 120 40 Z"
              fill="url(#hero-bust)"
            />
          </svg>

          <div className="absolute left-[-8px] top-8 w-40 rounded-2xl border border-[#14141a]/10 bg-white p-4 shadow-[0_24px_48px_-20px_rgba(20,20,26,0.25)] sm:left-[-24px] sm:top-16 sm:w-44">
            <p className="text-xs font-semibold text-[#14141a]">Create Agent</p>
            <div className="mt-3 flex items-center justify-between rounded-lg border border-[#14141a]/10 px-2.5 py-1.5 text-[10px] text-[#14141a]/55">
              Select model
              <span aria-hidden="true">⌄</span>
            </div>
            <div className="mt-2 rounded-lg bg-[#14141a] py-1.5 text-center text-[10px] font-medium text-white">
              Deploy
            </div>
          </div>

          <div className="absolute right-[-8px] top-2 w-48 rounded-2xl border border-[#14141a]/10 bg-white p-3 shadow-[0_24px_48px_-20px_rgba(20,20,26,0.25)] sm:right-[-24px] sm:top-6 sm:w-56">
            <div className="rounded-xl bg-[#f6f3ee] px-3 py-2 text-[10px] leading-relaxed text-[#14141a]/70">
              Where do I set up a new WhatsApp agent?
            </div>
            <div className="mt-2 rounded-xl bg-[#14141a] px-3 py-2 text-[10px] leading-relaxed text-white">
              Go to Agents → New WhatsApp Agent, then connect your number.
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
