import { BUSINESS_TYPES } from "@/lib/business-types";

/**
 * Shows every business type the dashboard's own onboarding flow supports
 * (BUSINESS_TYPES, src/lib/business-types.ts) — the same list the nav
 * bar's Industries dropdown links here, so a visitor who picks an industry
 * from the nav lands on a section that genuinely covers it, not a
 * shorter, separately-maintained marketing list that could drift out of
 * sync with what the product actually configures.
 */
export function IndustriesSection() {
  return (
    <section id="industries" className="border-t border-slate-200 bg-white py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-blue-600">
          Industries
        </p>
        <h2 className="mt-4 max-w-xl font-serif text-4xl leading-[1.08] text-slate-900 sm:text-5xl">
          AI built for your business.
        </h2>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {BUSINESS_TYPES.filter((t) => t.id !== "other").map((industry) => (
            <div
              key={industry.id}
              className="rounded-2xl border border-slate-200 bg-blue-50/30 p-6 transition-colors hover:border-blue-200 hover:bg-blue-50"
            >
              <h3 className="text-base font-semibold tracking-tight text-slate-900">
                {industry.label}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">{industry.blurb}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
