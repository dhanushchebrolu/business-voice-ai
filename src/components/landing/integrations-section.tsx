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

/**
 * Marketplace status is deliberately honest per integration, not a blanket
 * "Connect" label for everything: only what's actually wired up today
 * (WhatsApp Business embedded signup, voice telephony via the provider-
 * agnostic runtime, website chat, Instagram, Google Calendar OAuth, and
 * Razorpay merchant OAuth) is marked connectable. Everything else on
 * ClickAI's integration roadmap is labeled "Coming soon" rather than
 * presented as live.
 */
const GROUPS: { heading: string; items: { name: string; status: "connect" | "soon" }[] }[] = [
  {
    heading: "Communication",
    items: [
      { name: "WhatsApp", status: "connect" },
      { name: "Voice", status: "connect" },
      { name: "Website Chat", status: "connect" },
      { name: "Instagram", status: "connect" },
      { name: "SMS", status: "soon" },
      { name: "Email", status: "soon" },
    ],
  },
  {
    heading: "Google",
    items: [
      { name: "Google Calendar", status: "connect" },
      { name: "Google Business Profile", status: "soon" },
      { name: "Gmail", status: "soon" },
    ],
  },
  {
    heading: "Payments",
    items: [{ name: "Razorpay", status: "connect" }],
  },
  {
    heading: "CRM",
    items: [
      { name: "HubSpot", status: "soon" },
      { name: "Zoho CRM", status: "soon" },
      { name: "Salesforce", status: "soon" },
      { name: "Pipedrive", status: "soon" },
    ],
  },
  {
    heading: "E-commerce",
    items: [
      { name: "Shopify", status: "soon" },
      { name: "WooCommerce", status: "soon" },
    ],
  },
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
              Connect the tools your business already uses.
            </h2>
            <p className="mt-6 max-w-sm text-sm leading-relaxed text-[#14141a]/55 sm:text-base">
              No API keys to manage — connect an account and your AI employee starts using it.
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
                <li>WhatsApp Business</li>
                <li>Instagram</li>
                <li>Razorpay</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-24 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
          {GROUPS.map((group) => (
            <div key={group.heading}>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#14141a]/40">
                {group.heading}
              </p>
              <ul className="mt-4 space-y-2.5">
                {group.items.map((item) => (
                  <li
                    key={item.name}
                    className="flex items-center justify-between rounded-xl border border-[#14141a]/10 bg-white px-4 py-2.5"
                  >
                    <span className="text-sm text-[#14141a]/80">{item.name}</span>
                    {item.status === "connect" ? (
                      <span className="rounded-full bg-[#14141a] px-2.5 py-1 text-[10px] font-medium text-white">
                        Connect
                      </span>
                    ) : (
                      <span className="rounded-full border border-[#14141a]/15 px-2.5 py-1 text-[10px] font-medium text-[#14141a]/40">
                        Coming soon
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
