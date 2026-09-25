const CHANNELS = [
  { name: "WhatsApp", status: "live" as const },
  { name: "Voice", status: "live" as const },
  { name: "Website Chat", status: "live" as const },
  { name: "Instagram", status: "live" as const },
  { name: "SMS", status: "building" as const },
  { name: "Email", status: "building" as const },
];

export function ChannelsSection() {
  return (
    <section className="border-t border-white/10 bg-[#0a0a0d] py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/45">Channels</p>
        <h2 className="mt-4 max-w-xl font-serif text-4xl leading-[1.08] text-white sm:text-5xl">
          Meet your customers everywhere.
        </h2>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-white/50 sm:text-base">
          One AI brain. Multiple customer channels.
        </p>

        <div className="mt-14 grid gap-4 sm:grid-cols-3">
          {CHANNELS.map((channel) => (
            <div
              key={channel.name}
              className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4"
            >
              <span className="text-sm font-medium text-white/85">{channel.name}</span>
              <span
                className={`rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.08em] ${
                  channel.status === "live"
                    ? "bg-white/10 text-white/70"
                    : "border border-white/15 text-white/40"
                }`}
              >
                {channel.status === "live" ? "Live" : "Coming soon"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
