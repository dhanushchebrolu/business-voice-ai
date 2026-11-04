import { CalendarCheck, CalendarX, PhoneIncoming, UserRound } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Small product surfaces for the home showcase. They draw only features that
 * exist in the product (call history, YES-to-confirm WhatsApp bookings, human
 * handoff, weekly hours and date overrides, Google Calendar, Razorpay links)
 * and every text sample is labelled as an example. No numbers, customers or
 * results are shown.
 */

function Frame({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-ink-900 text-slate-200 shadow-[0_30px_80px_-30px_rgba(6,11,31,0.7)]">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5 text-xs">
        <span className="font-medium text-white">{title}</span>
        <span className="text-slate-400">{note}</span>
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  );
}

function Bubble({ who, children }: { who: "them" | "ai"; children: ReactNode }) {
  return (
    <p
      className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${
        who === "ai" ? "ml-auto bg-violet-600 text-white" : "bg-white/10 text-slate-100"
      }`}
    >
      {children}
    </p>
  );
}

function Tag({ children, tone = "ok" }: { children: ReactNode; tone?: "ok" | "custom" }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
        tone === "ok"
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
          : "border-white/15 bg-white/5 text-slate-300"
      }`}
    >
      {children}
    </span>
  );
}

export function VoiceSurface() {
  return (
    <Frame title="Inbound call" note="Illustrative example">
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <PhoneIncoming className="size-4 text-sky-300" aria-hidden="true" />
        Call to your business number, answered by your AI employee
      </div>
      <div className="mt-4 space-y-2.5" role="img" aria-label="Example call transcript">
        <Bubble who="them">Do you have any slots tomorrow afternoon?</Bubble>
        <Bubble who="ai">Yes, 2:00 pm and 4:30 pm are free. Which suits you?</Bubble>
        <Bubble who="them">2 pm, please.</Bubble>
        <Bubble who="ai">Booked for 2:00 pm tomorrow. Can I take your name and number?</Bubble>
      </div>
      <div className="mt-5 flex flex-wrap gap-2 border-t border-white/10 pt-4">
        <Tag>Booking created</Tag>
        <Tag>Saved in call history</Tag>
        <Tag tone="custom">Transfer to staff: needs a transfer number</Tag>
      </div>
    </Frame>
  );
}

export function WhatsAppSurface() {
  return (
    <Frame title="WhatsApp conversation" note="Illustrative example">
      <div className="space-y-2.5" role="img" aria-label="Example WhatsApp conversation">
        <Bubble who="them">Can I move my appointment to Friday?</Bubble>
        <Bubble who="ai">I can move it to Friday 11:00 am. Reply YES to confirm.</Bubble>
        <Bubble who="them">YES</Bubble>
        <Bubble who="ai">Done. Your appointment is now Friday 11:00 am.</Bubble>
      </div>
      <div className="mt-5 grid gap-2 border-t border-white/10 pt-4 text-xs sm:grid-cols-2">
        <div className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
          <CalendarCheck className="size-4 text-emerald-300" aria-hidden="true" />
          Changes happen only after YES
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
          <UserRound className="size-4 text-sky-300" aria-hidden="true" />
          Customer asks for a person: AI replies stop
        </div>
      </div>
    </Frame>
  );
}

const HOURS: [string, string, number, number][] = [
  ["Mon", "9:00 – 18:00", 0, 100],
  ["Tue", "9:00 – 18:00", 0, 100],
  ["Wed", "9:00 – 13:00", 0, 45],
  ["Thu", "9:00 – 18:00", 0, 100],
  ["Fri", "Closed (override)", 0, 0],
];

export function AppointmentSurface() {
  return (
    <Frame title="Availability" note="Example configuration">
      <ul className="space-y-2.5">
        {HOURS.map(([day, label, , width]) => (
          <li key={day} className="grid grid-cols-[2.5rem_1fr_9rem] items-center gap-3 text-xs">
            <span className="text-slate-400">{day}</span>
            <span className="h-2 rounded-full bg-white/10" aria-hidden="true">
              <span
                className="block h-2 rounded-full bg-gradient-to-r from-violet-500 to-sky-400"
                style={{ width: `${width}%` }}
              />
            </span>
            <span className="flex items-center justify-end gap-1.5 text-slate-200">
              {width === 0 ? (
                <CalendarX className="size-3.5 text-amber-300" aria-hidden="true" />
              ) : null}
              {label}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex flex-wrap gap-2 border-t border-white/10 pt-4">
        <Tag>Weekly hours</Tag>
        <Tag>Daily overrides</Tag>
        <Tag>Google Calendar busy times block slots</Tag>
      </div>
    </Frame>
  );
}

const STEPS: [string, string, "ok" | "custom"][] = [
  ["Customer calls or messages", "Voice or WhatsApp", "ok"],
  ["Details are captured", "Lead stored in your dashboard", "ok"],
  ["Booking or payment link", "Calendar booking, Razorpay link", "ok"],
  ["Your own systems", "CRM, database, webhooks", "custom"],
];

export function AutomationSurface() {
  return (
    <Frame title="Workflow" note="What is available today">
      <ol className="relative space-y-3 pl-7 before:absolute before:bottom-3 before:left-[11px] before:top-3 before:w-px before:bg-white/15">
        {STEPS.map(([title, sub, tone], i) => (
          <li
            key={title}
            className="relative flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2.5"
          >
            <span
              aria-hidden="true"
              className="absolute -left-7 grid size-6 place-items-center rounded-full border border-white/20 bg-ink-900 text-[10px] text-slate-300"
            >
              {i + 1}
            </span>
            <span>
              <span className="block text-sm text-white">{title}</span>
              <span className="block text-xs text-slate-400">{sub}</span>
            </span>
            <Tag tone={tone}>{tone === "ok" ? "Available" : "Custom"}</Tag>
          </li>
        ))}
      </ol>
    </Frame>
  );
}
