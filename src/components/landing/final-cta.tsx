import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export function FinalCta() {
  return (
    <section className="relative isolate overflow-hidden bg-ink-900 py-24 text-white sm:py-32">
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 -z-10 h-[420px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(37,99,235,0.28),transparent)]"
      />
      <div className="mx-auto max-w-3xl px-5 text-center sm:px-8">
        <h2 className="font-serif text-4xl leading-[1.05] tracking-tight sm:text-6xl">
          Give Your Business an AI Employee.
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-slate-300">
          See how ClickAI would answer your calls and messages, configured from your own business
          details.
        </p>
        <Link to="/contact" className="mt-9 inline-block">
          <Button
            size="lg"
            className="h-12 rounded-full bg-white px-8 text-ink-950 transition-[transform,background-color] hover:bg-slate-100 active:scale-[0.98]"
          >
            Book a Demo
          </Button>
        </Link>
      </div>
    </section>
  );
}
