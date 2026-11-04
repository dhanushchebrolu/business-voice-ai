import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Reveal } from "./reveal";

/**
 * Home sections that point to the real product pages. Copy is limited to
 * what the product pages already state; there are no client counts, results
 * or statistics anywhere in this file.
 */

const PRODUCTS = [
  {
    name: "AI Voice Agents",
    to: "/ai-voice-agents",
    text: "Answer business calls, book appointments and keep a record of every call.",
    use: "A clinic whose front desk is busy with patients.",
  },
  {
    name: "WhatsApp AI Agents",
    to: "/whatsapp-ai-agents",
    text: "Reply to enquiries on the official WhatsApp Business Platform and hand over to your team.",
    use: "A salon confirming and moving bookings.",
  },
  {
    name: "Appointment Automation",
    to: "/appointment-automation",
    text: "Working hours, daily overrides and Google Calendar sync for bookings that do not clash.",
    use: "A consultancy taking calls across time zones.",
  },
  {
    name: "Business Automation",
    to: "/business-automation",
    text: "Turn conversations into leads and follow-ups; connections to your systems are built to order.",
    use: "A service business re-keying enquiries by hand.",
  },
] as const;

export function ProductsOverview() {
  return (
    <section id="products" className="border-t border-slate-200 bg-white py-20 sm:py-24">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-violet-600">Products</p>
        <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          Four ways to put an AI employee to work
        </h2>
        <Reveal>
          <ul className="mt-10 grid gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-2">
            {PRODUCTS.map((p) => (
              <li key={p.to} className="bg-white">
                <Link
                  to={p.to}
                  className="group flex h-full flex-col p-6 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-600"
                >
                  <h3 className="text-base font-semibold text-slate-900">{p.name}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">{p.text}</p>
                  <p className="mt-3 text-xs text-slate-500">Typical use: {p.use}</p>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-violet-600">
                    Learn more
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Reveal>
        <p className="mt-5 text-sm text-slate-500">
          Need to connect something else?{" "}
          <Link to="/integrations" className="text-violet-600 underline underline-offset-2">
            See integrations
          </Link>{" "}
          or{" "}
          <Link to="/solutions" className="text-violet-600 underline underline-offset-2">
            browse by industry
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

const STEPS = [
  ["Understand requirements", "We learn how your business takes calls, messages and bookings."],
  [
    "Configure the AI employee",
    "Your services, hours, FAQs and rules become the agent's knowledge.",
  ],
  [
    "Connect business systems",
    "Calendar, WhatsApp and telephony are connected; custom links are scoped.",
  ],
  ["Test workflows", "You try real conversations before anything goes live."],
  ["Deploy and monitor", "Go live and review calls and conversations in your dashboard."],
] as const;

export function HowItWorks() {
  return (
    <section className="border-t border-slate-200 bg-slate-50 py-20 sm:py-24">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-violet-600">
          How it works
        </p>
        <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          From first conversation to live in five steps
        </h2>
        <Reveal>
          <ol className="mt-10 grid gap-4 md:grid-cols-5">
            {STEPS.map(([title, text], i) => (
              <li key={title} className="rounded-xl border border-slate-200 bg-white p-5">
                <span className="text-xs font-medium text-violet-600">0{i + 1}</span>
                <h3 className="mt-2 text-sm font-semibold text-slate-900">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{text}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  );
}

const REASONS = [
  ["Always available", "Calls and messages are answered outside business hours too."],
  ["Faster responses", "Customers are not left waiting for a callback."],
  ["Less repetitive work", "Common questions and bookings no longer take staff time."],
  ["Consistent answers", "The agent answers from the information you gave it."],
  ["Works with what you have", "Google Calendar, WhatsApp and Razorpay today; others on request."],
] as const;

export function WhyClickAI() {
  return (
    <section className="border-t border-slate-200 bg-white py-20 sm:py-24">
      <div className="mx-auto grid max-w-[1200px] gap-10 px-5 sm:px-8 lg:grid-cols-[1fr_1.4fr]">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-violet-600">
            Why ClickAI
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            Practical automation for everyday business conversations
          </h2>
        </div>
        <Reveal>
          <dl className="divide-y divide-slate-200 border-y border-slate-200">
            {REASONS.map(([t, d]) => (
              <div key={t} className="grid gap-1 py-4 sm:grid-cols-[200px_1fr] sm:gap-6">
                <dt className="text-sm font-semibold text-slate-900">{t}</dt>
                <dd className="text-sm text-slate-600">{d}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </section>
  );
}

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

export function HomeFaq() {
  return (
    <section id="faq" className="border-t border-slate-200 bg-slate-50 py-20 sm:py-24">
      <div className="mx-auto max-w-[800px] px-5 sm:px-8">
        <h2 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          Common questions
        </h2>
        <div className="mt-8 divide-y divide-slate-200 border-y border-slate-200">
          {FAQS.map(([q, a]) => (
            <details key={q} className="group py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-600">
                {q}
                <span
                  aria-hidden="true"
                  className="text-slate-400 transition-transform group-open:rotate-45 motion-reduce:transition-none"
                >
                  +
                </span>
              </summary>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
