import type { ReactNode } from "react";

/**
 * Compact dark page header shared by Solutions, Integrations, Pricing, About
 * and Contact, so inner pages open with the same surface as the home hero
 * without repeating its two-column layout.
 */
export function PageHero({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro?: string;
  children?: ReactNode;
}) {
  return (
    <section className="relative isolate overflow-hidden bg-ink-950 text-white">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 opacity-[0.07] [background-image:linear-gradient(white_1px,transparent_1px),linear-gradient(90deg,white_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_60%_100%_at_80%_0%,black,transparent)]"
      />
      <div className="mx-auto max-w-[1200px] px-5 py-14 sm:px-8 sm:py-20">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-sky-300">{eyebrow}</p>
        <h1 className="mt-4 max-w-3xl font-serif text-[clamp(2.25rem,5vw,3.75rem)] leading-[1.05] tracking-tight">
          {title}
        </h1>
        {intro ? (
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-slate-300">{intro}</p>
        ) : null}
        {children}
      </div>
    </section>
  );
}
