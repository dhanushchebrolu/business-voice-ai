import { Link } from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { INTEGRATION_GROUPS } from "@/lib/integrations-catalog";
import { Reveal } from "./reveal";
import {
  AppointmentSurface,
  AutomationSurface,
  VoiceSurface,
  WhatsAppSurface,
} from "./product-surfaces";
import { VoiceDemo } from "./voice-demo";

/**
 * Home sections, in page order. Copy is limited to what the product pages
 * already state; there are no client counts, results or statistics here.
 * Surfaces alternate dark / paper / white so the page has rhythm
 * (docs/design-system.md).
 */

function Eyebrow({ children, dark = false }: { children: string; dark?: boolean }) {
  return (
    <p
      className={`text-xs font-medium uppercase tracking-[0.18em] ${dark ? "text-sky-300" : "text-violet-600"}`}
    >
      {children}
    </p>
  );
}

const H2 = "mt-3 font-serif text-4xl leading-[1.05] tracking-tight sm:text-5xl";

/* ───────────── Products: tabbed showcase on paper ───────────── */

const PRODUCTS = [
  {
    id: "voice",
    name: "Voice Agents",
    to: "/ai-voice-agents",
    title: "Answer every call, in your business's name",
    points: [
      "Answers inbound calls from your hours, services and FAQs",
      "Books into your calendar during the call",
      "Every call saved in call history",
    ],
    Surface: VoiceSurface,
  },
  {
    id: "whatsapp",
    name: "WhatsApp Agents",
    to: "/whatsapp-ai-agents",
    title: "Reply on WhatsApp without losing control",
    points: [
      "Official WhatsApp Business Platform",
      "Bookings change only after the customer replies YES",
      "Customers can ask for a person, and AI replies stop",
    ],
    Surface: WhatsAppSurface,
  },
  {
    id: "appointments",
    name: "Appointments",
    to: "/appointment-automation",
    title: "Bookings that respect your calendar",
    points: [
      "Weekly working hours and date-specific overrides",
      "Google Calendar events block unavailable slots",
      "Reschedule and cancel by call or WhatsApp",
    ],
    Surface: AppointmentSurface,
  },
  {
    id: "automation",
    name: "Business Automation",
    to: "/business-automation",
    title: "Turn conversations into completed tasks",
    points: [
      "Lead details captured in your dashboard",
      "Payment links through Razorpay once connected",
      "CRM and database connections are built to order",
    ],
    Surface: AutomationSurface,
  },
] as const;

