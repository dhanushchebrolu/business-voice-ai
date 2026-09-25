import { Link } from "@tanstack/react-router";

/**
 * No social links and no email-subscribe form are rendered here — this app
 * has no real, verified ClickAI social media URLs to link to, and no
 * backend endpoint to actually collect a newsletter signup, and the brief
 * is explicit: don't invent links and don't build a form that pretends to
 * work. Get in touch, below, is a real link to the existing /contact route
 * instead — matching the reference's footer proportions (identity block +
 * a primary contact action, then a four-column link grid, then a bottom
 * bar) without the parts we can't make genuinely functional.
 */
const COLUMNS: { heading: string; links: { label: string; targetId?: string; to?: string }[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Platform", targetId: "value-propositions" },
      { label: "Voice AI", targetId: "voice-demo" },
      { label: "Pricing", to: "/pricing" },
    ],
  },
  {
    heading: "ClickAI For",
    links: [{ label: "Solutions", targetId: "feature-showcase" }],
  },
  {
    heading: "Developers",
    links: [{ label: "Integrations", targetId: "integrations" }],
  },
  {
    heading: "Resources",
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
    <footer className="border-t border-slate-200 bg-white py-16">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="grid gap-10 border-b border-slate-200 pb-12 sm:grid-cols-2">
          <div>
            <span className="text-[15px] font-semibold tracking-tight text-slate-900">ClickAI</span>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-slate-500">
              White-label AI voice, WhatsApp and automation for businesses.
            </p>
          </div>
          <div className="flex items-start sm:justify-end">
            <Link
              to="/contact"
              className="rounded-full border border-blue-200 bg-blue-50 px-5 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-100"
            >
              Get in touch
            </Link>
          </div>
        </div>

        <div className="grid gap-10 pt-12 sm:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">
                {col.heading}
              </p>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((link) =>
                  link.to ? (
                    <li key={link.label}>
                      <Link to={link.to} className="text-sm text-slate-500 hover:text-blue-600">
                        {link.label}
                      </Link>
                    </li>
                  ) : (
                    <li key={link.label}>
                      <button
                        type="button"
                        onClick={() => scrollToSection(link.targetId!)}
                        className="text-sm text-slate-500 hover:text-blue-600"
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

        <div className="mt-14 flex flex-col gap-2 border-t border-slate-200 pt-6 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
          <p>ClickAI © {new Date().getFullYear()}</p>
          <p>clickai.in</p>
        </div>
      </div>
    </footer>
  );
}
