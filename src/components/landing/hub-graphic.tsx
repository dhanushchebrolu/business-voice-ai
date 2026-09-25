import { MessageCircle, Instagram, Phone, CreditCard, CalendarDays, Globe } from "lucide-react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/**
 * The hero's hub-and-spoke graphic — a ClickAI-branded center "coin" with
 * the channels/integrations ClickAI actually connects today radiating
 * around it on a tilted isometric-style grid floor. Original artwork
 * (CSS-faked isometric floor + hexagon chips + SVG glow lines), not a copy
 * of any reference image's assets — the depth illusion is built from a
 * genuinely rotated (rotateX) floor plane plus layered box-shadows for
 * node/coin thickness, not a traced 3D render.
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
}

const NODES: HubNode[] = [
  { id: "voice", label: "Voice Calls", Icon: Phone, angleDeg: -90 },
  { id: "whatsapp", label: "WhatsApp", Icon: MessageCircle, angleDeg: -30 },
  { id: "razorpay", label: "Razorpay", Icon: CreditCard, angleDeg: 30 },
  { id: "instagram", label: "Instagram", Icon: Instagram, angleDeg: 90 },
  { id: "calendar", label: "Google Calendar", Icon: CalendarDays, angleDeg: 150 },
  { id: "chat", label: "Website Chat", Icon: Globe, angleDeg: 210 },
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
    <div className="relative mx-auto aspect-square w-full max-w-[480px]" aria-hidden="true">
      {/* Tilted grid floor — the isometric-depth illusion, a genuinely
          rotated plane (not a flat background image) sitting behind
          everything else. */}
      <div
        className="absolute inset-0 overflow-hidden rounded-[32px]"
        style={{ perspective: "700px" }}
      >
        <div
          className="absolute inset-[-20%]"
          style={{
            transform: "rotateX(58deg)",
            transformOrigin: "center",
            backgroundImage:
              "linear-gradient(to right, rgba(37,99,235,0.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(37,99,235,0.10) 1px, transparent 1px)",
            backgroundSize: "36px 36px",
            maskImage: "radial-gradient(circle at center, black 45%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(circle at center, black 45%, transparent 75%)",
          }}
        />
      </div>

      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" fill="none">
        <defs>
          <linearGradient id="hub-line-glow" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        {NODES.map((node) => {
          const { x, y } = nodePosition(node.angleDeg);
          const midX = 50 + (x - 50) * 0.5 + (y - 50) * 0.14;
          const midY = 50 + (y - 50) * 0.5 - (x - 50) * 0.14;
          const d = `M 50 50 Q ${midX} ${midY} ${x} ${y}`;
          return (
            <g key={node.id}>
              <path
                d={d}
                stroke="#93c5fd"
                strokeOpacity="0.35"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              <path d={d} stroke="url(#hub-line-glow)" strokeWidth="0.55" strokeLinecap="round" />
            </g>
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
              className={reducedMotion ? "" : "animate-hub-float"}
              style={{ animationDelay: reducedMotion ? undefined : `${i * 0.45}s` }}
            >
              {/* Offset dark layer behind gives the chip a beveled/
                  extruded thickness, matching the reference's raised
                  hex tiles. */}
              <div
                className="absolute inset-0 translate-y-[5px] bg-blue-950/10"
                style={{ clipPath: HEX_CLIP }}
                aria-hidden="true"
              />
              <div
                className="relative flex size-16 items-center justify-center border border-blue-200 bg-white shadow-[0_16px_28px_-14px_rgba(37,99,235,0.45)] sm:size-[72px]"
                style={{ clipPath: HEX_CLIP }}
              >
                <span
                  className="pointer-events-none absolute inset-0 rounded-full bg-blue-400/15 blur-lg"
                  aria-hidden="true"
                />
                <node.Icon className="relative size-6 text-blue-600 sm:size-7" />
              </div>
            </div>
            <p className="mt-2 text-center text-[10px] font-medium text-slate-500 sm:text-[11px]">
              {node.label}
            </p>
          </div>
        );
      })}

      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <span
          className={`pointer-events-none absolute inset-0 -m-6 rounded-full bg-blue-400/25 blur-2xl ${
            reducedMotion ? "" : "animate-hub-pulse"
          }`}
          aria-hidden="true"
        />
        {/* Coin thickness: a darker blue ellipse offset below the main
            face, simulating the reference's ridged-edge center disc. */}
        <div className="absolute left-1/2 top-[10px] h-[76px] w-[168px] -translate-x-1/2 rounded-full bg-blue-700 sm:h-[88px] sm:w-[192px]" />
        <div className="relative grid h-[76px] w-[168px] place-items-center rounded-full border-2 border-blue-300 bg-gradient-to-b from-white to-blue-50 shadow-[0_0_50px_-6px_rgba(37,99,235,0.5)] sm:h-[88px] sm:w-[192px]">
          <div className="flex flex-col items-center">
            <span className="grid size-8 place-items-center rounded-full bg-blue-600 text-xs font-semibold text-white sm:size-9">
              C
            </span>
            <span className="mt-1 text-[11px] font-semibold tracking-tight text-slate-900 sm:text-xs">
              ClickAI
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
