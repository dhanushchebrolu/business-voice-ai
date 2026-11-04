import { Link } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LandingNav } from "./landing-nav";
import { LandingFooter } from "./landing-footer";

export type Availability = "Available" | "Needs setup" | "Custom";

export type ProductContent = {
  eyebrow: string;
  title: string;
  intro: string;
  /** What it does — each item says honestly whether it works today. */
  capabilities: { name: string; detail: string; status: Availability }[];
  /** Illustrative only; rendered with a visible "example" label. */
  example: { heading: string; turns: { from: "customer" | "ai"; text: string }[] };
  /** Left-to-right workflow, rendered as numbered steps. */
  workflow: { step: string; detail: string }[];
  useCases: string[];
  setup: string[];
  faq: { q: string; a: string }[];
  /** Footnote on what is simulated or outside this product. */
  note: string;
};

const STATUS_STYLE: Record<Availability, string> = {
  Available: "border-emerald-200 bg-emerald-50 text-emerald-700",
  "Needs setup": "border-blue-200 bg-blue-50 text-blue-700",
  Custom: "border-slate-200 bg-slate-50 text-slate-600",
};

function Section({
  title,
  children,
  id,
}: {
  title: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="border-t border-slate-200 py-16 sm:py-20">
      <div className="mx-auto max-w-[1100px] px-5 sm:px-8">
        <h2 className="max-w-2xl text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          {title}
        </h2>
        <div className="mt-8">{children}</div>
      </div>
    </section>
  );
}

/**
 * One layout for every product page so the site stays cohesive. Content is
 * static marketing copy: no data access, no fabricated numbers, and each
 * capability carries an honest status label.
 */
export function ProductPage({ c }: { c: ProductContent }) {
  return (
    <div className="theme-light min-h-screen bg-white text-slate-900">
      <LandingNav />
      <main>
        <section className="mx-auto max-w-[1100px] px-5 pb-16 pt-14 sm:px-8 sm:pt-20">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-violet-600">
            {c.eyebrow}
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            {c.title}
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-slate-600">{c.intro}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/contact">
              <Button size="lg" className="rounded-full bg-violet-600 px-6 text-white">
                Book a Demo
              </Button>
            </Link>
            <Link to="/pricing">
              <Button size="lg" variant="outline" className="rounded-full px-6">
                See pricing
              </Button>
            </Link>
          </div>
        </section>

        <Section title="What it does">
          <ul className="grid gap-4 sm:grid-cols-2">
            {c.capabilities.map((cap) => (
              <li key={cap.name} className="rounded-xl border border-slate-200 p-5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold">{cap.name}</h3>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[cap.status]}`}
                  >
                    {cap.status}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{cap.detail}</p>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="How a request flows">
          <ol className="grid gap-4 md:grid-cols-4">
            {c.workflow.map((w, i) => (
              <li key={w.step} className="relative rounded-xl bg-slate-50 p-5">
                <span className="text-xs font-medium text-violet-600">Step {i + 1}</span>
                <p className="mt-1 text-sm font-semibold">{w.step}</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{w.detail}</p>
              </li>
            ))}
          </ol>
        </Section>

        <Section title={c.example.heading}>
          <div className="max-w-xl rounded-2xl border border-slate-200 bg-slate-50 p-5">
            <p className="mb-4 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Illustrative example — not a recording of a live conversation
            </p>
            <ul className="space-y-3">
              {c.example.turns.map((t, i) => (
                <li
                  key={i}
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                    t.from === "ai"
                      ? "ml-auto bg-violet-600 text-white"
                      : "border border-slate-200 bg-white text-slate-800"
                  }`}
                >
                  <span className="sr-only">{t.from === "ai" ? "ClickAI: " : "Customer: "}</span>
                  {t.text}
                </li>
              ))}
            </ul>
          </div>
        </Section>

        <Section title="Where it fits">
          <ul className="grid gap-3 sm:grid-cols-2">
            {c.useCases.map((u) => (
              <li key={u} className="flex gap-3 text-sm text-slate-700">
                <Check className="mt-0.5 size-4 shrink-0 text-violet-600" aria-hidden="true" />
                {u}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Getting started">
          <ol className="max-w-2xl list-decimal space-y-3 pl-5 text-sm leading-relaxed text-slate-700">
            {c.setup.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="mt-6 max-w-2xl text-xs leading-relaxed text-slate-500">{c.note}</p>
        </Section>

        <Section title="Questions">
          <div className="max-w-2xl divide-y divide-slate-200 border-y border-slate-200">
            {c.faq.map((f) => (
              <details key={f.q} className="group py-4">
                <summary className="cursor-pointer list-none text-sm font-medium text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-600">
                  {f.q}
                </summary>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.a}</p>
              </details>
            ))}
          </div>
        </Section>

        <section className="border-t border-slate-200 bg-slate-50 py-16">
          <div className="mx-auto flex max-w-[1100px] flex-col gap-5 px-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <p className="text-xl font-semibold tracking-tight">See it with your own business.</p>
            <Link to="/contact">
              <Button size="lg" className="rounded-full bg-violet-600 px-6 text-white">
                Book a Demo <ArrowRight className="ml-1 size-4" />
              </Button>
            </Link>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
