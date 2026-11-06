import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { CLICKAI_ADDRESS_LINES, CLICKAI_LEGAL_NAME } from "@/lib/company-info";
import {
  EMPTY_DEMO_REQUEST,
  INDUSTRIES,
  INTERESTS,
  submitDemoRequest,
  type DemoRequestForm,
} from "@/lib/demo-request";
import { INDUSTRIES as SOLUTIONS, PRODUCTS } from "@/routes/solutions";
import { Enter, H2, VxSection } from "./primitives";

/* ───── Solutions: the industries and workflows from the solutions page ───── */

export function Solutions() {
  return (
    <VxSection id="solutions" index="" label="Solutions" bg="alt">
      <Enter>
        <h2 className={`${H2} max-w-[680px]`}>
          Built around how your business takes calls and messages
        </h2>
      </Enter>
      <ul className="mt-14 grid gap-px border border-[var(--vx-hair)] bg-[var(--vx-hair)] md:grid-cols-2 lg:grid-cols-3">
        {SOLUTIONS.map((s, i) => (
          <li key={s.id} className="bg-[var(--vx-page)]">
            <Enter delay={(i % 3) * 40} className="h-full">
              <div className="flex h-full flex-col p-7">
                <h3 className="text-[20px] leading-tight tracking-[-0.01em]">{s.name}</h3>
                <p className="mt-3 font-vmono text-[13px] leading-[1.7] text-[var(--vx-muted)]">
                  {s.problem}
                </p>
                <p className="mt-4 font-vmono text-[12px] leading-[1.7] text-[var(--vx-ink)]">
                  {s.workflow}
                </p>
                <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-6">
                  {s.products.map((p) => (
                    <Link
                      key={p}
                      to={PRODUCTS[p].to}
                      className="inline-flex min-h-8 items-center font-vmono text-[11px] uppercase tracking-[0.08em] text-[var(--vx-accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vx-accent)]"
                    >
                      {PRODUCTS[p].label} →
                    </Link>
                  ))}
                </div>
              </div>
            </Enter>
          </li>
        ))}
      </ul>
    </VxSection>
  );
}

/* ───── Contact / Book a Demo: real details and the real demo-request form ───── */

const FIELD =
  "h-11 w-full border border-[var(--vx-hair)] bg-[var(--vx-card)] px-3 font-vmono text-[13px] text-[var(--vx-ink)] placeholder:text-[var(--vx-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--vx-accent)]";
const LABEL =
  "mb-1.5 block font-vmono text-[11px] uppercase tracking-[0.1em] text-[var(--vx-muted)]";

