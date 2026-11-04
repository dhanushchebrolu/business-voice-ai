import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { LandingNav } from "./landing-nav";
import { LandingFooter } from "./landing-footer";
import { FinalCta } from "./final-cta";
import { Reveal } from "./reveal";
import {
  AppointmentSurface,
  AutomationSurface,
  VoiceSurface,
  WhatsAppSurface,
} from "./product-surfaces";

export type Availability = "Available" | "Needs setup" | "Custom";

export type ProductContent = {
  eyebrow: string;
  title: string;
  intro: string;
  /** Which product surface is drawn in the hero (all are labelled illustrative). */
  surface: "voice" | "whatsapp" | "appointments" | "automation";
  /** What it does: each item says honestly whether it works today. */
  capabilities: { name: string; detail: string; status: Availability }[];
  /** Left-to-right workflow, rendered as numbered steps. */
  workflow: { step: string; detail: string }[];
  useCases: string[];
  setup: string[];
  faq: { q: string; a: string }[];
  /** Footnote on what is simulated or outside this product. */
  note: string;
};

const SURFACES = {
  voice: VoiceSurface,
  whatsapp: WhatsAppSurface,
  appointments: AppointmentSurface,
  automation: AutomationSurface,
};

const STATUS_STYLE: Record<Availability, string> = {
  Available: "text-emerald-700",
  "Needs setup": "text-blue-700",
  Custom: "text-slate-500",
};

const H2 = "font-serif text-3xl leading-tight tracking-tight text-slate-900 sm:text-4xl";

/**
 * One layout for every product page: dark hero with the product surface,
 * a ruled capability list (not cards), a numbered flow on paper, use cases
 * and setup, an accordion FAQ and the shared closing CTA. Content is static
 * marketing copy with no data access, no numbers, and honest status labels.
 */
export function ProductPage({ c }: { c: ProductContent }) {
  const Surface = SURFACES[c.surface];
  return (
    <div className="theme-light min-h-screen bg-white">
      <LandingNav />
      <main>
        <section className="relative isolate overflow-hidden bg-ink-950 text-white">
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 opacity-[0.07] [background-image:linear-gradient(white_1px,transparent_1px),linear-gradient(90deg,white_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_70%_70%_at_75%_50%,black,transparent)]"
          />
          <div className="mx-auto grid max-w-[1200px] gap-12 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-16 lg:py-24">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-sky-300">
                {c.eyebrow}
              </p>
              <h1 className="mt-4 font-serif text-[clamp(2.25rem,5vw,3.75rem)] leading-[1.05] tracking-tight">
                {c.title}
              </h1>
              <p className="mt-5 max-w-lg text-base leading-relaxed text-slate-300">{c.intro}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/contact">
                  <Button
                    size="lg"
                    className="h-12 rounded-full bg-violet-600 px-7 text-white hover:bg-violet-500 active:scale-[0.98]"
                  >
                    Book a Demo
                  </Button>
                </Link>
                <Link to="/pricing">
                  <Button
                    size="lg"
                    variant="outline"
                    className="h-12 rounded-full border-white/25 bg-transparent px-7 text-white hover:bg-white/10 hover:text-white active:scale-[0.98]"
                  >
                    See pricing
                  </Button>
                </Link>
              </div>
            </div>
            <Surface />
          </div>
        </section>

        <section className="py-16 sm:py-24">
          <div className="mx-auto grid max-w-[1200px] gap-10 px-5 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
            <h2 className={H2}>What it does today</h2>
            <ul>
              {c.capabilities.map((cap, i) => (
                <li key={cap.name}>
                  <Reveal delay={Math.min(i, 4) * 50}>
                    <div className="grid gap-1 border-t border-slate-200 py-5 sm:grid-cols-[1fr_auto] sm:gap-6">
                      <div>
                        <h3 className="text-base font-semibold text-slate-900">{cap.name}</h3>
                        <p className="mt-1 text-sm leading-relaxed text-slate-600">{cap.detail}</p>
                      </div>
                      <span className={`text-xs font-medium sm:pt-1 ${STATUS_STYLE[cap.status]}`}>
                        {cap.status}
                      </span>
                    </div>
                  </Reveal>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="bg-paper py-16 sm:py-24">
          <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
            <h2 className={H2}>How a request flows</h2>
            <ol className="mt-12 grid gap-0 md:grid-cols-4">
              {c.workflow.map((w, i) => (
                <li key={w.step} className="relative border-t border-slate-300 pb-8 pt-6 md:pr-8">
                  <span
                    aria-hidden="true"
                    className="absolute -top-px left-0 h-0.5 w-10 bg-violet-600"
                  />
                  <span className="font-serif text-4xl text-violet-600" aria-hidden="true">
                    0{i + 1}
                  </span>
                  <p className="mt-3 text-sm font-semibold text-slate-900">{w.step}</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">{w.detail}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="py-16 sm:py-24">
          <div className="mx-auto grid max-w-[1200px] gap-14 px-5 sm:px-8 lg:grid-cols-2 lg:gap-20">
            <div>
              <h2 className={H2}>Where it fits</h2>
              <ul className="mt-8">
                {c.useCases.map((u) => (
                  <li key={u} className="border-t border-slate-200 py-4 text-sm text-slate-700">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className={H2}>Getting started</h2>
              <ol className="mt-8">
                {c.setup.map((s, i) => (
                  <li
                    key={s}
                    className="flex gap-4 border-t border-slate-200 py-4 text-sm text-slate-700"
                  >
                    <span className="font-medium text-violet-600" aria-hidden="true">
                      0{i + 1}
                    </span>
                    {s}
                  </li>
                ))}
              </ol>
              <p className="mt-6 text-xs leading-relaxed text-slate-500">{c.note}</p>
            </div>
          </div>
        </section>

        <section className="border-t border-slate-200 bg-white py-16 sm:py-24">
          <div className="mx-auto grid max-w-[1200px] gap-10 px-5 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
            <h2 className={H2}>Questions</h2>
            <Accordion type="single" collapsible className="border-b border-slate-200">
              {c.faq.map((f, i) => (
                <AccordionItem key={f.q} value={`q${i}`} className="border-slate-200">
                  <AccordionTrigger className="py-5 text-base font-medium text-slate-900 hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-600">
                    {f.q}
                  </AccordionTrigger>
                  <AccordionContent className="text-sm leading-relaxed text-slate-600">
                    {f.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>

        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
