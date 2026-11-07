import { Link } from "@tanstack/react-router";
import { Logo } from "@/components/app/primitives";
import { CLICKAI_ADDRESS_LINES, CLICKAI_LEGAL_NAME } from "@/lib/company-info";
import { VxLink } from "./primitives";

/**
 * Homepage footer: dark, mono, numbered link columns (reference layout). No
 * external profile links (none are verified) and no newsletter form (no backend for one).
 * Every link is a real route or an on-page section.
 */

const SECTIONS = [
  ["02", "How it works", "loop"],
  ["03", "Products", "products"],
  ["04", "Activity", "console"],
  ["05", "Integrations", "integrations"],
  ["09", "Pricing", "pricing"],
] as const;

const PRODUCTS = [
  ["AI Voice Agents", "/ai-voice-agents"],
  ["WhatsApp AI Agents", "/whatsapp-ai-agents"],
  ["Appointment Automation", "/appointment-automation"],
  ["Business Automation", "/business-automation"],
  ["Solutions", "/solutions"],
] as const;

const COMPANY = [
  ["About", "/about"],
  ["Contact", "/contact"],
  ["Privacy Policy", "/privacy-policy"],
  ["Terms & Conditions", "/terms"],
  ["Cookie Policy", "/cookie-policy"],
  ["Refund & Cancellation", "/refund-cancellation-policy"],
  ["Messaging Policy", "/messaging-policy"],
  ["Acceptable Use", "/acceptable-use-policy"],
  ["AI Disclaimer", "/ai-disclaimer"],
] as const;

const HEAD = "font-vmono text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400";
const LINK =
  "inline-flex min-h-8 items-center gap-3 font-display text-[16px] text-slate-200 transition-colors hover:text-[var(--vx-accent-hot)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300";

export function VxFooter() {
  return (
    <footer className="relative isolate overflow-clip bg-[var(--vx-dark)] text-white">
      <div aria-hidden="true" className="vx-dots vx-dots-dark absolute inset-0 -z-10" />
      <div className="mx-auto max-w-[1305px] px-5 pb-10 pt-20 sm:px-10 lg:px-[39px]">
        <div className="grid gap-14 lg:grid-cols-[1.3fr_1fr_1fr_1fr]">
          <div>
            <Logo onDark />
            <p className="mt-5 max-w-[320px] font-vmono text-[13px] leading-[1.7] text-slate-400">
              AI employees for calls, WhatsApp, appointments and everyday business workflows.
            </p>
            <h2 className="mt-10 font-display text-[24px] tracking-[-0.02em]">Ready to see it?</h2>
            <p className="mt-2 max-w-[320px] font-vmono text-[12px] leading-[1.7] text-slate-400">
              Tell us about your business and we will show you how it would answer.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <VxLink href="#contact">Book a Demo</VxLink>
              <VxLink to="/pricing" variant="outline-dark">
                Pricing
              </VxLink>
            </div>
          </div>

          <nav aria-label="Sections">
            <p className={HEAD}>On this page</p>
            <ul className="mt-5 space-y-1">
              {SECTIONS.map(([n, label, id]) => (
                <li key={id}>
                  <a href={`#${id}`} className={LINK}>
                    <span className="font-vmono text-[11px] text-[var(--vx-accent-hot)]">{n}</span>
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Products">
            <p className={HEAD}>Products</p>
            <ul className="mt-5 space-y-1">
              {PRODUCTS.map(([label, to]) => (
                <li key={to}>
                  <Link to={to} className={LINK}>
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Company and legal">
            <p className={HEAD}>Company</p>
            <ul className="mt-5 space-y-1">
              {COMPANY.map(([label, to]) => (
                <li key={to}>
                  <Link to={to} className={LINK}>
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-16 grid gap-6 border-t border-[var(--vx-hair-dark)] pt-8 font-vmono text-[11px] text-slate-400 sm:grid-cols-2">
          <div>
            <p className="font-medium text-slate-200">{CLICKAI_LEGAL_NAME}</p>
            {CLICKAI_ADDRESS_LINES.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <p className="sm:text-right">
            <a href="mailto:hello@clickai.in" className="inline-block py-1 hover:text-white">
              hello@clickai.in
            </a>
            {" · "}
            <a href="tel:+917660001231" className="inline-block py-1 hover:text-white">
              +91 76600 01231
            </a>
          </p>
        </div>
        <div className="mt-6 flex flex-col gap-2 font-vmono text-[10px] uppercase tracking-[0.12em] text-slate-400 sm:flex-row sm:justify-between">
          <p>
            © {new Date().getFullYear()} {CLICKAI_LEGAL_NAME}
          </p>
          <p>clickai.in</p>
        </div>
      </div>
    </footer>
  );
}
