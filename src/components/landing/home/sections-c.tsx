import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { Link } from "@tanstack/react-router";
import { PLANS } from "@/routes/pricing";
import {
  Enter,
  H2,
  Marquee,
  MONO_P,
  RollNumber,
  ScrollFill,
  VxLink,
  VxSection,
} from "./primitives";

/* ───── 06 Controls (replaces the reference's compliance table; every row is documented WhatsApp-agent behaviour) ───── */

const CONTROLS = [
  [
    "Consent",
    "STOP and START are recorded. Marketing messages go only to contacts with recorded consent.",
  ],
  [
    "Confirmation",
    "A booking or reschedule changes only after the customer replies YES. Proposals expire after 15 minutes.",
  ],
  [
    "Availability",
    "Slots are re-checked at the moment of booking, so two customers cannot take the same one.",
  ],
  ["Handoff", "A customer who asks for a person turns AI replies off for that conversation."],
  ["Rate limit", "AI replies are limited to 5 in 10 minutes per conversation."],
  ["Payments", "Payment status changes only from verified Razorpay webhooks."],
  ["Signatures", "WhatsApp webhooks are accepted only with a valid Meta signature."],
] as const;

export function Controls() {
  return (
    <VxSection id="controls" index="06" label="Controls" bg="alt">
      <Enter>
        <h2 className={`${H2} max-w-[640px]`}>
          Built-in controls for the WhatsApp agent, written down.
        </h2>
      </Enter>
      <dl className="mt-14 border-b border-[var(--vx-hair)]">
        {CONTROLS.map(([k, v], i) => (
          <Enter key={k} delay={i * 30}>
            <div className="grid gap-2 border-t border-[var(--vx-hair)] py-5 md:grid-cols-[220px_1fr] md:gap-8">
              <dt className="font-vmono text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--vx-muted)]">
                {k}
              </dt>
              <dd className="font-vmono text-[14px] leading-[1.7] text-[var(--vx-ink)]">{v}</dd>
            </div>
          </Enter>
        ))}
      </dl>
      <p className="mt-8 font-vmono text-[12px] text-[var(--vx-muted)]">
        ClickAI does not claim compliance certifications. Read the{" "}
        <Link
          to="/privacy-policy"
          className="text-[var(--vx-ink)] underline underline-offset-4 hover:text-[var(--vx-accent)]"
        >
          Privacy Policy
        </Link>{" "}
        and{" "}
        <Link
          to="/messaging-policy"
          className="text-[var(--vx-ink)] underline underline-offset-4 hover:text-[var(--vx-accent)]"
        >
          Messaging Policy
        </Link>
        .
      </p>
    </VxSection>
  );
}

/* ───── 07 Today (capability statements only: no customer quotes or figures) ───── */

const TODAY = [
  [
    "Voice",
    "Answers inbound calls from the information you configure, and books into your calendar during the call.",
  ],
  [
    "WhatsApp",
    "Replies on the official Business Platform, proposes bookings, and waits for a clear YES.",
  ],
  [
    "Calendar",
    "Uses weekly hours, date overrides and Google Calendar busy times to offer real slots.",
  ],
  [
    "Payments",
    "Shares Razorpay payment links in conversation once a Razorpay account is connected.",
  ],
] as const;

export function Today() {
  return (
    <VxSection id="today" index="07" label="Today">
      <ScrollFill
        text="What it does today, in plain terms."
        className="max-w-[640px] text-[28px] leading-[1.2] sm:text-[40px]"
      />
      <Marquee label="Capabilities available today" seconds={70} className="mt-14">
        {[...TODAY, ...TODAY].map(([tag, text], i) => (
          <article
            key={`${tag}-${i}`}
            className="mr-4 flex min-h-[230px] w-[340px] shrink-0 flex-col justify-between border border-[var(--vx-hair)] bg-[var(--vx-card)] p-6"
          >
            <p className="font-display text-[20px] leading-[1.3] tracking-[-0.01em]">{text}</p>
            <p className="mt-8 flex items-center justify-between font-vmono text-[11px] font-medium uppercase tracking-[0.12em]">
              <span className="text-[var(--vx-ink)]">{tag}</span>
              <span className="text-[var(--vx-accent-deep)]">Available</span>
            </p>
          </article>
        ))}
      </Marquee>
    </VxSection>
  );
}

