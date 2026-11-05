import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { INTEGRATION_GROUPS } from "@/lib/integrations-catalog";
import { cn } from "@/lib/utils";
import {
  IlCalendar,
  IlChat,
  IlFlow,
  IlFunnel,
  IlHandoff,
  IlHex,
  IlPayments,
  IlStack,
  IlVoice,
} from "./illustrations";
import { Enter, MONO_P, RollNumber, ScrollFill, VxSection } from "./primitives";

/* ───── 03 Capabilities: hairline-gap grid, hover = accent title + top rule ───── */

const CAPS: [string, string, ReactNode][] = [
  [
    "AI voice receptionist",
    "Answers inbound calls from your hours, services and FAQs, and saves every call in call history.",
    <IlVoice key="v" />,
  ],
  [
    "WhatsApp agent",
    "Replies on the official WhatsApp Business Platform. Customers can ask for a person at any point.",
    <IlChat key="c" />,
  ],
  [
    "Appointment booking",
    "Weekly hours, date overrides and Google Calendar busy times decide which slots are offered.",
    <IlCalendar key="a" />,
  ],
  [
    "Lead capture",
    "Collects the details you specify during a call or chat and stores them in your dashboard.",
    <IlFunnel key="l" />,
  ],
  [
    "Workflow automation",
    "Payment links, booking confirmations and reminders. Links to your own systems are built to order.",
    <IlFlow key="w" />,
  ],
  [
    "Handoff to your team",
    "Callers can be offered your transfer number; a WhatsApp customer asking for a person stops AI replies.",
    <IlHandoff key="h" />,
  ],
];

export function Capabilities() {
  return (
    <VxSection id="capabilities" index="03" label="Capabilities">
      <ScrollFill
        text="Everything a front desk handles, from day one."
        className="max-w-[760px] text-[28px] leading-[1.2] sm:text-[40px]"
      />
      <ul className="mt-14 grid gap-px border border-[var(--vx-tile)] bg-[var(--vx-tile)] sm:grid-cols-2 lg:grid-cols-3">
        {CAPS.map(([title, text, art], i) => (
          <li key={title} className="bg-[var(--vx-page)]">
            <Enter delay={(i % 3) * 40} className="h-full">
              <div className="group relative flex h-full flex-col p-8">
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-0.5 origin-left scale-x-0 bg-[var(--vx-accent)] transition-transform duration-300 group-hover:scale-x-100 motion-reduce:transition-none"
                />
                <div className="h-28 w-full max-w-[220px] text-[var(--vx-ink)] transition-colors duration-300 group-hover:text-[var(--vx-accent-deep)]">
                  {art}
                </div>
                <h3 className="mt-8 text-[20px] leading-tight tracking-[-0.01em] transition-colors duration-200 group-hover:text-[var(--vx-accent)]">
                  {title}
                </h3>
                <p className={`${MONO_P} mt-3 text-[13px]`}>{text}</p>
              </div>
            </Enter>
          </li>
        ))}
      </ul>
    </VxSection>
  );
}

/* ───── 04 Activity console (dark): filterable illustrative table + example configuration ───── */

type Outcome = "Booked" | "Answered" | "Handed off" | "Needs review";
const ROWS: [string, string, string, Outcome][] = [
  ["conv_9f2c1a", "Voice", "Book an appointment", "Booked"],
  ["conv_9f2b84", "WhatsApp", "Move an appointment", "Booked"],
  ["conv_9f2b12", "Voice", "Asked for a person", "Handed off"],
  ["conv_9f2a77", "WhatsApp", "Question about opening hours", "Answered"],
  ["conv_9f2a05", "Voice", "Unclear request, call dropped", "Needs review"],
];
const FILTERS = ["All", "Booked", "Answered", "Handed off", "Needs review"] as const;
const OUTCOME_STYLE: Record<Outcome, string> = {
  Booked: "border-emerald-400/40 text-emerald-300",
  Answered: "border-white/25 text-slate-300",
  "Handed off": "border-violet-300/50 text-violet-300",
  "Needs review": "border-amber-400/50 text-amber-300",
};

const SNIPPETS = {
  voice: `agent:        front-desk
greeting:     "Thanks for calling {business}"
hours:        mon-fri 09:00-18:00
after_hours:  take a message
transfer_to:  <your staff number>`,
  whatsapp: `channel:        whatsapp-business
replies:        from your business details
booking:        propose, then wait for YES
proposal_ttl:   15 min
human_request:  stop AI replies`,
  calendar: `provider:      google-calendar
weekly_hours:  mon-sat
overrides:     closed on selected dates
busy_times:    block those slots
on_sync_fail:  keep booking, retry`,
} as const;

