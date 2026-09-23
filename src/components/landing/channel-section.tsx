const CHANNELS = [
  {
    label: "Voice AI",
    body: "AI receptionists and voice agents that can handle real customer conversations.",
  },
  {
    label: "WhatsApp AI",
    body: "AI-powered WhatsApp conversations for support, sales and customer engagement.",
  },
  {
    label: "Automation",
    body: "Automatically connect conversations to business workflows.",
  },
];

export function ChannelSection() {
  return (
    <section className="border-t border-[#14141a]/10 bg-[#f6f3ee] py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <h2 className="font-serif text-4xl leading-[1.08] text-[#14141a] sm:text-5xl lg:text-6xl">
          One platform.
          <br />
          Every conversation.
        </h2>

        <div className="mt-16 space-y-0 divide-y divide-[#14141a]/10 border-y border-[#14141a]/10">
          {CHANNELS.map((c, i) => (
            <div
              key={c.label}
              className="flex flex-col gap-2 py-8 sm:flex-row sm:items-baseline sm:gap-10 sm:py-10"
            >
              <span className="font-mono text-xs text-[#14141a]/35 sm:w-10">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="font-serif text-2xl text-[#14141a] sm:w-64 sm:shrink-0 sm:text-3xl">
                {c.label}
              </h3>
              <p className="max-w-xl text-sm leading-relaxed text-[#14141a]/55 sm:text-base">
                {c.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
