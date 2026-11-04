import { Link } from "@tanstack/react-router";
import { Logo } from "@/components/app/primitives";
import { CLICKAI_LEGAL_NAME, CLICKAI_ADDRESS_LINES } from "@/lib/company-info";

/**
 * Dark footer. No social links and no email-subscribe form are rendered:
 * this app has no verified ClickAI social URLs and no backend to collect a
 * newsletter signup, so neither is invented. "Get in touch" is a real link
 * to the existing /contact route. Every link below is a real route.
 */
const PRODUCT_LINKS: { label: string; to: string }[] = [
  { label: "AI Voice Agents", to: "/ai-voice-agents" },
  { label: "WhatsApp AI Agents", to: "/whatsapp-ai-agents" },
  { label: "Appointment Automation", to: "/appointment-automation" },
  { label: "Business Automation", to: "/business-automation" },
  { label: "Pricing", to: "/pricing" },
];

const SOLUTIONS_LINKS: { label: string; hash: string }[] = [
  { label: "Healthcare and clinics", hash: "healthcare" },
  { label: "Restaurants and hospitality", hash: "restaurants" },
  { label: "Real estate", hash: "real-estate" },
  { label: "Education", hash: "education" },
  { label: "Retail and local business", hash: "retail" },
  { label: "Professional services", hash: "professional-services" },
];

const COMPANY_LINKS: { label: string; to: string }[] = [
  { label: "About", to: "/about" },
  { label: "Contact", to: "/contact" },
  { label: "Integrations", to: "/integrations" },
  { label: "Login", to: "/auth" },
];

const LEGAL_LINKS: { label: string; to: string }[] = [
  { label: "Privacy Policy", to: "/privacy-policy" },
  { label: "Terms & Conditions", to: "/terms" },
  { label: "Acceptable Use Policy", to: "/acceptable-use-policy" },
  { label: "Messaging Policy", to: "/messaging-policy" },
  { label: "Cookie Policy", to: "/cookie-policy" },
  { label: "Refund & Cancellation Policy", to: "/refund-cancellation-policy" },
  { label: "AI Disclaimer", to: "/ai-disclaimer" },
];

const LINK =
  "text-sm text-slate-400 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300";
const CTA =
  "mt-6 inline-block rounded-full border border-white/20 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300";
const HEADING = "text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500";

export function LandingFooter() {
  return (
    <footer className="bg-ink-950 py-16 text-slate-300">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="grid gap-10 border-b border-white/10 pb-12 lg:grid-cols-[1.2fr_2fr]">
          <div>
            <Logo plate />
            <p className="mt-5 max-w-xs text-sm leading-relaxed text-slate-400">
              AI employees for calls, WhatsApp, appointments and everyday business workflows.
            </p>
            <Link to="/contact" className={CTA}>
              Get in touch
            </Link>
          </div>

          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            <nav aria-label="Products">
              <p className={HEADING}>Products</p>
              <ul className="mt-4 space-y-2.5">
                {PRODUCT_LINKS.map((l) => (
                  <li key={l.label}>
                    <Link to={l.to} className={LINK}>
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <nav aria-label="Solutions">
              <p className={HEADING}>Solutions</p>
              <ul className="mt-4 space-y-2.5">
                {SOLUTIONS_LINKS.map((l) => (
                  <li key={l.label}>
                    <Link to="/solutions" hash={l.hash} className={LINK}>
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <nav aria-label="Company">
              <p className={HEADING}>Company</p>
              <ul className="mt-4 space-y-2.5">
                {COMPANY_LINKS.map((l) => (
                  <li key={l.label}>
                    <Link to={l.to} className={LINK}>
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <nav aria-label="Legal">
              <p className={HEADING}>Legal</p>
              <ul className="mt-4 space-y-2.5">
                {LEGAL_LINKS.map((l) => (
                  <li key={l.label}>
                    <Link to={l.to} className={LINK}>
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </div>

        <div className="mt-8 grid gap-6 text-xs text-slate-400 sm:grid-cols-2">
          <div>
            <p className="font-medium text-slate-200">{CLICKAI_LEGAL_NAME}</p>
            {CLICKAI_ADDRESS_LINES.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <p className="sm:text-right">
            <a href="mailto:hello@clickai.in" className="hover:text-white">
              hello@clickai.in
            </a>
            {" · "}
            <a href="tel:+917660001231" className="hover:text-white">
              +91 76600 01231
            </a>
          </p>
        </div>

        <div className="mt-8 flex flex-col gap-2 border-t border-white/10 pt-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {CLICKAI_LEGAL_NAME}. All rights reserved.
          </p>
          <p>clickai.in</p>
        </div>
      </div>
    </footer>
  );
}
