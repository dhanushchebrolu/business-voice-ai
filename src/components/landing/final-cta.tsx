import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ParticleWave } from "./particle-wave";

export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-violet-500 bg-violet-600 py-28 sm:py-36">
      <div className="pointer-events-none absolute inset-0 opacity-25">
        <ParticleWave tone="on-dark" variant="subtle" className="h-full w-full" />
      </div>

      <div className="relative mx-auto max-w-3xl px-5 text-center sm:px-8">
        <h2 className="font-serif text-4xl leading-[1.05] text-white sm:text-6xl">
          Give Your Business
          <br />
          an AI Employee.
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-sm leading-relaxed text-violet-50 sm:text-base">
          Deploy AI agents that talk to customers, qualify leads, book appointments and automate
          everyday work.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link to="/contact">
            <Button
              size="lg"
              className="rounded-full bg-white px-6 text-violet-700 hover:bg-violet-50"
            >
              Book a Demo
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}
