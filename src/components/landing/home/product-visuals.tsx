import * as Tabs from "@radix-ui/react-tabs";
import {
  ArrowRight,
  Bell,
  CalendarCheck,
  Check,
  LayoutDashboard,
  Phone,
  UserCheck,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { GoogleCalendarLogo, WhatsAppLogo } from "./brand-logos";
import { H2, VxSection } from "./primitives";

/**
 * "How it works": one tab per product, each a short step list beside a mock of the
 * real thing happening (chat, call, calendar, lead record, workflow). Every mock is
 * illustrative sample data and says so. Only things the product does today are shown:
 * WhatsApp and voice conversations, Google Calendar booking, lead statuses in the
 * dashboard. No CRM sync is shown because none is available.
 */

const Num = ({ n }: { n: number }) => (
  <span
    aria-hidden="true"
    className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--vx-btn)] font-vmono text-[10px] font-semibold text-white"
  >
    {n}
  </span>
);

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-4">
      {items.map((t, i) => (
        <li
          key={t}
          className="flex items-start gap-3 font-vmono text-[13px] leading-[1.5] text-[var(--vx-ink)]"
        >
          <Num n={i + 1} />
          {t}
        </li>
      ))}
    </ol>
  );
}

function Frame({
  title,
  children,
  logo,
}: {
  title: string;
  children: ReactNode;
  logo?: ReactNode;
}) {
  return (
    <div className="border border-[var(--vx-hair)] bg-[var(--vx-card)]">
      <div className="flex items-center gap-2 border-b border-[var(--vx-hair)] px-4 py-2.5 font-vmono text-[12px] text-[var(--vx-ink)]">
        {logo}
        <span>{title}</span>
        <span className="ml-auto text-[10px] uppercase tracking-[0.1em] text-[var(--vx-muted)]">
          Illustrative
        </span>
      </div>
      {children}
    </div>
  );
}

/* ── WhatsApp ── */

function Bubble({ n, mine, children }: { n: number; mine?: boolean; children: ReactNode }) {
  return (
    <div className={cn("flex items-end gap-2", mine && "flex-row-reverse")}>
      <Num n={n} />
      <p
        className={cn(
          "max-w-[78%] px-3 py-2 font-sans text-[13px] leading-[1.45] text-[#111b21] shadow-sm",
          mine
            ? "bg-[#d9fdd3] [html[data-vx-theme=dark]_&]:bg-[#005c4b] [html[data-vx-theme=dark]_&]:text-[#e9edef]"
            : "bg-white [html[data-vx-theme=dark]_&]:bg-[#202c33] [html[data-vx-theme=dark]_&]:text-[#e9edef]",
        )}
      >
        {children}
      </p>
    </div>
  );
}

function WhatsAppVisual() {
  return (
    <Frame title="WhatsApp · Your business" logo={<WhatsAppLogo className="size-5" />}>
      <div className="space-y-3 bg-[#efeae2] p-4 [html[data-vx-theme=dark]_&]:bg-[#0b141a]">
        <Bubble n={1}>Hi, do you have a slot tomorrow?</Bubble>
        <Bubble n={4} mine>
          Yes! 11:00 AM or 4:00 PM are free. Which do you prefer?
        </Bubble>
        <Bubble n={1}>4 PM please</Bubble>
        <Bubble n={5} mine>
          Great. May I have your name and phone number?
        </Bubble>
        <Bubble n={5}>Priya Sharma, 98xxxxxx10</Bubble>
        <div className="flex items-center gap-2 bg-[var(--vx-card)] px-3 py-2.5 font-vmono text-[12px] text-[var(--vx-ink)]">
          <Num n={6} />
          <Check className="size-4 text-emerald-600" aria-hidden="true" />
          Booked: tomorrow, 4:00 PM, Priya Sharma
        </div>
      </div>
    </Frame>
  );
}

/* ── Voice ── */

function VoiceVisual() {
  const rows = [
    "Call answered by AI receptionist",
    "Enquiry understood: wants an appointment",
    "Availability checked in calendar",
    "Appointment booked for 4:00 PM",
    "Confirmation sent to the customer",
  ];
  return (
    <Frame title="Incoming call">
      <div className="p-5">
        <div className="flex items-center gap-4">
          <span className="grid size-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-600">
            <Phone className="size-6" aria-hidden="true" />
          </span>
          <div>
            <p className="font-display text-[20px] leading-tight text-[var(--vx-ink)]">
              Customer calling
            </p>
            <p className="flex items-center gap-2 font-vmono text-[11px] text-[var(--vx-muted)]">
              <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" /> Connected
              · 00:42
            </p>
          </div>
        </div>
        <ul className="mt-5 divide-y divide-[var(--vx-hair)] border-y border-[var(--vx-hair)]">
          {rows.map((r, i) => (
            <li
              key={r}
              className="flex items-center gap-3 py-2.5 font-vmono text-[12px] text-[var(--vx-ink)]"
            >
              <Num n={i + 1} /> <span className="flex-1">{r}</span>
              <Check className="size-4 text-emerald-600" aria-label="Done" />
            </li>
          ))}
        </ul>
        <p className="mt-4 bg-[var(--vx-alt)] px-3 py-2 font-vmono text-[12px] text-[var(--vx-ink)]">
          “4 PM is free. I’ve booked it for you.”
        </p>
      </div>
    </Frame>
  );
}

