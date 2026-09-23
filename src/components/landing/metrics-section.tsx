/**
 * Deliberately NOT fabricated usage statistics ("10M calls processed" etc.)
 * — the brief is explicit that only verified application data may be
 * presented as a number, and none exists to cite here. These are
 * capability statements instead, each one true of the platform itself.
 */
const CAPABILITIES = [
  { top: "24/7", bottom: "AI availability" },
  { top: "Multi-channel", bottom: "Voice + WhatsApp" },
  { top: "One platform", bottom: "Multiple AI agents" },
  { top: "White-label", bottom: "Built for scale" },
];

export function MetricsSection() {
  return (
    <section className="border-t border-white/10 bg-[#0a0a0d] py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
          {CAPABILITIES.map((c) => (
            <div key={c.top} className="border-t border-white/15 pt-6">
              <p className="font-serif text-3xl text-white sm:text-4xl">{c.top}</p>
              <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.16em] text-white/45">
                {c.bottom}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
