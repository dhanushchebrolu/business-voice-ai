import { Link } from "@tanstack/react-router";

/**
 * No social links are rendered here — this app has no real, verified
 * ClickAI social media URLs to link to, and the brief itself is explicit:
 * "Do not invent social media URLs or company links." A placeholder
 * icon linking nowhere would be exactly the kind of dead control the
 * functionality requirements rule out.
 */
const COLUMNS: { heading: string; links: { label: string; targetId?: string; to?: string }[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Platform", targetId: "value-propositions" },
      { label: "Channels", targetId: "voice-demo" },
      { label: "Pricing", to: "/pricing" },
    ],
  },
  {
    heading: "Solutions",
    links: [{ label: "White-label", targetId: "white-label" }],
  },
  {
    heading: "Developers",
    links: [{ label: "Integrations", targetId: "integrations" }],
  },
  {
    heading: "Company",
    links: [
      { label: "Contact", to: "/contact" },
      { label: "Login", to: "/auth" },
    ],
  },
];

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function LandingFooter() {
  return (
    <footer className="border-t border-white/10 bg-[#0a0a0d] py-16">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div>
            <span className="text-[15px] font-semibold tracking-tight text-white">ClickAI</span>
            <p className="mt-3 max-w-xs text-sm text-white/45">
              White-label AI voice, WhatsApp and automation for businesses.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
                {col.heading}
              </p>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((link) =>
                  link.to ? (
                    <li key={link.label}>
                      <Link to={link.to} className="text-sm text-white/65 hover:text-white">
                        {link.label}
                      </Link>
                    </li>
                  ) : (
                    <li key={link.label}>
                      <button
                        type="button"
                        onClick={() => scrollToSection(link.targetId!)}
                        className="text-sm text-white/65 hover:text-white"
                      >
                        {link.label}
                      </button>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-2 border-t border-white/10 pt-6 text-xs text-white/35 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} ClickAI. All rights reserved.</p>
          <p>clickai.in</p>
        </div>
      </div>
    </footer>
  );
}
