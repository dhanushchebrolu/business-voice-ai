const CATEGORIES = [
  "WhatsApp",
  "Telephony",
  "CRM",
  "Calendars",
  "Payments",
  "Webhooks",
  "APIs",
  "AI Models",
];

export function IntegrationsSection() {
  return (
    <section id="integrations" className="border-t border-white/10 bg-[#0a0a0d] py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/45">
          Integrations
        </p>
        <h2 className="mt-4 max-w-xl font-serif text-4xl leading-[1.08] text-white sm:text-5xl">
          All your tools. One seamless workflow.
        </h2>

        <div className="relative mt-16 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-4">
          {CATEGORIES.map((label) => (
            <div
              key={label}
              className="group relative bg-[#0a0a0d] px-6 py-10 text-center transition-colors hover:bg-white/[0.04]"
            >
              <span
                className="pointer-events-none absolute inset-x-6 top-0 h-px origin-left scale-x-0 bg-white/40 transition-transform duration-500 group-hover:scale-x-100"
                aria-hidden="true"
              />
              <span className="text-sm font-medium text-white/75">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
