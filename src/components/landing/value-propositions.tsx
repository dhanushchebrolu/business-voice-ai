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
    id: "ai-sales-executive",
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
    id: "ai-receptionist",
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
    id: "ai-order-booking",
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
    id: "ai-customer-care",
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
              stroke="#2563eb"
              strokeWidth="1.3"
              opacity="0.7"
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
          stroke="#2563eb"
          strokeWidth="1.3"
        />
        <rect
          x="24"
          y="24"
          width="16"
          height="16"
          transform="rotate(45 32 32)"
          fill="none"
          stroke="#2563eb"
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
          stroke="#2563eb"
          strokeWidth="1.3"
        />
        <rect x="24" y="24" width="16" height="16" fill="none" stroke="#2563eb" strokeWidth="1.3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 64" className="size-10" aria-hidden="true">
      <circle cx="32" cy="32" r="22" fill="none" stroke="#2563eb" strokeWidth="1.3" />
      <circle cx="32" cy="32" r="12" fill="none" stroke="#2563eb" strokeWidth="1.3" opacity="0.6" />
    </svg>
  );
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function ValuePropositions() {
  return (
    <section id="value-propositions" className="border-t border-slate-200 bg-white py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-xl">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-blue-600">
              AI employees
            </p>
            <h2 className="mt-4 font-serif text-4xl leading-[1.1] text-slate-900 sm:text-5xl">
              Four AI employees. One shared brain.
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-slate-500 sm:text-base">
              Every ClickAI agent runs on the same core — business knowledge, tools and channels —
              configured for the role your business needs.
            </p>
            <div className="mt-6 flex items-center gap-5">
              <button
                type="button"
                onClick={() => scrollToSection("feature-showcase")}
                className="text-sm text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-blue-600"
              >
                How it Works?
              </button>
              <button
                type="button"
                onClick={() => scrollToSection("voice-demo")}
                className="rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700"
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
              id={product.id}
              className="flex scroll-mt-24 flex-col rounded-2xl border border-slate-200 bg-white p-7 shadow-sm"
            >
              <span className="grid size-14 place-items-center rounded-2xl bg-blue-50">
                <CardIcon variant={product.icon} />
              </span>
              <h3 className="mt-6 text-xl font-semibold tracking-tight text-slate-900">
                {product.name}
              </h3>
              <p className="mt-1 text-sm text-slate-500">{product.tagline}</p>

              <ul className="mt-5 space-y-2 text-sm leading-relaxed text-slate-500">
                {product.capabilities.map((c) => (
                  <li key={c} className="flex gap-2">
                    <span className="text-blue-400" aria-hidden="true">
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
                    className="rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-[11px] text-blue-700"
                  >
                    {ch}
                  </span>
                ))}
              </div>

              <p className="mt-4 text-xs text-slate-400">Popular for: {product.industries}</p>

              <Link
                to="/contact"
                className="mt-6 text-sm font-medium text-blue-600 hover:underline"
              >
                Talk to us about {product.name} →
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