export function Console() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [tab, setTab] = useState<keyof typeof SNIPPETS>("voice");
  const [copied, setCopied] = useState(false);
  const rows = ROWS.filter((r) => filter === "All" || r[3] === filter);

  return (
    <VxSection id="console" index="04" label="Activity" bg="dark">
      <ScrollFill
        text="One place for every call and conversation."
        className="max-w-[640px] text-[28px] leading-[1.2] [--vx-faint:#4b5057] [--vx-ink:#ffffff] sm:text-[40px]"
      />
      <p className="mt-6 max-w-[600px] font-vmono text-[14px] leading-[1.7] text-slate-400">
        Filter by channel or outcome and read any conversation from top to bottom, exactly as it
        happened. The rows below are an illustrative example.
      </p>

      <div className="mt-12 border border-[var(--vx-hair-dark)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--vx-hair-dark)] p-4">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "h-8 border px-3 font-vmono text-[11px] font-medium uppercase tracking-[0.1em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300",
                filter === f
                  ? "border-white bg-white text-[var(--vx-dark)]"
                  : "border-white/25 text-slate-300 hover:border-white",
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left font-vmono text-[13px]">
            <caption className="sr-only">Example conversations</caption>
            <thead className="text-[10px] uppercase tracking-[0.12em] text-slate-400">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Conversation
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Channel
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Request
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Outcome
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([id, channel, request, outcome]) => (
                <tr
                  key={id}
                  className="border-t border-[var(--vx-hair-dark)] transition-colors hover:bg-white/[0.04]"
                >
                  <td className="px-4 py-3.5 text-slate-300">{id}</td>
                  <td className="px-4 py-3.5 text-white">{channel}</td>
                  <td className="px-4 py-3.5 text-slate-300">{request}</td>
                  <td className="px-4 py-3.5 text-right">
                    <span
                      className={cn(
                        "inline-block border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em]",
                        OUTCOME_STYLE[outcome],
                      )}
                    >
                      {outcome}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-[var(--vx-hair-dark)]">
          <div className="flex items-center justify-between border-b border-[var(--vx-hair-dark)] px-4">
            <div role="tablist" aria-label="Example configuration" className="flex">
              {(Object.keys(SNIPPETS) as (keyof typeof SNIPPETS)[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => {
                    setTab(k);
                    setCopied(false);
                  }}
                  className={cn(
                    "h-11 border-b-2 px-4 font-vmono text-[11px] font-medium uppercase tracking-[0.1em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-300",
                    tab === k
                      ? "border-[var(--vx-accent-hot)] text-white"
                      : "border-transparent text-slate-400 hover:text-white",
                  )}
                >
                  {k}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(SNIPPETS[tab]).then(() => setCopied(true));
              }}
              className="font-vmono text-[11px] font-medium uppercase tracking-[0.1em] text-slate-400 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre
            role="tabpanel"
            className="overflow-x-auto p-5 font-vmono text-[13px] leading-[1.8] text-slate-300"
          >
            <code>{SNIPPETS[tab]}</code>
          </pre>
          <p className="border-t border-[var(--vx-hair-dark)] px-5 py-3 font-vmono text-[11px] text-slate-400">
            Example configuration, shown for illustration. This is not a public API.
          </p>
        </div>
      </div>
    </VxSection>
  );
}

/* ───── 05 Integrations bento: real integrations; hover inverts a tile; one accent tile with a counter ───── */

const AVAILABLE_COUNT = INTEGRATION_GROUPS.flatMap((g) =>
  g.items.filter((i) => i.status === "Available"),
).length;

function Tile({
  title,
  items,
  status,
  art,
  className,
}: {
  title: string;
  items: string;
  status: string;
  art: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "group relative flex min-h-[220px] flex-col justify-between bg-[var(--vx-page)] p-6 transition-colors duration-300 hover:bg-[var(--vx-dark)] hover:text-white motion-reduce:transition-none",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[20px] tracking-[-0.01em]">{title}</h3>
          <p className="mt-1 font-vmono text-[10px] uppercase tracking-[0.12em] text-[var(--vx-muted)] group-hover:text-white">
            {items}
          </p>
        </div>
        <span className="shrink-0 border border-current px-1.5 py-px font-vmono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--vx-accent-deep)] group-hover:text-sky-300">
          {status}
        </span>
      </div>
      <div className="mt-6 h-24 w-40 text-[var(--vx-ink)] transition-colors duration-300 group-hover:text-white">
        {art}
      </div>
    </div>
  );
}

export function Integrations() {
  return (
    <VxSection id="integrations" index="05" label="Integrations">
      <ScrollFill
        text="Keep your stack. Add the assistant."
        className="max-w-[760px] text-[28px] leading-[1.2] sm:text-[40px]"
      />
      <p className={`${MONO_P} mt-6 max-w-[600px]`}>
        Connect the tools your business already uses. Status is shown honestly: only integrations
        with a working connect flow are marked Available.
      </p>
      <div className="mt-14 grid gap-px border border-[var(--vx-tile)] bg-[var(--vx-tile)] md:grid-cols-4">
        <Tile
          className="md:col-span-2"
          title="Messaging"
          items="WhatsApp Business · Instagram · Website chat"
          status="Available"
          art={<IlChat />}
        />
        <Tile title="Calendar" items="Google Calendar" status="Available" art={<IlCalendar />} />
        <div className="relative flex min-h-[280px] flex-col justify-between bg-[linear-gradient(160deg,var(--vx-accent)_0%,var(--vx-violet)_100%)] p-6 text-white md:row-span-2">
          <div>
            <p className="font-vmono text-[10px] font-medium uppercase tracking-[0.14em] text-white">
              Integrations available today
            </p>
            <p className="mt-4 font-vmono text-[88px] font-medium leading-none tracking-[-0.05em]">
              <RollNumber value={String(AVAILABLE_COUNT)} />
            </p>
          </div>
          <div>
            <h3 className="text-[24px] leading-tight tracking-[-0.02em]">
              Plugs into the stack you already use.
            </h3>
            <Link
              to="/integrations"
              className="mt-5 inline-flex min-h-11 items-center gap-2 font-vmono text-[11px] font-medium uppercase tracking-[0.12em] text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              See every integration <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
        <Tile title="Voice" items="Telephony" status="Available" art={<IlVoice />} />
        <Tile title="Payments" items="Razorpay" status="Available" art={<IlPayments />} />
        <Tile title="CRM" items="HubSpot · Zoho CRM" status="In development" art={<IlStack />} />
        <Tile
          className="md:col-span-4"
          title="Your own systems"
          items="Webhooks · APIs · your database"
          status="Built to order"
          art={<IlHex />}
        />
      </div>
    </VxSection>
  );
}
