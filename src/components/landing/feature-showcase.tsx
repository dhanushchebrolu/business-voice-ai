import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ParticleWave } from "./particle-wave";
import { VoiceDemo } from "./voice-demo";

export function FeatureShowcase() {
  return (
    <section
      id="feature-showcase"
      className="border-t border-[#14141a]/10 bg-[#f6f3ee] py-24 sm:py-32"
    >
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <h2 className="max-w-xl font-serif text-4xl leading-[1.1] text-[#14141a] sm:text-5xl">
            Voice and WhatsApp AI, working the same conversation.
          </h2>
          <Link to="/contact">
            <Button
              variant="outline"
              className="rounded-full border-[#14141a]/20 bg-transparent text-[#14141a] hover:bg-[#14141a]/5"
            >
              Explore All
            </Button>
          </Link>
        </div>

        <div className="mt-14 grid gap-6 lg:grid-cols-2">
          <div className="relative overflow-hidden rounded-2xl bg-[#eef1f6] p-6">
            <div className="pointer-events-none absolute inset-0 opacity-70">
              <ParticleWave tone="on-light" variant="subtle" className="h-full w-full" />
            </div>
            <div className="relative">
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#14141a]/40">
                [1/2]
              </p>
              <h3 className="mt-3 text-xl font-semibold tracking-tight text-[#14141a]">
                WhatsApp AI
              </h3>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-[#14141a]/55">
                Deploy on WhatsApp for engaging, on-brand text conversations that qualify leads and
                answer questions around the clock.
              </p>
            </div>
          </div>

          <VoiceDemo />
        </div>
      </div>
    </section>
  );
}
