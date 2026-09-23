const ITEMS = [
  {
    title: "Customer Engagement",
    body: "AI that answers, understands and responds to customers across every channel.",
    icon: "burst" as const,
  },
  {
    title: "Lead Conversion",
    body: "Qualify leads, follow up automatically and turn conversations into opportunities.",
    icon: "diamond" as const,
  },
  {
    title: "Business Automation",
    body: "Connect conversations to appointments, CRM workflows, notifications and operations.",
    icon: "hex" as const,
  },
];

function CardIcon({ variant }: { variant: "burst" | "diamond" | "hex" }) {
  if (variant === "burst") {
    return (
      <svg viewBox="0 0 64 64" className="size-10" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => {
          const angle = (i / 8) * Math.PI * 2;
          const x2 = 32 + Math.cos(angle) * 24;
          const y2 = 32 + Math.sin(angle) * 24;
          return (
            <line
              key={i}
              x1="32"
              y1="32"
              x2={x2}
              y2={y2}
              stroke="#c98fb0"
              strokeWidth="1.3"
              opacity="0.85"
            />
          );
        })}
      </svg>
    );
  }
  if (variant === "diamond") {
    return (
      <svg viewBox="0 0 64 64" className="size-10" aria-hidden="true">
        <rect
          x="16"
          y="16"
          width="32"
          height="32"
          transform="rotate(45 32 32)"
          fill="none"
          stroke="#7fa3d1"
          strokeWidth="1.3"
        />
        <rect
          x="24"
          y="24"
          width="16"
          height="16"
          transform="rotate(45 32 32)"
          fill="none"
          stroke="#7fa3d1"
          strokeWidth="1.3"
          opacity="0.6"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 64" className="size-10" aria-hidden="true">
      <polygon
        points="32,10 50,21 50,43 32,54 14,43 14,21"
        fill="none"
        stroke="#7fbf9f"
        strokeWidth="1.3"
      />
      <rect x="24" y="24" width="16" height="16" fill="none" stroke="#7fbf9f" strokeWidth="1.3" />
    </svg>
  );
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function ValuePropositions() {
  return (
    <section
      id="value-propositions"
      className="border-t border-white/10 bg-[#0a0a0d] py-24 sm:py-32"
    >
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-xl">
            <h2 className="font-serif text-4xl leading-[1.1] text-white sm:text-5xl">
              An AI solution tailored to your business needs.
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-white/50 sm:text-base">
              ClickAI automates the conversations your team handles every day.
            </p>
            <div className="mt-6 flex items-center gap-5">
              <button
                type="button"
                onClick={() => scrollToSection("feature-showcase")}
                className="text-sm text-white/70 underline decoration-white/20 underline-offset-4 hover:text-white"
              >
                How it Works?
              </button>
              <button
                type="button"
                onClick={() => scrollToSection("voice-demo")}
                className="rounded-full bg-white px-5 py-2 text-sm font-medium text-[#0a0a0d] hover:bg-white/90"
              >
                Watch Demo
              </button>
            </div>
          </div>
        </div>

        <div className="mt-16 grid gap-5 sm:grid-cols-3">
          {ITEMS.map((item) => (
            <div
              key={item.title}
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-7"
            >
              <CardIcon variant={item.icon} />
              <h3 className="mt-6 text-lg font-semibold tracking-tight text-white">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/50">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
