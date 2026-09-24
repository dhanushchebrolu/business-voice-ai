import { Link } from "@tanstack/react-router";

/**
 * ClickAI's four primary AI product categories, per the platform's product
 * positioning: AI Sales Executive, AI Receptionist, AI Booking & Order
 * Agent, and AI Customer Care. These are not four separate agent systems —
 * every ClickAI agent shares one core (business profile, knowledge, tools,
 * channels); these are the four common configurations a business owner
 * picks from when setting one up, distinguished by which objectives and
 * tools are enabled.
 */
const PRODUCTS = [
  {
    name: "AI Sales Executive",
    tagline: "Turn enquiries into customers.",
    capabilities: [
      "Lead capture and qualification",
      "Sales conversations across WhatsApp, Instagram and website chat",
      "Automated follow-ups",
      "Payment link sharing",
    ],
    channels: ["WhatsApp", "Instagram", "Website", "Voice"],
    industries: "Retail, e-commerce, service businesses",
    icon: "burst" as const,
  },
  {
    name: "AI Receptionist",
    tagline: "Your 24/7 front desk.",
    capabilities: [
      "Natural voice conversations, day or night",
      "Appointment booking with live calendar availability",
      "Payment collection and confirmation",
      "Call transfer to staff when needed",
    ],
    channels: ["Voice", "WhatsApp"],
    industries: "Clinics, salons, service businesses",
    icon: "diamond" as const,
  },
  {
    name: "AI Booking & Order Agent",
    tagline: "Take bookings. Process orders. Keep customers updated.",
    capabilities: [
      "Table, room and service bookings",
      "Product and food ordering",
      "Payment collected in the same conversation",
      "Rescheduling, cancellations and delivery tracking",
    ],
    channels: ["WhatsApp", "Voice", "Website"],
    industries: "Restaurants, hotels, retail, e-commerce",
    icon: "hex" as const,
  },
  {
    name: "AI Customer Care",
    tagline: "Delight your customers, every time.",
    capabilities: [
      "FAQs and general enquiries",
      "Support ticket and complaint registration",
      "Order, appointment and payment status",
      "Feedback collection and automated follow-ups",
    ],
    channels: ["WhatsApp", "Voice", "Instagram", "Website"],
    industries: "Every industry ClickAI serves",
    icon: "ring" as const,
  },
];

function CardIcon({ variant }: { variant: "burst" | "diamond" | "hex" | "ring" }) {
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
  if (variant === "hex") {
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
  return (
    <svg viewBox="0 0 64 64" className="size-10" aria-hidden="true">
      <circle cx="32" cy="32" r="22" fill="none" stroke="#d1a86b" strokeWidth="1.3" />
      <circle cx="32" cy="32" r="12" fill="none" stroke="#d1a86b" strokeWidth="1.3" opacity="0.6" />
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
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/45">
              AI employees
            </p>
            <h2 className="mt-4 font-serif text-4xl leading-[1.1] text-white sm:text-5xl">
              Four AI employees. One shared brain.
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-white/50 sm:text-base">
              Every ClickAI agent runs on the same core — business knowledge, tools and channels —
              configured for the role your business needs.
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

        <div className="mt-16 grid gap-5 sm:grid-cols-2">
          {PRODUCTS.map((product) => (
            <div
              key={product.name}
              className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-7"
            >
              <CardIcon variant={product.icon} />
              <h3 className="mt-6 text-xl font-semibold tracking-tight text-white">
                {product.name}
              </h3>
              <p className="mt-1 text-sm text-white/60">{product.tagline}</p>

              <ul className="mt-5 space-y-2 text-sm leading-relaxed text-white/50">
                {product.capabilities.map((c) => (
                  <li key={c} className="flex gap-2">
                    <span className="text-white/25" aria-hidden="true">
                      —
                    </span>
                    {c}
                  </li>
                ))}
              </ul>

              <div className="mt-5 flex flex-wrap gap-1.5">
                {product.channels.map((ch) => (
                  <span
                    key={ch}
                    className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-white/55"
                  >
                    {ch}
                  </span>
                ))}
              </div>

              <p className="mt-4 text-xs text-white/35">Popular for: {product.industries}</p>

              <Link to="/contact" className="mt-6 text-sm font-medium text-white hover:underline">
                Talk to us about {product.name} →
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