export function ProductShowcase() {
  return (
    <section id="products" className="bg-paper py-20 sm:py-28">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <Reveal>
          <Eyebrow>Products</Eyebrow>
          <h2 className={`${H2} max-w-2xl text-slate-900`}>
            Four AI employees, one way of working
          </h2>
        </Reveal>

        <Tabs
          defaultValue="voice"
          orientation="vertical"
          className="mt-12 grid gap-8 lg:grid-cols-[230px_1fr] lg:gap-14"
        >
          <TabsList
            aria-label="Products"
            className="h-auto w-full flex-row justify-start gap-0 overflow-x-auto rounded-none bg-transparent p-0 lg:flex-col lg:items-stretch lg:overflow-visible"
          >
            {PRODUCTS.map((p, i) => (
              <TabsTrigger
                key={p.id}
                value={p.id}
                className="group relative min-h-11 flex-none justify-start gap-3 rounded-none border-b border-slate-300 bg-transparent px-1 py-4 text-left text-sm text-slate-600 shadow-none transition-colors hover:text-slate-900 data-[state=active]:bg-transparent data-[state=active]:text-slate-900 data-[state=active]:shadow-none lg:border-b lg:border-r-0 lg:px-0 after:absolute after:-bottom-px after:left-0 after:h-0.5 after:w-0 after:bg-violet-600 after:transition-[width] after:duration-300 data-[state=active]:after:w-full motion-reduce:after:transition-none"
              >
                <span className="font-mono text-xs text-slate-400 group-data-[state=active]:text-violet-600">
                  0{i + 1}
                </span>
                {p.name}
              </TabsTrigger>
            ))}
          </TabsList>

          {PRODUCTS.map(({ id, title, points, to, name, Surface }) => (
            <TabsContent
              key={id}
              value={id}
              className="mt-0 animate-menu focus-visible:outline-none"
            >
              <Surface />
              <div className="mt-8 grid gap-6 md:grid-cols-[1fr_1fr] md:gap-10">
                <h3 className="font-serif text-3xl leading-tight text-slate-900">{title}</h3>
                <div>
                  <ul className="space-y-3 text-sm text-slate-600">
                    {points.map((pt) => (
                      <li key={pt} className="flex gap-3 border-t border-slate-200 pt-3">
                        <span
                          aria-hidden="true"
                          className="mt-2 size-1.5 shrink-0 rounded-full bg-violet-600"
                        />
                        {pt}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to={to}
                    className="mt-6 inline-flex min-h-8 items-center gap-1.5 text-sm font-medium text-violet-600 hover:text-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-violet-600"
                  >
                    Explore {name} <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                </div>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </section>
  );
}

/* ───────────── How it works: editorial process on white ───────────── */

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
    <section id="process" className="bg-white py-20 sm:py-28">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr] lg:items-end lg:gap-16">
          <div>
            <Eyebrow>How it works</Eyebrow>
            <h2 className={`${H2} text-slate-900`}>
              From first conversation to live in five steps
            </h2>
          </div>
          <p className="max-w-md text-sm leading-relaxed text-slate-600">
            You are not left to configure it alone. We set it up with you, and you decide when it
            goes live.
          </p>
        </div>

        <ol className="relative mt-14 grid gap-10 lg:grid-cols-5 lg:gap-0">
          {/* The line that connects the five nodes (large screens only). */}
          <span
            aria-hidden="true"
            className="absolute left-0 right-0 top-[7px] hidden h-px bg-slate-300 lg:block"
          />
          {STEPS.map(([title, text], i) => (
            <li key={title} className="relative lg:pr-8">
              <Reveal delay={i * 40}>
                <span
                  aria-hidden="true"
                  className="relative z-10 block size-[15px] rounded-full border-2 border-violet-600 bg-white"
                />
                <p className="mt-6 font-mono text-xs text-slate-500">0{i + 1}</p>
                <h3 className="mt-2 text-lg font-semibold leading-snug text-slate-900">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{text}</p>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ───────────── Industries: dark list ───────────── */

const INDUSTRIES = [
  [
    "healthcare",
    "Healthcare and clinics",
    "Appointment calls and changes without tying up the front desk.",
  ],
  [
    "restaurants",
    "Restaurants and hospitality",
    "Hours, menu and booking questions during service.",
  ],
  ["real-estate", "Real estate", "Enquiries answered and requirements captured at any hour."],
  ["education", "Education", "Repeat admission and course questions, and counselling slots."],
  ["retail", "Retail and local business", "Store questions, bookings and payment links."],
  [
    "professional-services",
    "Professional services",
    "Enquiries captured and consultations booked.",
  ],
] as const;

export function IndustriesDark() {
  return (
    <section id="industries" className="bg-ink-950 py-20 text-white sm:py-28">
      <div className="mx-auto grid max-w-[1200px] gap-12 px-5 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Eyebrow dark>Solutions</Eyebrow>
          <h2 className={H2}>Built around how your industry takes calls</h2>
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-slate-300">
            Same products, different workflows. Each solution page lists what works today and what
            is custom work. No compliance claims are made.
          </p>
          <Link
            to="/solutions"
            className="mt-7 inline-flex min-h-8 items-center gap-1.5 text-sm font-medium text-sky-300 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300"
          >
            All solutions <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <ul className="border-b border-white/10">
          {INDUSTRIES.map(([hash, name, text], idx) => (
            <li key={hash} className="border-t border-white/10">
              <Link
                to="/solutions"
                hash={hash}
                className="group flex items-center justify-between gap-6 py-6 transition-colors hover:bg-white/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-300"
              >
                <span className="flex items-baseline gap-5">
                  <span className="font-mono text-xs text-slate-500" aria-hidden="true">
                    0{idx + 1}
                  </span>
                  <span>
                    <span className="block text-lg font-medium">{name}</span>
                    <span className="mt-1 block text-sm text-slate-400">{text}</span>
                  </span>
                </span>
                <ArrowUpRight
                  className="size-5 shrink-0 text-slate-500 transition-[transform,color] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-sky-300 motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ───────────── Integrations: ledger on white ───────────── */

const STATUS_STYLE = {
  Available: "text-emerald-700",
  "In development": "text-amber-700",
  "Custom integration": "text-slate-500",
} as const;

export function IntegrationsLedger() {
  return (
    <section id="integrations" className="bg-white py-20 sm:py-28">
      <div className="mx-auto grid max-w-[1200px] gap-12 px-5 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Eyebrow>Integrations</Eyebrow>
          <h2 className={`${H2} text-slate-900`}>Honest about what connects today</h2>
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-slate-600">
            Only integrations with a working connect flow are marked Available. The rest are either
            in development or built for your project.
          </p>
          <Link
            to="/integrations"
            className="mt-7 inline-flex min-h-8 items-center gap-1.5 text-sm font-medium text-violet-600 hover:text-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-violet-600"
          >
            Full integrations list <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <Reveal>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Integrations and their status</caption>
            <thead className="text-xs uppercase tracking-[0.14em] text-slate-500">
              <tr>
                <th scope="col" className="pb-3 font-medium">
                  Integration
                </th>
                <th scope="col" className="pb-3 font-medium">
                  Category
                </th>
                <th scope="col" className="pb-3 text-right font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {INTEGRATION_GROUPS.flatMap((g) =>
                g.items.map((it) => (
                  <tr key={`${g.heading}-${it.name}`} className="border-t border-slate-200">
                    <th scope="row" className="py-3 pr-4 font-medium text-slate-900">
                      {it.name}
                    </th>
                    <td className="py-3 pr-4 text-slate-500">{g.heading}</td>
                    <td className={`py-3 text-right font-medium ${STATUS_STYLE[it.status]}`}>
                      {it.status}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </Reveal>
      </div>
    </section>
  );
}

/* ───────────── Why ClickAI: paper ───────────── */

const COMPARISON = [
  ["Calls arrive after hours", "Answered at any hour"],
  ["Customers wait for a callback", "Replies start immediately"],
  ["Staff repeat the same answers", "The agent answers from your information"],
  ["Booking takes phone tag", "Booked against live calendar availability"],
  ["Answers vary from person to person", "The same information every time"],
  ["Calendar, chat and payments live apart", "Connected: Google Calendar, WhatsApp, Razorpay"],
] as const;

export function WhyClickAI() {
  return (
    <section id="why" className="bg-paper py-20 sm:py-28">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <Eyebrow>Why ClickAI</Eyebrow>
        <h2 className={`${H2} max-w-3xl text-slate-900`}>
          Take the repeat work off your team, keep the relationships with them
        </h2>
        <p className="mt-5 max-w-xl text-sm leading-relaxed text-slate-600">
          A qualitative comparison, not a benchmark: no figures are claimed. A person stays in the
          loop, with handoff to your team and every conversation visible in your dashboard.
        </p>

        <table className="mt-12 w-full border-collapse text-left">
          <caption className="sr-only">Typical situation compared with a ClickAI employee</caption>
          <thead>
            <tr className="text-xs uppercase tracking-[0.14em]">
              <th
                scope="col"
                className="w-1/2 border-b border-slate-300 pb-3 pr-6 font-medium text-slate-500"
              >
                Typical today
              </th>
              <th
                scope="col"
                className="w-1/2 border-b border-violet-600 pb-3 pl-6 font-medium text-violet-700"
              >
                With a ClickAI employee
              </th>
            </tr>
          </thead>
          <tbody>
            {COMPARISON.map(([before, after]) => (
              <tr key={before}>
                <td className="border-b border-slate-200 py-5 pr-6 align-top text-sm text-slate-500 sm:text-base">
                  {before}
                </td>
                <td className="border-b border-slate-200 py-5 pl-6 align-top text-sm font-medium text-slate-900 sm:text-base">
                  {after}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ───────────── Demo: dark, with the real recorded sample ───────────── */

export function HomeDemo() {
  return (
    <section id="demo" className="bg-ink-950 py-20 text-white sm:py-28">
      <div className="mx-auto grid max-w-[1200px] items-center gap-12 px-5 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
        <div>
          <Eyebrow dark>Hear it</Eyebrow>
          <h2 className={H2}>A recorded sample of an AI receptionist</h2>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-slate-300">
            This is a pre-recorded sample of a ClickAI voice agent, not a live call. For your own
            business we configure the agent from your details and let you test it before launch.
          </p>
          <Link to="/contact" className="mt-8 inline-block">
            <Button
              size="lg"
              className="h-12 rounded-full bg-violet-600 px-7 text-white hover:bg-violet-500 active:scale-[0.98]"
            >
              Book a Demo
            </Button>
          </Link>
        </div>
        <div className="theme-light rounded-2xl bg-white p-2 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)]">
          <VoiceDemo />
        </div>
      </div>
    </section>
  );
}

/* ───────────── FAQ ───────────── */

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
    <section id="faq" className="bg-white py-20 sm:py-28">
      <div className="mx-auto grid max-w-[1200px] gap-12 px-5 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
        <div>
          <Eyebrow>FAQ</Eyebrow>
          <h2 className={`${H2} text-slate-900`}>Common questions</h2>
        </div>
        <Accordion type="single" collapsible className="border-b border-slate-200">
          {FAQS.map(([q, a], i) => (
            <AccordionItem key={q} value={`q${i}`} className="border-slate-200">
              <AccordionTrigger className="py-5 text-base font-medium text-slate-900 hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-600">
                {q}
              </AccordionTrigger>
              <AccordionContent className="text-sm leading-relaxed text-slate-600">
                {a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
