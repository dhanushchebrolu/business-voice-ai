import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { VoicePlayer } from "./home/voice-player";
import { VxLink } from "./home/primitives";

/** Staggered entrance: 40 ms steps (matches the reference's staggered fade-up). */
const rise = (i: number) => ({ "--i": i }) as React.CSSProperties;

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** The reference shows a small live UTC clock under the header; this one is the visitor's real UTC time. */
function UtcClock() {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date().toISOString().slice(11, 19));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <p
      aria-hidden="true"
      className="absolute right-5 top-[84px] hidden font-vmono text-[11px] tracking-[0.06em] text-[var(--vx-muted)] sm:right-10 sm:block lg:right-[39px]"
    >
      <span className="mr-2 inline-block size-1.5 rounded-full bg-[var(--vx-accent)] align-middle" />
      {now ?? "--:--:--"} UTC
    </p>
  );
}

/** Cells of the illustrative console strip under the hero (a labelled example, not live data). */
const STRIP = [
  ["Received", "Call answered"],
  ["Understood", "Wants a slot tomorrow"],
  ["Action", "Availability checked"],
  ["Confirmed", "Customer said yes"],
  ["Logged", "Saved in call history"],
] as const;

/**
 * Homepage hero (layout follows the reference design): eyebrow, 64px display
 * headline, mono paragraph, solid + text buttons on the left; on the right the
 * ClickAI assistant, whose stage is a rotating dot-cube (the reference's
 * point-cloud slot) around the orb. Below, a console strip. "Book a Demo" links
 * to the real /contact route; "Explore Products" scrolls to #capabilities.
 */
export function Hero() {
  return (
    <section id="top" className="relative isolate overflow-clip bg-[var(--vx-page)] pt-[81px]">
      <div aria-hidden="true" className="vx-dots absolute inset-0 -z-10" />
      <UtcClock />
      <div className="mx-auto grid max-w-[1305px] gap-14 px-5 pb-12 pt-14 sm:px-10 lg:grid-cols-[1fr_516px] lg:items-center lg:gap-10 lg:px-[39px] lg:pb-12 lg:pt-12">
        <div>
          <p
            style={rise(0)}
            className="animate-rise font-vmono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--vx-muted)]"
          >
            AI employee platform
          </p>
          <h1
            style={rise(1)}
            className="animate-rise mt-6 max-w-[700px] text-[40px] leading-[1.2] tracking-[-0.03em] text-[var(--vx-ink)] sm:text-[56px] lg:text-[64px]"
          >
            AI Employees for Your Business, 24/7
          </h1>
          <p
            style={rise(2)}
            className="animate-rise mt-6 max-w-[480px] font-vmono text-[14px] leading-[1.7] text-[var(--vx-muted)] sm:text-[15px]"
          >
            ClickAI answers your calls and WhatsApp messages, books appointments and handles routine
            tasks for you. Press play to hear a sample call.
          </p>
          <div
            style={rise(3)}
            className="animate-rise mt-9 flex flex-wrap items-center gap-x-6 gap-y-3"
          >
            <VxLink to="/contact">Book a Demo</VxLink>
            <button
              type="button"
              onClick={() => scrollToSection("capabilities")}
              className="group inline-flex h-11 items-center gap-2 font-vmono text-[13px] font-medium uppercase tracking-[0.08em] text-[var(--vx-ink)] transition-colors hover:text-[var(--vx-accent-hot)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vx-accent)]"
            >
              Explore Products
              <span
                aria-hidden="true"
                className="transition-transform duration-200 group-hover:translate-x-1 motion-reduce:transition-none"
              >
                →
              </span>
            </button>
          </div>
          <p
            style={rise(4)}
            className="animate-rise mt-8 font-vmono text-[11px] uppercase tracking-[0.1em] text-[var(--vx-muted)]"
          >
            Set up with you · You decide when it goes live
          </p>
        </div>

        <div style={rise(2)} className="animate-rise">
          <VoicePlayer />
        </div>
      </div>

      {/* Console strip: illustrative call flow */}
      <div className="mx-auto max-w-[1305px] px-5 pb-12 sm:px-10 lg:px-[39px]">
        <div className="border border-[var(--vx-hair)] bg-[var(--vx-card)]">
          <div className="flex items-center justify-between gap-4 border-b border-[var(--vx-hair)] px-5 py-3 font-vmono text-[12px] text-[var(--vx-ink)]">
            <span>call_9f2c1a · front-desk-agent</span>
            <span className="border border-[var(--vx-hair)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--vx-muted)]">
              Illustrative example
            </span>
          </div>
          <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {STRIP.map(([label, detail], i) => (
              <li
                key={label}
                className="border-b border-r border-[var(--vx-hair)] px-5 py-4 last:border-r-0 lg:border-b-0"
              >
                <span className="flex items-center gap-2 font-vmono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--vx-muted)]">
                  <Check
                    className={`size-3.5 ${i === 3 ? "text-[var(--vx-accent)]" : "text-[var(--vx-ink)]"}`}
                    aria-hidden="true"
                  />
                  {label}
                </span>
                <span className="mt-2 block font-vmono text-[12px] text-[var(--vx-ink)]">
                  {detail}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
