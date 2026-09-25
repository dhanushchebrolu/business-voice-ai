import { MessageCircle, Instagram, Phone, CreditCard, CalendarDays, Globe } from "lucide-react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/**
 * The hero's hub-and-spoke graphic — a ClickAI-branded center node with the
 * channels/integrations ClickAI actually connects today radiating around
 * it. Original artwork (SVG connector lines + CSS hexagon chips), not a
 * copy of any reference image's assets.
 *
 * Every node listed here is a real, live ClickAI capability, not an
 * aspirational one — WhatsApp, Instagram and Razorpay are the three the
 * product brief called out by name, plus Voice/Calls, Google Calendar and
 * Website Chat to round out "whatever is available in our website
 * service." Integrations still marked "Coming soon" on the Integrations
 * section below (Shopify, WooCommerce, SMS, Email) are deliberately left
 * out of this graphic so it never overclaims what's actually connected.
 */

interface HubNode {
  id: string;
  label: string;
  Icon: typeof MessageCircle;
  angleDeg: number;
  colorClass: string;
  glowClass: string;
}

const NODES: HubNode[] = [
  {
    id: "voice",
    label: "Voice Calls",
    Icon: Phone,
    angleDeg: -90,
    colorClass: "text-sky-300",
    glowClass: "bg-sky-400/20",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    Icon: MessageCircle,
    angleDeg: -30,
    colorClass: "text-emerald-300",
    glowClass: "bg-emerald-400/20",
  },
  {
    id: "razorpay",
    label: "Razorpay",
    Icon: CreditCard,
    angleDeg: 30,
    colorClass: "text-indigo-300",
    glowClass: "bg-indigo-400/20",
  },
  {
    id: "instagram",
    label: "Instagram",
    Icon: Instagram,
    angleDeg: 90,
    colorClass: "text-pink-300",
    glowClass: "bg-pink-400/20",
  },
  {
    id: "calendar",
    label: "Google Calendar",
    Icon: CalendarDays,
    angleDeg: 150,
    colorClass: "text-amber-300",
    glowClass: "bg-amber-400/20",
  },
  {
    id: "chat",
    label: "Website Chat",
    Icon: Globe,
    angleDeg: 210,
    colorClass: "text-teal-300",
    glowClass: "bg-teal-400/20",
  },
];

const RADIUS_PCT = 38;
const HEX_CLIP = "polygon(25% 3%, 75% 3%, 97% 50%, 75% 97%, 25% 97%, 3% 50%)";

function nodePosition(angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: 50 + RADIUS_PCT * Math.cos(rad), y: 50 + RADIUS_PCT * Math.sin(rad) };
}

export function HubGraphic() {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[440px]" aria-hidden="true">
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" fill="none">
        <defs>
          <radialGradient id="hub-line-fade" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="white" stopOpacity="0.35" />
            <stop offset="100%" stopColor="white" stopOpacity="0.05" />
          </radialGradient>
        </defs>
        {NODES.map((node) => {
          const { x, y } = nodePosition(node.angleDeg);
          const midX = 50 + (x - 50) * 0.5 + (y - 50) * 0.12;
          const midY = 50 + (y - 50) * 0.5 - (x - 50) * 0.12;
          return (
            <path
              key={node.id}
              d={`M 50 50 Q ${midX} ${midY} ${x} ${y}`}
              stroke="url(#hub-line-fade)"
              strokeWidth="0.6"
              strokeLinecap="round"
            />
          );
        })}
      </svg>

      {NODES.map((node, i) => {
        const { x, y } = nodePosition(node.angleDeg);
        return (
          <div
            key={node.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            <div
              className={`relative flex size-16 items-center justify-center border border-white/15 bg-[#111114]/90 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.6)] sm:size-20 ${
                reducedMotion ? "" : "animate-hub-float"
              }`}
              style={{
                clipPath: HEX_CLIP,
                animationDelay: reducedMotion ? undefined : `${i * 0.45}s`,
              }}
            >
              <span
                className={`pointer-events-none absolute inset-0 rounded-full blur-lg ${node.glowClass}`}
                aria-hidden="true"
              />
              <node.Icon className={`relative size-6 sm:size-7 ${node.colorClass}`} />
            </div>
            <p className="mt-1.5 text-center text-[10px] font-medium text-white/45 sm:text-[11px]">
              {node.label}
            </p>
          </div>
        );
      })}

      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <span
          className={`pointer-events-none absolute inset-0 -m-4 rounded-full bg-white/10 blur-2xl ${
            reducedMotion ? "" : "animate-hub-pulse"
          }`}
          aria-hidden="true"
        />
        <div className="relative grid size-28 place-items-center rounded-full border border-white/20 bg-[#0a0a0d] shadow-[0_0_60px_-8px_rgba(255,255,255,0.25)] sm:size-32">
          <span className="grid size-9 place-items-center rounded-full border border-white/25 text-sm font-semibold text-white sm:size-10">
            C
          </span>
          <span className="mt-1.5 text-[11px] font-semibold tracking-tight text-white sm:text-xs">
            ClickAI
          </span>
        </div>
      </div>
    </div>
  );
}
