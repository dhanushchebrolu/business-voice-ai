import type { ReactNode } from "react";
import {
  Phone,
  MessageCircle,
  Globe,
  CalendarCheck,
  Workflow,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { cn } from "@/lib/utils";
import { FlowWire } from "./flow-wire";
import { FlowNode } from "./flow-node";
import { MessageBubble } from "./message-bubble";

/**
 * The hero's animated AI-employee workflow: AI Employee -> channels
 * (Voice Calls / WhatsApp / Website Chat / Appointments / Integrations)
 * -> Customers & Leads -> outcomes. Replaces the previous particle orb.
 *
 * Pure SVG + CSS, no canvas/WebGL/Three.js: wire "glow travel" is a
 * dashed-stroke CSS animation, and particles follow the exact curve via
 * native SVG <animateMotion><mpath>, which binds a moving element's
 * position directly to a <path>'s own geometry rather than approximating
 * it — see flow-wire.tsx. prefers-reduced-motion (usePrefersReducedMotion,
 * shared with particle-wave.tsx) strips every moving piece and leaves the
 * static gradient wires and node cards in place.
 *
 * Desktop (sm+, 640px+) shows the full fan-out diagram with message
 * bubbles layered in at lg+ (1024px+, where the hero itself goes
 * two-column and there's room for them); below sm it's replaced by a
 * simplified vertical flow per the brief's mobile spec. Node coordinates
 * are plain percentages of a shared viewBox so the SVG and the
 * absolutely-positioned HTML node cards scale together as one unit and
 * never overflow their container.
 */

const VIEW_W = 1000;
const VIEW_H = 620;

const CHANNELS: { icon: LucideIcon; title: string; short: string; x: number }[] = [
  { icon: Phone, title: "Voice Calls", short: "Voice", x: 40 },
  { icon: MessageCircle, title: "WhatsApp", short: "WhatsApp", x: 270 },
  { icon: Globe, title: "Website Chat", short: "Web Chat", x: 500 },
  { icon: CalendarCheck, title: "Appointments", short: "Appointments", x: 730 },
  { icon: Workflow, title: "Integrations", short: "Integrations", x: 960 },
];

const OUTCOMES = [
  "Qualified Leads",
  "Booked Appointments",
  "Customer Support",
  "Follow-ups",
  "More Conversions",
];

const AI_Y = 85;
const AI_WIRE_Y = 125;
const CHANNEL_Y = 300;
const CHANNEL_TOP_WIRE_Y = 270;
const CHANNEL_BOTTOM_WIRE_Y = 330;
const DEST_Y = 520;
const DEST_WIRE_Y = 475;

function aiToChannel(x: number): string {
  const midY = (AI_WIRE_Y + CHANNEL_TOP_WIRE_Y) / 2;
  return `M${VIEW_W / 2},${AI_WIRE_Y} C${VIEW_W / 2},${midY} ${x},${midY} ${x},${CHANNEL_TOP_WIRE_Y}`;
}

function channelToDest(x: number): string {
  const midY = (CHANNEL_BOTTOM_WIRE_Y + DEST_WIRE_Y) / 2;
  return `M${x},${CHANNEL_BOTTOM_WIRE_Y} C${x},${midY} ${VIEW_W / 2},${midY} ${VIEW_W / 2},${DEST_WIRE_Y}`;
}

function pct(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(2)}%`;
}

function HeroFlowDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="hero-flow-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7c3aed" />
          <stop offset="55%" stopColor="#4f46e5" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>
        <radialGradient id="hero-flow-particle">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="55%" stopColor="#a5f3fc" />
          <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
        </radialGradient>
        <filter id="hero-flow-glow" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="1.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  );
}

function Positioned({
  left,
  top,
  className,
  children,
}: {
  left: string;
  top: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("absolute -translate-x-1/2 -translate-y-1/2", className)}
      style={{ left, top }}
    >
      {children}
    </div>
  );
}

function OutcomeChips() {
  return (
    <ul className="mt-5 flex flex-wrap items-center justify-center gap-2" aria-label="Outcomes">
      {OUTCOMES.map((outcome) => (
        <li
          key={outcome}
          className="rounded-full border border-violet-100 bg-violet-50 px-3 py-1 text-[11px] font-medium text-violet-700"
        >
          {outcome}
        </li>
      ))}
    </ul>
  );
}

function DesktopFlow({ reduced }: { reduced: boolean }) {
  return (
    <div
      className="relative mx-auto hidden w-full max-w-[620px] sm:block"
      style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
        focusable="false"
      >
        {CHANNELS.map((c, i) => (
          <FlowWire
            key={`in-${c.title}`}
            id={`hero-flow-in-${i}`}
            d={aiToChannel(c.x)}
            reduced={reduced}
            duration={3 + i * 0.3}
            delay={i * 0.25}
          />
        ))}
        {CHANNELS.map((c, i) => (
          <FlowWire
            key={`out-${c.title}`}
            id={`hero-flow-out-${i}`}
            d={channelToDest(c.x)}
            reduced={reduced}
            duration={3.4 + i * 0.3}
            delay={0.6 + i * 0.25}
          />
        ))}
      </svg>

      <Positioned left={pct(VIEW_W / 2, VIEW_W)} top={pct(AI_Y, VIEW_H)}>
        <FlowNode
          icon={Sparkles}
          title="AI Employee"
          subtitle="Always On • 24/7"
          size="primary"
          breathing
          reduced={reduced}
        />
      </Positioned>

      {CHANNELS.map((c) => (
        <Positioned key={c.title} left={pct(c.x, VIEW_W)} top={pct(CHANNEL_Y, VIEW_H)}>
          <FlowNode icon={c.icon} title={c.short} reduced={reduced} />
        </Positioned>
      ))}

      <Positioned left={pct(VIEW_W / 2, VIEW_W)} top={pct(DEST_Y, VIEW_H)}>
        <FlowNode
          icon={Users}
          title="Customers & Leads"
          subtitle="Every conversation captured"
          size="primary"
          reduced={reduced}
        />
      </Positioned>

      <div className="hidden lg:contents">
        <MessageBubble
          text="Hi, I'd like to book an appointment."
          reduced={reduced}
          delay={0}
          className="left-[0%] top-[8%]"
        />
        <MessageBubble
          text="Can you tell me about your services?"
          reduced={reduced}
          delay={3.5}
          className="right-[0%] top-[6%]"
        />
        <MessageBubble
          text="Your appointment is confirmed for tomorrow."
          reduced={reduced}
          delay={6.2}
          className="right-[0%] top-[76%]"
        />
      </div>
    </div>
  );
}

function MobileConnector({ id, reduced }: { id: string; reduced: boolean }) {
  return (
    <svg viewBox="0 0 24 44" className="h-9 w-6" aria-hidden="true" focusable="false">
      <FlowWire
        id={id}
        d="M12,0 L12,44"
        reduced={reduced}
        duration={2.1}
        particleCount={1}
        strokeWidth={2.5}
      />
    </svg>
  );
}

function MobileFlow({ reduced }: { reduced: boolean }) {
  return (
    <div className="flex flex-col items-center gap-0.5 sm:hidden">
      <FlowNode
        icon={Sparkles}
        title="AI Employee"
        subtitle="Always On • 24/7"
        size="primary"
        breathing
        reduced={reduced}
      />
      <MobileConnector id="hero-flow-m1" reduced={reduced} />
      <div className="flex items-center gap-5 rounded-2xl border border-violet-100 bg-white/95 px-4 py-3 shadow-[0_8px_24px_-12px_rgba(124,58,237,0.3)]">
        {CHANNELS.slice(0, 3).map((c) => (
          <div key={c.title} className="flex flex-col items-center gap-1">
            <span className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-violet-500 via-indigo-500 to-cyan-400 text-white">
              <c.icon className="size-4" />
            </span>
            <span className="text-[10px] text-slate-500">{c.short}</span>
          </div>
        ))}
      </div>
      <MobileConnector id="hero-flow-m2" reduced={reduced} />
      <FlowNode
        icon={Users}
        title="Customers & Leads"
        subtitle="Every conversation captured"
        size="primary"
        reduced={reduced}
      />
      <MobileConnector id="hero-flow-m3" reduced={reduced} />
      <OutcomeChips />
    </div>
  );
}

export function HeroFlow() {
  const reduced = usePrefersReducedMotion();
  return (
    <div className="relative w-full" role="img" aria-label="How ClickAI's AI employee works">
      <HeroFlowDefs />
      <DesktopFlow reduced={reduced} />
      <MobileFlow reduced={reduced} />
      <div className="hidden sm:block">
        <OutcomeChips />
      </div>
    </div>
  );
}
