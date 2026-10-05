import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const heroFlowSrc = readFileSync(join(dir, "hero-flow.tsx"), "utf8");
const flowWireSrc = readFileSync(join(dir, "flow-wire.tsx"), "utf8");
const flowNodeSrc = readFileSync(join(dir, "flow-node.tsx"), "utf8");
const bubbleSrc = readFileSync(join(dir, "message-bubble.tsx"), "utf8");

describe("the hero flow replaces the particle orb with a real SVG diagram, not a static image", () => {
  test("renders real SVG <path> wires via viewBox-based coordinates, not an <img>/video/gif", () => {
    assert.match(heroFlowSrc, /viewBox=\{`0 0 \$\{VIEW_W\} \$\{VIEW_H\}`\}/);
    assert.doesNotMatch(heroFlowSrc, /<img|<video|\.gif|\.mp4|\.webm/);
  });

  test("no Three.js/R3F was introduced for this — pure SVG/CSS", () => {
    for (const src of [heroFlowSrc, flowWireSrc, flowNodeSrc, bubbleSrc]) {
      assert.doesNotMatch(src, /from\s+["']@react-three|from\s+["']three["']|new THREE\./);
    }
  });

  test("renders no imperative rAF loop of its own — every animation is native CSS/SVG, not a hand-rolled JS loop", () => {
    for (const src of [heroFlowSrc, flowWireSrc, flowNodeSrc, bubbleSrc]) {
      assert.doesNotMatch(src, /requestAnimationFrame/);
    }
  });
});

describe("wires carry continuous moving light, not a static line", () => {
  test("each wire has a dashed overlay path animated via the hero-flow-dash CSS utility (continuous flowing glow)", () => {
    assert.match(flowWireSrc, /strokeDasharray="14 160"/);
    assert.match(flowWireSrc, /className="hero-flow-dash"/);
  });

  test("the dash utility is a real, continuously-looping CSS keyframe animation (defined in styles.css)", () => {
    const stylesSrc = readFileSync(join(dir, "..", "..", "..", "styles.css"), "utf8");
    assert.match(stylesSrc, /@keyframes hero-flow-dash/);
    assert.match(stylesSrc, /animation: hero-flow-dash linear infinite/);
  });
});

describe("particles literally travel the actual curved wire path, not an approximated left/right translate", () => {
  test("particles are bound to the path's own geometry via native SVG animateMotion + mpath referencing the wire's id", () => {
    assert.match(flowWireSrc, /<animateMotion/);
    assert.match(flowWireSrc, /<mpath href=\{`#\$\{id\}`\} xlinkHref=\{`#\$\{id\}`\} \/>/);
  });

  test("the animated overlay path (the one particles follow) shares the exact same `d` as the visible wire, so the particle can't drift off the drawn curve", () => {
    assert.match(flowWireSrc, /id=\{id\}\s*\n\s*d=\{d\}/);
  });

  test("particles loop continuously (repeatCount indefinite), not a one-shot animation", () => {
    assert.match(flowWireSrc, /repeatCount="indefinite"/);
  });
});

describe("the flow structure matches the required AI-employee -> channels -> customers -> outcomes shape", () => {
  test("AI Employee source node, labeled Always On, feeds every channel", () => {
    assert.match(heroFlowSrc, /title="AI Employee"/);
    assert.match(heroFlowSrc, /subtitle="Always On • 24\/7"/);
  });

  test("all five required channel nodes are present", () => {
    for (const channel of [
      "Voice Calls",
      "WhatsApp",
      "Website Chat",
      "Appointments",
      "Integrations",
    ]) {
      assert.match(heroFlowSrc, new RegExp(`title: "${channel}"`));
    }
  });

  test("channels converge into a Customers & Leads destination node", () => {
    assert.match(heroFlowSrc, /title="Customers & Leads"/);
  });

  test("concise outcome labels are shown near the destination", () => {
    for (const outcome of [
      "Qualified Leads",
      "Booked Appointments",
      "Customer Support",
      "Follow-ups",
      "More Conversions",
    ]) {
      assert.match(heroFlowSrc, new RegExp(outcome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  test("subtle example message bubbles are present but not a fabricated transcript", () => {
    assert.match(heroFlowSrc, /Hi, I'd like to book an appointment\./);
    assert.match(heroFlowSrc, /Can you tell me about your services\?/);
    assert.match(heroFlowSrc, /Your appointment is confirmed for tomorrow\./);
  });
});

describe("responsive: a dedicated simplified vertical flow for mobile, full fan-out for sm+", () => {
  test("the desktop/tablet fan-out diagram is hidden below the sm breakpoint and the mobile flow is hidden at sm+", () => {
    assert.match(heroFlowSrc, /hidden w-full max-w-\[620px\] sm:block/);
    assert.match(heroFlowSrc, /flex flex-col items-center gap-0\.5 sm:hidden/);
  });

  test("message bubbles are reserved for lg+ (full two-column desktop), reduced decoration at tablet", () => {
    assert.match(heroFlowSrc, /hidden lg:contents/);
  });

  test("mobile flow combines Voice/WhatsApp/Chat into one row instead of the desktop's five separate nodes", () => {
    assert.match(heroFlowSrc, /CHANNELS\.slice\(0, 3\)/);
  });

  test("diagram sizing is percentage/aspect-ratio driven, not a fixed oversized pixel width that could overflow", () => {
    assert.match(heroFlowSrc, /aspectRatio: `\$\{VIEW_W\} \/ \$\{VIEW_H\}`/);
    assert.doesNotMatch(heroFlowSrc, /width:\s*"?\d{3,}px/);
  });
});

describe("prefers-reduced-motion strips moving parts but keeps the static structure", () => {
  test("uses the shared usePrefersReducedMotion hook (same one particle-wave.tsx uses)", () => {
    assert.match(
      heroFlowSrc,
      /import \{ usePrefersReducedMotion \} from "@\/hooks\/usePrefersReducedMotion"/,
    );
    assert.match(heroFlowSrc, /const reduced = usePrefersReducedMotion\(\);/);
  });

  test("FlowWire mounts no dashed overlay or particles at all when reduced — not just visually hidden", () => {
    assert.match(flowWireSrc, /\{!reduced && \(/);
    assert.match(flowWireSrc, /\{!reduced &&\n\s*Array\.from/);
  });

  test("breathing glow and message bubbles are CSS-driven and also gated off entirely when reduced", () => {
    assert.match(flowNodeSrc, /breathing && !reduced/);
    assert.match(bubbleSrc, /if \(reduced\) return null;/);
  });

  test("the CSS keyframe animations themselves also respect the OS prefers-reduced-motion media query directly", () => {
    const stylesSrc = readFileSync(join(dir, "..", "..", "..", "styles.css"), "utf8");
    assert.match(stylesSrc, /@media \(prefers-reduced-motion: reduce\) \{/);
    assert.match(
      stylesSrc,
      /hero-flow-dash,\s*\n\s*\.hero-flow-breathe,\s*\n\s*\.hero-flow-bubble/,
    );
  });
});

describe("cleanup / no leaked listeners", () => {
  test("the only subscription used is the shared, already-cleaned-up usePrefersReducedMotion hook — no extra addEventListener/IntersectionObserver/ResizeObserver added here", () => {
    for (const src of [heroFlowSrc, flowWireSrc, flowNodeSrc, bubbleSrc]) {
      assert.doesNotMatch(src, /addEventListener|IntersectionObserver|ResizeObserver/);
    }
  });
});
