/**
 * Deliberately NOT fabricated usage statistics ("13.9% lower costs",
 * "10M calls processed" etc.) — the brief is explicit that only verified
 * application data may be presented as a number, and none exists to cite
 * here. These are capability statements instead, styled as the reference's
 * three color-blocked stat cards, each one true of the platform itself.
 */
const CAPABILITIES = [
  { top: "24/7", bottom: "AI availability, every channel", tone: "bg-[#3f5a78]" },
  { top: "Multi-channel", bottom: "Voice and WhatsApp, one agent", tone: "bg-[#4a6b52]" },
  { top: "White-label", bottom: "Built for agencies and partners", tone: "bg-[#5c4f66]" },
];

export function MetricsSection() {
  return (
    <section className="border-t border-white/10 bg-[#0a0a0d] py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/45">
          ClickAI capabilities
        </p>
        <h2 className="mt-4 max-w-xl font-serif text-4xl leading-[1.1] text-white sm:text-5xl">
          Built to earn trust in every conversation.
        </h2>

        <div className="mt-14 grid gap-5 sm:grid-cols-3">
          {CAPABILITIES.map((c) => (
            <div key={c.top} className={`rounded-2xl ${c.tone} px-7 py-9 text-white`}>
              <p className="font-serif text-3xl sm:text-4xl">{c.top}</p>
              <p className="mt-3 text-sm leading-relaxed text-white/80">{c.bottom}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