export function Contact() {
  const [form, setForm] = useState<DemoRequestForm>(EMPTY_DEMO_REQUEST);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const set = (k: keyof DemoRequestForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // duplicate-submission guard
    setBusy(true);
    setError(null);
    const err = await submitDemoRequest(form, consent);
    setBusy(false);
    if (err) setError(err);
    else setSent(true);
  }

  return (
    <VxSection id="contact" index="" label="Contact" bg="dark">
      <div className="grid gap-14 lg:grid-cols-[1fr_520px]">
        <div>
          <h2 className="max-w-[560px] text-[40px] leading-[1.1] tracking-[-0.03em] sm:text-[56px]">
            Give Your Business an AI Employee.
          </h2>
          <p className="mt-6 max-w-[480px] font-vmono text-[14px] leading-[1.7] text-slate-300">
            Tell us about your business and a member of the ClickAI team will reach out to show you
            how it would answer your calls and messages.
          </p>
          <dl className="mt-10 space-y-5 font-vmono text-[13px]">
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-slate-400">Email</dt>
              <dd className="mt-1">
                <a
                  href="mailto:hello@clickai.in"
                  className="inline-block py-1 hover:text-[var(--vx-accent-hot)]"
                >
                  hello@clickai.in
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-slate-400">Phone</dt>
              <dd className="mt-1">
                <a
                  href="tel:+917660001231"
                  className="inline-block py-1 hover:text-[var(--vx-accent-hot)]"
                >
                  +91 76600 01231
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-slate-400">Business</dt>
              <dd className="mt-1 leading-[1.7] text-slate-300">
                {CLICKAI_LEGAL_NAME}
                {CLICKAI_ADDRESS_LINES.map((l) => (
                  <span key={l} className="block">
                    {l}
                  </span>
                ))}
              </dd>
            </div>
          </dl>
        </div>

        <div className="border border-[var(--vx-hair-dark)] bg-[var(--vx-page)] p-6 text-[var(--vx-ink)] sm:p-8">
          {sent ? (
            <div role="status" className="py-10 text-center">
              <h3 className="text-[24px]">Request received</h3>
              <p className="mt-3 font-vmono text-[13px] leading-[1.7] text-[var(--vx-muted)]">
                Thanks{form.name ? `, ${form.name}` : ""}. Someone from the ClickAI team will reach
                out at {form.email}.
              </p>
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="space-y-4">
              <h3 className="text-[22px]">Book a demo</h3>
              <div>
                <label htmlFor="hc-name" className={LABEL}>
                  Your name
                </label>
                <input
                  id="hc-name"
                  required
                  maxLength={120}
                  autoComplete="name"
                  value={form.name}
                  onChange={(e) => set("name")(e.target.value)}
                  className={FIELD}
                />
              </div>
              <div>
                <label htmlFor="hc-email" className={LABEL}>
                  Work email
                </label>
                <input
                  id="hc-email"
                  required
                  type="email"
                  autoComplete="email"
                  value={form.email}
                  onChange={(e) => set("email")(e.target.value)}
                  className={FIELD}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="hc-business" className={LABEL}>
                    Business name
                  </label>
                  <input
                    id="hc-business"
                    autoComplete="organization"
                    value={form.businessName}
                    onChange={(e) => set("businessName")(e.target.value)}
                    className={FIELD}
                  />
                </div>
                <div>
                  <label htmlFor="hc-phone" className={LABEL}>
                    Phone (optional)
                  </label>
                  <input
                    id="hc-phone"
                    type="tel"
                    autoComplete="tel"
                    value={form.phone}
                    onChange={(e) => set("phone")(e.target.value)}
                    className={FIELD}
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="hc-industry" className={LABEL}>
                    Industry (optional)
                  </label>
                  <select
                    id="hc-industry"
                    value={form.industry}
                    onChange={(e) => set("industry")(e.target.value)}
                    className={FIELD}
                  >
                    <option value="">Select</option>
                    {INDUSTRIES.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="hc-interest" className={LABEL}>
                    Product interest (optional)
                  </label>
                  <select
                    id="hc-interest"
                    value={form.interest}
                    onChange={(e) => set("interest")(e.target.value)}
                    className={FIELD}
                  >
                    <option value="">Select</option>
                    {INTERESTS.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label htmlFor="hc-message" className={LABEL}>
                  What would you like to see? (optional)
                </label>
                <textarea
                  id="hc-message"
                  rows={3}
                  maxLength={1500}
                  value={form.message}
                  onChange={(e) => set("message")(e.target.value)}
                  className={`${FIELD} h-auto py-2`}
                />
              </div>
              <div className="flex items-start gap-3">
                <input
                  id="hc-consent"
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-1 size-4 shrink-0 accent-[var(--vx-accent)]"
                />
                <label
                  htmlFor="hc-consent"
                  className="font-vmono text-[11px] leading-[1.7] text-[var(--vx-muted)]"
                >
                  I agree to be contacted by ClickAI about my enquiry, by call, email, WhatsApp or
                  SMS where applicable. Message and data rates may apply. See the{" "}
                  <Link to="/privacy-policy" className="underline">
                    Privacy Policy
                  </Link>
                  ,{" "}
                  <Link to="/terms" className="underline">
                    Terms
                  </Link>{" "}
                  and{" "}
                  <Link to="/messaging-policy" className="underline">
                    Messaging Policy
                  </Link>
                  .
                </label>
              </div>
              {error ? (
                <p
                  role="alert"
                  className="border border-red-500/50 px-3 py-2 font-vmono text-[12px] text-red-500"
                >
                  {error}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={busy || !consent}
                className="inline-flex h-11 w-full items-center justify-center gap-2 bg-[var(--vx-btn)] font-vmono text-[13px] font-medium uppercase tracking-[0.08em] text-white transition-colors hover:bg-[var(--vx-accent-hot)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vx-accent)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                Send request
              </button>
            </form>
          )}
        </div>
      </div>
    </VxSection>
  );
}