/* ───── 08 Status (replaces the changelog: undated status timeline, full-bleed accent, ticker) ───── */

const STATUS = [
  ["Available now", "Voice, WhatsApp, calendar, payments", "Connect from your dashboard."],
  ["In development", "SMS, email, HubSpot, Zoho", "Not live yet."],
  ["Built to order", "CRM links, webhooks, your database", "Scoped and quoted per project."],
  ["How we work", "Set up with you", "You test it before it goes live."],
] as const;

export function Status() {
  return (
    <VxSection id="status" index="08" label="Status" bg="accent">
      <Enter>
        <h2 className={`${H2} max-w-[640px] text-white`}>
          Available now, in development, built to order.
        </h2>
      </Enter>
      <ol className="relative mt-16 grid gap-10 md:grid-cols-4 md:gap-6">
        <span
          aria-hidden="true"
          className="absolute left-0 right-0 top-[5px] hidden h-px bg-white/40 md:block"
        />
        {STATUS.map(([k, title, note], i) => (
          <li key={k} className="relative">
            <Enter delay={i * 40}>
              <span
                aria-hidden="true"
                className="relative z-10 block size-[11px] rotate-45 bg-white"
              />
              <p className="mt-6 font-vmono text-[11px] font-medium uppercase tracking-[0.14em] text-white">
                {k}
              </p>
              <h3 className="mt-3 font-display text-[20px] leading-tight tracking-[-0.01em]">
                {title}
              </h3>
              <p className="mt-2 font-vmono text-[13px] leading-[1.7] text-white">{note}</p>
            </Enter>
          </li>
        ))}
      </ol>
      <Marquee label="Configure, answer, book, confirm, hand off" seconds={36} className="mt-20">
        {["Configure", "Answer", "Book", "Confirm", "Hand off", "On the record"].map((w) => (
          <span
            key={w}
            className="flex items-center font-display text-[56px] leading-none tracking-[-0.03em] sm:text-[84px]"
          >
            {w}
            <span aria-hidden="true" className="mx-8 text-[0.5em] opacity-70">
              •
            </span>
          </span>
        ))}
      </Marquee>
    </VxSection>
  );
}

/* ───── 09 Pricing: the real plans from the pricing page ───── */

