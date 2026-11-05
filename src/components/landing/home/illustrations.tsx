import type { ReactNode } from "react";

/**
 * Original line illustrations (isometric-style, 1.25px strokes, one accent
 * element) drawn for ClickAI. They stand in for the reference's artwork, which
 * is not reused.
 */

const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.25,
  strokeLinejoin: "round" as const,
  strokeLinecap: "round" as const,
};

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 200 130" className="h-full w-full" aria-hidden="true" {...S}>
      {children}
    </svg>
  );
}
const A = { stroke: "var(--vx-accent)", strokeWidth: 1.5 };

/** Voice: handset-like waveform on a base plate. */
export function IlVoice() {
  return (
    <Svg>
      <path d="M30 88 100 118 170 88 100 58Z" />
      <path d="M30 88v8l70 30 70-30v-8" />
      {[-30, -18, -6, 6, 18, 30].map((dx, i) => {
        const h = [10, 24, 38, 30, 18, 8][i]!;
        return <path key={dx} d={`M${100 + dx} ${78 - h / 2}v${h}`} {...(i === 2 ? A : {})} />;
      })}
    </Svg>
  );
}
/** WhatsApp / messaging: two stacked bubbles. */
export function IlChat() {
  return (
    <Svg>
      <path d="M50 40h80v40H88l-16 14V80H50Z" />
      <path d="M78 62h86v36h-14v14l-16-14H78Z" {...A} />
      <path d="M92 76h50M92 86h30" />
    </Svg>
  );
}
/** Calendar slab. */
export function IlCalendar() {
  return (
    <Svg>
      <path d="M40 60 100 36l60 24-60 24Z" />
      <path d="M40 60v36l60 24 60-24V60" />
      <path d="M100 84v36" />
      <path d="M72 62 100 74" {...A} />
      <path d="M72 78l28 12M100 52l28 12" />
    </Svg>
  );
}
/** Lead capture: funnel. */
export function IlFunnel() {
  return (
    <Svg>
      <path d="M40 38 100 18l60 20-60 20Z" />
      <path d="M40 38c0 16 40 30 50 36v32l20 8V74c10-6 50-20 50-36" />
      <path d="M100 84v14" {...A} />
    </Svg>
  );
}
/** Workflow: three linked nodes. */
export function IlFlow() {
  return (
    <Svg>
      <rect x="28" y="44" width="38" height="28" />
      <rect x="82" y="22" width="38" height="28" {...A} />
      <rect x="134" y="62" width="38" height="28" />
      <path d="M66 54 82 42M120 38l22 24" />
      <path d="M28 90h144" />
    </Svg>
  );
}
/** Handoff: two figures with an arrow. */
export function IlHandoff() {
  return (
    <Svg>
      <circle cx="60" cy="50" r="12" />
      <path d="M38 96c0-16 10-26 22-26s22 10 22 26" />
      <circle cx="146" cy="50" r="12" {...A} />
      <path d="M124 96c0-16 10-26 22-26s22 10 22 26" {...A} />
      <path d="M86 62h28m-8-8 8 8-8 8" />
    </Svg>
  );
}
/** Payments: stacked coin slabs. */
export function IlPayments() {
  return (
    <Svg>
      <path d="M60 50 100 36l40 14-40 14Z" />
      <path d="M60 50v14l40 14 40-14V50" />
      <path d="M60 64v14l40 14 40-14V64" />
      <path d="M100 36v-8" {...A} />
    </Svg>
  );
}
/** Stack: layered plates. */
export function IlStack() {
  return (
    <Svg>
      <path d="M40 54 100 34l60 20-60 20Z" />
      <path d="M40 72 100 92l60-20" />
      <path d="M40 90 100 110l60-20" />
      <path d="M100 74v36" {...A} />
    </Svg>
  );
}
/** Custom: hexagon. */
export function IlHex() {
  return (
    <Svg>
      <path d="M100 20 148 46v52l-48 26-48-26V46Z" />
      <path d="M100 20v52m0 0L52 98m48-26 48 26" />
      <circle cx="100" cy="72" r="5" {...A} />
    </Svg>
  );
}
