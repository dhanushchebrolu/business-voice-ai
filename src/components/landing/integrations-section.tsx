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
    <section id="integrations" className="border-t border-[#14141a]/10 bg-[#f6f3ee] py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-20">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#14141a]/40">
              Integrations
            </p>
            <h2 className="mt-4 font-serif text-4xl leading-[1.08] text-[#14141a] sm:text-5xl">
              All your tools.
              <br />
              One seamless workflow.
            </h2>
            <p className="mt-6 max-w-sm text-sm leading-relaxed text-[#14141a]/55 sm:text-base">
              Connect ClickAI to the tools your team already runs on, and automate the handoff
              between every conversation and the systems behind it.
            </p>
          </div>

          <div className="relative" aria-hidden="true">
            <div className="absolute -top-4 left-4 h-48 w-64 rotate-[-6deg] rounded-2xl border border-[#14141a]/10 bg-white shadow-[0_20px_40px_-20px_rgba(20,20,26,0.2)] sm:h-56 sm:w-72" />
            <div className="absolute -top-2 left-2 h-48 w-64 rotate-[-2deg] rounded-2xl border border-[#14141a]/10 bg-white shadow-[0_20px_40px_-20px_rgba(20,20,26,0.2)] sm:h-56 sm:w-72" />
            <div className="relative h-48 w-64 rounded-2xl border border-[#14141a]/10 bg-white p-5 shadow-[0_20px_40px_-20px_rgba(20,20,26,0.2)] sm:h-56 sm:w-72">
              <div className="grid grid-cols-4 gap-2">
                {CATEGORIES.map((label) => (
                  <div
                    key={label}
                    className="rounded-lg border border-[#14141a]/10 bg-[#f6f3ee] px-1.5 py-2 text-center text-[9px] font-medium leading-tight text-[#14141a]/60"
                  >
                    {label}
                  </div>
                ))}
              </div>
            </div>

            <div className="absolute -right-2 bottom-[-28px] w-52 rounded-2xl border border-[#14141a]/10 bg-white p-3.5 shadow-[0_24px_48px_-20px_rgba(20,20,26,0.25)] sm:-right-6 sm:bottom-[-32px] sm:w-60">
              <p className="text-xs font-semibold text-[#14141a]">Connected</p>
              <ul className="mt-2 space-y-1.5 text-[11px] text-[#14141a]/60">
                <li>WhatsApp Business API</li>
                <li>Exotel telephony</li>
                <li>Google Calendar</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
