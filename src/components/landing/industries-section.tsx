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
    <section id="industries" className="border-t border-[#14141a]/10 bg-[#f6f3ee] py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#14141a]/40">
          Industries
        </p>
        <h2 className="mt-4 max-w-xl font-serif text-4xl leading-[1.08] text-[#14141a] sm:text-5xl">
          AI built for your business.
        </h2>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {BUSINESS_TYPES.filter((t) => t.id !== "other").map((industry) => (
            <div key={industry.id} className="rounded-2xl border border-[#14141a]/10 bg-white p-6">
              <h3 className="text-base font-semibold tracking-tight text-[#14141a]">
                {industry.label}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-[#14141a]/55">{industry.blurb}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