/* ── Booking ── */

function BookingVisual() {
  const days = Array.from({ length: 14 }, (_, i) => i + 1);
  return (
    <Frame title="Appointment booking" logo={<GoogleCalendarLogo className="size-5" />}>
      <div className="grid gap-5 p-5 sm:grid-cols-2">
        <div>
          <p className="mb-2 flex items-center gap-2 font-vmono text-[11px] uppercase tracking-[0.1em] text-[var(--vx-muted)]">
            <Num n={2} /> Calendar checked
          </p>
          <div className="grid grid-cols-7 gap-1 text-center font-vmono text-[11px]">
            {days.map((d) => (
              <span
                key={d}
                className={cn(
                  "py-1.5",
                  d === 9
                    ? "bg-[var(--vx-accent)] text-white"
                    : "bg-[var(--vx-alt)] text-[var(--vx-ink)]",
                )}
              >
                {d}
              </span>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 flex items-center gap-2 font-vmono text-[11px] uppercase tracking-[0.1em] text-[var(--vx-muted)]">
            <Num n={3} /> Available slots
          </p>
          <div className="grid grid-cols-2 gap-2 font-vmono text-[12px]">
            {["10:00 AM", "11:00 AM", "2:00 PM", "4:00 PM"].map((t) => (
              <span
                key={t}
                className={cn(
                  "border px-2 py-2 text-center",
                  t === "4:00 PM"
                    ? "border-[var(--vx-accent)] bg-[var(--vx-accent)] text-white"
                    : "border-[var(--vx-hair)] text-[var(--vx-ink)]",
                )}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="space-y-2 border-t border-[var(--vx-hair)] p-5 font-vmono text-[12px] text-[var(--vx-ink)]">
        <p className="flex items-center gap-2">
          <Num n={4} /> <CalendarCheck className="size-4 text-emerald-600" aria-hidden="true" />
          Appointment booked · Tomorrow, 4:00 PM
          <span className="ml-auto border border-emerald-600/40 px-1.5 text-[10px] uppercase text-emerald-700">
            Confirmed
          </span>
        </p>
        <p className="flex items-center gap-2">
          <Num n={5} /> <GoogleCalendarLogo className="size-4" /> Added to Google Calendar ·
          confirmation sent
        </p>
      </div>
    </Frame>
  );
}

/* ── Leads ── */

function LeadVisual() {
  const fields = [
    ["Name", "Rahul Mehta"],
    ["Looking for", "Dental check-up"],
    ["When", "This week"],
    ["Phone", "97xxxxxx42"],
  ];
  return (
    <Frame title="New enquiry">
      <div className="grid gap-5 p-5 sm:grid-cols-2">
        <div className="space-y-2 font-vmono text-[12px]">
          <p className="flex items-center gap-2 text-[var(--vx-muted)]">
            <Num n={1} /> New enquiry received
          </p>
          <p className="flex items-center gap-2 bg-[var(--vx-alt)] px-3 py-2 text-[var(--vx-ink)]">
            <Num n={2} /> What are you looking for?
          </p>
          <p className="flex items-center gap-2 bg-[var(--vx-alt)] px-3 py-2 text-[var(--vx-ink)]">
            <Num n={2} /> When would you like to come in?
          </p>
        </div>
        <dl className="border border-[var(--vx-hair)] font-vmono text-[12px]">
          <p className="flex items-center gap-2 border-b border-[var(--vx-hair)] px-3 py-2 text-[var(--vx-muted)]">
            <Num n={3} /> Details collected
          </p>
          {fields.map(([k, v]) => (
            <div
              key={k}
              className="flex justify-between border-b border-[var(--vx-hair)] px-3 py-2 last:border-b-0"
            >
              <dt className="text-[var(--vx-muted)]">{k}</dt>
              <dd className="text-[var(--vx-ink)]">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--vx-hair)] p-5 font-vmono text-[12px] text-[var(--vx-ink)]">
        <Num n={4} />
        <UserCheck className="size-4 text-emerald-600" aria-hidden="true" />
        <span className="border border-emerald-600/40 px-1.5 text-[10px] uppercase text-emerald-700">
          Qualified
        </span>
        <ArrowRight className="size-4 text-[var(--vx-muted)]" aria-hidden="true" />
        <Num n={5} />
        <LayoutDashboard className="size-4" aria-hidden="true" /> Saved in your Leads dashboard
      </div>
    </Frame>
  );
}

/* ── Automation ── */

function AutomationVisual() {
  const nodes: [ReactNode, string, string][] = [
    [
      <WhatsAppLogo key="w" className="size-7" />,
      "WhatsApp enquiry",
      "Customer asks for a booking",
    ],
    [
      <Workflow key="a" className="size-7 text-[var(--vx-accent)]" aria-hidden="true" />,
      "ClickAI agent",
      "Understands and replies",
    ],
    [
      <GoogleCalendarLogo key="g" className="size-7" />,
      "Google Calendar",
      "Slot checked and booked",
    ],
    [
      <LayoutDashboard key="d" className="size-7 text-[var(--vx-ink)]" aria-hidden="true" />,
      "Your dashboard",
      "Customer and booking saved",
    ],
    [
      <Bell key="b" className="size-7 text-[var(--vx-ink)]" aria-hidden="true" />,
      "Confirmation",
      "Sent back to the customer",
    ],
  ];
  return (
    <Frame title="One enquiry, five steps, no manual work">
      <ol className="grid gap-px bg-[var(--vx-hair)] p-px sm:grid-cols-5">
        {nodes.map(([icon, name, note], i) => (
          <li
            key={name}
            className="relative flex flex-col items-start gap-3 bg-[var(--vx-card)] p-4"
          >
            <div className="flex w-full items-center justify-between">
              {icon}
              <Num n={i + 1} />
            </div>
            <p className="font-display text-[15px] leading-tight text-[var(--vx-ink)]">{name}</p>
            <p className="font-vmono text-[11px] leading-[1.5] text-[var(--vx-muted)]">{note}</p>
          </li>
        ))}
      </ol>
    </Frame>
  );
}

/* ── Section ── */

const TABS = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    icon: <WhatsAppLogo className="size-4" />,
    title: "A WhatsApp agent that replies and books for you",
    steps: [
      "Customer sends a WhatsApp message",
      "ClickAI receives it",
      "It understands what they need",
      "It replies right away",
      "It asks for the details it needs",
      "It completes the booking",
    ],
    visual: <WhatsAppVisual />,
  },
  {
    id: "voice",
    label: "Voice",
    icon: <Phone className="size-4" aria-hidden="true" />,
    title: "An AI receptionist that answers every call",
    steps: [
      "Customer calls your business",
      "The AI receptionist answers",
      "It understands the enquiry",
      "It checks availability",
      "It books the appointment",
      "The customer gets a confirmation",
    ],
    visual: <VoiceVisual />,
  },
  {
    id: "booking",
    label: "Booking",
    icon: <CalendarCheck className="size-4" aria-hidden="true" />,
    title: "Appointments booked without back-and-forth",
    steps: [
      "Customer enquires",
      "ClickAI checks your calendar",
      "Free slots are offered",
      "The appointment is booked",
      "A confirmation is sent",
    ],
    visual: <BookingVisual />,
  },
  {
    id: "leads",
    label: "Leads",
    icon: <UserCheck className="size-4" aria-hidden="true" />,
    title: "Enquiries sorted before your team sees them",
    steps: [
      "A new enquiry arrives",
      "ClickAI asks the right questions",
      "It collects customer details",
      "It marks the lead as qualified",
      "The lead appears in your dashboard",
    ],
    visual: <LeadVisual />,
  },
  {
    id: "automation",
    label: "Automation",
    icon: <Workflow className="size-4" aria-hidden="true" />,
    title: "Conversations turn into finished tasks",
    steps: [
      "A customer message arrives",
      "ClickAI understands it",
      "The calendar is updated",
      "Your dashboard is updated",
      "The customer is notified",
    ],
    visual: <AutomationVisual />,
  },
] as const;

export function ProductVisuals() {
  return (
    <VxSection id="how-it-works" index="00" label="How it works">
      <h2 className={`${H2} max-w-[640px] text-[var(--vx-ink)]`}>
        See what your AI employee does, step by step
      </h2>
      <Tabs.Root defaultValue="whatsapp" className="mt-10">
        <Tabs.List aria-label="Products" className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <Tabs.Trigger
              key={t.id}
              value={t.id}
              className="inline-flex h-11 items-center gap-2 border border-[var(--vx-hair)] px-4 font-vmono text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--vx-ink)] transition-colors hover:border-[var(--vx-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vx-accent)] data-[state=active]:border-[var(--vx-ink)] data-[state=active]:bg-[var(--vx-ink)] data-[state=active]:text-[var(--vx-page)]"
            >
              {t.icon}
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {TABS.map((t) => (
          <Tabs.Content key={t.id} value={t.id} className="mt-8 outline-none">
            <div className="grid gap-10 lg:grid-cols-[minmax(0,340px)_1fr] lg:gap-14">
              <div>
                <h3 className="text-[24px] leading-[1.25] tracking-[-0.02em] text-[var(--vx-ink)]">
                  {t.title}
                </h3>
                <div className="mt-6">
                  <Steps items={[...t.steps]} />
                </div>
              </div>
              {t.visual}
            </div>
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </VxSection>
  );
}