export function Pricing() {
  return (
    <VxSection id="pricing" index="09" label="Pricing">
      <ScrollFill
        text="Priced per plan, with usage on top."
        className="max-w-[640px] text-[28px] leading-[1.2] sm:text-[40px]"
      />
      <p className={`${MONO_P} mt-6 max-w-[560px]`}>
        A one-time setup fee activates your workspace. Call minutes beyond your plan are billed from
        your wallet at your workspace rate.
      </p>
      <div className="mt-14 grid items-stretch gap-px border border-[var(--vx-tile)] bg-[var(--vx-tile)] lg:grid-cols-3">
        {PLANS.map((plan) => {
          const hl = "highlighted" in plan && plan.highlighted;
          const muted = hl ? "text-slate-400" : "text-[var(--vx-muted)]";
          return (
            <div
              key={plan.id}
              className={
                hl
                  ? "flex flex-col bg-[var(--vx-dark)] p-8 text-white"
                  : "flex flex-col bg-[var(--vx-card)] p-8 text-[var(--vx-ink)]"
              }
            >
              <p
                className={`flex items-center justify-between font-vmono text-[11px] font-medium uppercase tracking-[0.14em] ${muted}`}
              >
                {plan.name}
                {hl ? (
                  <span className="border border-[var(--vx-accent-hot)] px-1.5 py-px text-[10px] text-[var(--vx-accent-hot)]">
                    Most popular
                  </span>
                ) : null}
              </p>
              <p className="mt-6 flex items-baseline gap-2 font-display text-[48px] tracking-[-0.04em]">
                ₹<RollNumber value={plan.price.toLocaleString("en-IN")} />
                <span className={`font-vmono text-[13px] tracking-normal ${muted}`}>/ month</span>
              </p>
              <p className={`mt-3 font-vmono text-[13px] leading-[1.7] ${muted}`}>{plan.blurb}</p>
              <ul className="mt-8 flex-1 space-y-3 border-t border-current/15 pt-6 font-vmono text-[12px]">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-3">
                    <span aria-hidden="true" className={muted}>
                      —
                    </span>
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <VxLink
                  to="/auth"
                  search={{ mode: "signup", plan: plan.id }}
                  variant={hl ? "solid" : "outline"}
                >
                  Get started
                </VxLink>
                <VxLink to="/contact" variant="text" className={hl ? "text-white" : ""}>
                  Book a Demo
                </VxLink>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-6 font-vmono text-[12px] text-[var(--vx-muted)]">
        Telephony, AI usage and WhatsApp conversation charges apply. Custom integrations are quoted
        per project.{" "}
        <Link
          to="/pricing"
          className="text-[var(--vx-ink)] underline underline-offset-4 hover:text-[var(--vx-accent)]"
        >
          Full pricing details
        </Link>
      </p>
    </VxSection>
  );
}

/* ───── 10 FAQ ───── */

const FAQS = [
  [
    "Does ClickAI answer real phone calls?",
    "Yes. Voice agents answer calls to your business number using the information you configure. Telephony and AI usage costs apply.",
  ],
  [
    "Is the assistant on this page a live call?",
    "No. It is the ClickAI website assistant answering in text, with optional browser voice. It shows the idea, not a call.",
  ],
  [
    "What does it connect to today?",
    "WhatsApp Business, voice telephony, website chat, Instagram, Google Calendar and Razorpay. Other systems are in development or built as custom work.",
  ],
  [
    "How does pricing work?",
    "Plans and usage charges are on the pricing page. Custom integrations are quoted per project.",
  ],
  [
    "Does it replace my team?",
    "It handles repeatable conversations and bookings and hands over to your team when asked.",
  ],
] as const;

export function Faq() {
  return (
    <VxSection id="faq" index="10" label="Questions">
      <ScrollFill text="Before you ask." className="text-[28px] leading-[1.2] sm:text-[40px]" />
      <AccordionPrimitive.Root
        type="single"
        collapsible
        className="mt-12 border-b border-[var(--vx-hair)]"
      >
        {FAQS.map(([q, a], i) => (
          <AccordionPrimitive.Item
            key={q}
            value={`q${i}`}
            className="border-t border-[var(--vx-hair)]"
          >
            <AccordionPrimitive.Header>
              <AccordionPrimitive.Trigger className="group flex min-h-16 w-full items-center justify-between gap-6 py-4 text-left font-display text-[18px] tracking-[-0.01em] transition-colors hover:text-[var(--vx-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--vx-accent)] sm:text-[20px]">
                {q}
                <span
                  aria-hidden="true"
                  className="font-vmono text-[22px] transition-transform duration-300 group-data-[state=open]:rotate-45 motion-reduce:transition-none"
                >
                  +
                </span>
              </AccordionPrimitive.Trigger>
            </AccordionPrimitive.Header>
            <AccordionPrimitive.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
              <p className={`${MONO_P} max-w-[640px] pb-6 text-[13px]`}>{a}</p>
            </AccordionPrimitive.Content>
          </AccordionPrimitive.Item>
        ))}
      </AccordionPrimitive.Root>
    </VxSection>
  );
}

/* ───── closing CTA ───── */

export function Cta() {
  return (
    <VxSection id="cta" bg="dark">
      <div className="max-w-[760px] py-6">
        <h2 className="text-[40px] leading-[1.1] tracking-[-0.03em] sm:text-[64px]">
          Give Your Business an AI Employee.
        </h2>
        <p className="mt-6 max-w-[520px] font-vmono text-[14px] leading-[1.7] text-slate-400">
          See how ClickAI would answer your calls and messages, configured from your own business
          details.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <VxLink to="/contact">Book a Demo</VxLink>
          <VxLink to="/pricing" variant="outline-dark">
            See pricing
          </VxLink>
        </div>
      </div>
    </VxSection>
  );
}
