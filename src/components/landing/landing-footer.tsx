import { Link, useRouterState } from "@tanstack/react-router";
import { ShieldCheck, Lock, Headset } from "lucide-react";
import { CLICKAI_LEGAL_NAME, CLICKAI_ADDRESS_LINES } from "@/lib/company-info";

/**
 * No social links and no email-subscribe form are rendered here — this app
 * has no real, verified ClickAI social media URLs to link to, and no
 * backend endpoint to actually collect a newsletter signup, and the brief
 * is explicit: don't invent links and don't build a form that pretends to
 * work. Get in touch, below, is a real link to the existing /contact route
 * instead.
 *
 * Every "scroll to section" link below targets a real, existing id on the
 * homepage (value-propositions.tsx / voice-demo.tsx / feature-showcase.tsx /
 * integrations-section.tsx / industries-section.tsx). This footer is also
 * rendered on /contact, /pricing and every legal page, which don't have
 * those sections mounted — so a section link there is a real navigation
 * (`Link to="/" hash={id}`) to the homepage, not a same-page scroll; see
 * index.tsx's hash-scroll-on-mount effect for the landing side of this.
 * Only on the homepage itself does a section link stay a plain in-page
 * scroll (SectionLink below decides which, from the live pathname).
 */
const PRODUCT_LINKS: { label: string; targetId: string }[] = [
  { label: "AI Voice Agents", targetId: "voice-demo" },
  { label: "AI Sales Agent", targetId: "ai-sales-executive" },
  { label: "AI Receptionist", targetId: "ai-receptionist" },
  { label: "AI Customer Support", targetId: "ai-customer-care" },
  { label: "WhatsApp AI", targetId: "integrations" },
  { label: "Appointment Booking", targetId: "ai-order-booking" },
  { label: "Business Automation", targetId: "value-propositions" },
];

/** All real verticals covered by the single, real industries-section.tsx on the homepage — not separate thin pages. */
const SOLUTIONS_LINKS: { label: string; targetId: string }[] = [
  { label: "Clinics", targetId: "industries" },
  { label: "Restaurants", targetId: "industries" },
  { label: "Retail", targetId: "industries" },
  { label: "Real Estate", targetId: "industries" },
  { label: "E-commerce", targetId: "industries" },
  { label: "Local Businesses", targetId: "industries" },
];

const COMPANY_LINKS: { label: string; to: string }[] = [
  { label: "About", to: "/about" },
  { label: "Contact", to: "/contact" },
  { label: "Pricing", to: "/pricing" },
];

const RESOURCES_LINKS: { label: string; to?: string; targetId?: string }[] = [
  { label: "Integrations", targetId: "integrations" },
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

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** On the homepage, scrolls in place; anywhere else, navigates home with a hash so the same section is reachable from every page. */
function SectionLink({ label, targetId }: { label: string; targetId: string }) {
  const isHome = useRouterState({ select: (s) => s.location.pathname }) === "/";
  if (isHome) {
    return (
      <button
        type="button"
        onClick={() => scrollToSection(targetId)}
        className="text-sm text-slate-500 hover:text-violet-600"
      >
        {label}
      </button>
    );
  }
  return (
    <Link to="/" hash={targetId} className="text-sm text-slate-500 hover:text-violet-600">
      {label}
    </Link>
  );
}

const TRUST_ROW = [
  { icon: Lock, label: "Secure communications" },
  { icon: ShieldCheck, label: "Privacy-focused design" },
  { icon: Headset, label: "Business support" },
];

export function LandingFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white py-16">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="grid gap-10 border-b border-slate-200 pb-12 sm:grid-cols-2">
          <div>
            <span className="text-[15px] font-semibold tracking-tight text-slate-900">ClickAI</span>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-slate-500">
              AI employees for sales, customer support, bookings, and business automation.
              AI-powered voice, messaging, and workflow automation for businesses.
            </p>
          </div>
          <div className="flex items-start sm:justify-end">
            <Link
              to="/contact"
              className="rounded-full border border-violet-200 bg-violet-50 px-5 py-2.5 text-sm font-medium text-violet-700 hover:bg-violet-100"
            >
              Get in touch
            </Link>
          </div>
        </div>

        <div className="grid gap-10 pt-12 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">
              Products
            </p>
            <ul className="mt-4 space-y-2.5">
              {PRODUCT_LINKS.map((link) => (
                <li key={link.label}>
                  <SectionLink label={link.label} targetId={link.targetId} />
                </li>
              ))}
              <li>
                <Link to="/pricing" className="text-sm text-slate-500 hover:text-violet-600">
                  Pricing
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">
              Solutions
            </p>
            <ul className="mt-4 space-y-2.5">
              {SOLUTIONS_LINKS.map((link) => (
                <li key={link.label}>
                  <SectionLink label={link.label} targetId={link.targetId} />
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">
              Company
            </p>
            <ul className="mt-4 space-y-2.5">
              {COMPANY_LINKS.map((link) => (
                <li key={link.label}>
                  <Link to={link.to} className="text-sm text-slate-500 hover:text-violet-600">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">
              Resources
            </p>
            <ul className="mt-4 space-y-2.5">
              {RESOURCES_LINKS.map((link) =>
                link.to ? (
                  <li key={link.label}>
                    <Link to={link.to} className="text-sm text-slate-500 hover:text-violet-600">
                      {link.label}
                    </Link>
                  </li>
                ) : (
                  <li key={link.label}>
                    <SectionLink label={link.label} targetId={link.targetId!} />
                  </li>
                ),
              )}
            </ul>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">
              Legal
            </p>
            <ul className="mt-4 space-y-2.5">
              {LEGAL_LINKS.map((link) => (
                <li key={link.label}>
                  <Link to={link.to} className="text-sm text-slate-500 hover:text-violet-600">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-slate-200 pt-8">
          {TRUST_ROW.map(({ icon: Icon, label }) => (
            <span key={label} className="flex items-center gap-2 text-xs text-slate-400">
              <Icon className="size-3.5" /> {label}
            </span>
          ))}
        </div>

        <div className="mt-8 border-t border-slate-200 pt-6 text-xs text-slate-400">
          <p className="font-medium text-slate-500">{CLICKAI_LEGAL_NAME}</p>
          {CLICKAI_ADDRESS_LINES.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="mt-1">
            <a href="mailto:hello@clickai.in" className="hover:text-violet-600">
              hello@clickai.in
            </a>
            {" · "}
            <a href="tel:+917660001231" className="hover:text-violet-600">
              +91 76600 01231
            </a>
          </p>
        </div>

        <div className="mt-4 flex flex-col gap-2 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {CLICKAI_LEGAL_NAME}. All rights reserved.
          </p>
          <p>clickai.in</p>
        </div>
      </div>
    </footer>
  );
}
