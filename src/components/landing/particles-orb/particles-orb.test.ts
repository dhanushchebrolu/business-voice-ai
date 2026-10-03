import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "particles-orb.tsx"), "utf8");
const animatorSrc = readFileSync(join(dir, "use-orb-animator.ts"), "utf8");
const inViewSrc = readFileSync(join(dir, "use-in-view.ts"), "utf8");
const reducedMotionSrc = readFileSync(join(dir, "use-reduced-motion.ts"), "utf8");

describe("ParticlesOrb renders a real Canvas2D particle sphere, never a video/GIF/image", () => {
  test("draws on a real <canvas> via a 2d context, not a video/GIF/image element", () => {
    assert.match(src, /<canvas ref=\{canvasRef\}/);
    assert.match(src, /canvas\.getContext\("2d"\)/);
    assert.doesNotMatch(src, /<video/);
    assert.doesNotMatch(src, /<img/);
    assert.doesNotMatch(src, /\.gif|\.mp4|\.webm/);
  });

  test("forms a real spherical particle distribution (fibonacci/golden-angle sphere), not a flat decoration", () => {
    assert.match(src, /GOLDEN_ANGLE = Math\.PI \* \(3 - Math\.sqrt\(5\)\)/);
    assert.match(src, /const buildSphere/);
    assert.match(src, /PARTICLE_COUNT = 720/);
  });
});

describe("idle is never static — continuous rotation, breathing, and drift run even with zero audio/interaction", () => {
  test("the idle state's own params include non-zero spin, breathe, and drift (not gated behind audio level)", () => {
    const idx = src.indexOf("idle: {");
    assert.ok(idx > -1);
    const block = src.slice(idx, src.indexOf("\n  },", idx));
    assert.match(block, /spin: 0\.\d/);
    assert.match(block, /breathe: 0\.\d/);
    assert.match(block, /drift: 1/);
  });

  test("spin (rotation) advances from elapsed phase time every frame, not from the audio level", () => {
    assert.match(src, /angleY \+= dPhase \* p\.spin/);
  });

  test("breathing and per-particle drift are computed from elapsed time (t), unconditional on level", () => {
    assert.match(src, /const breathe = p\.breathe \* Math\.sin\(t \* 1\.1\)/);
    assert.match(src, /const driftAmp = p\.drift \* radius/);
  });
});

describe("state-based behavior: the full 7-state contract, each with distinct motion parameters", () => {
  test("defines idle, connecting, listening, thinking, speaking, error, and disabled", () => {
    for (const state of [
      "idle",
      "connecting",
      "listening",
      "thinking",
      "speaking",
      "error",
      "disabled",
    ]) {
      assert.match(src, new RegExp(`${state}: \\{`));
    }
  });

  test("listening ripples, thinking pulses, speaking flows+swirls — distinct per-state motion, not one generic animation", () => {
    const listeningIdx = src.indexOf("listening: {");
    const thinkingIdx = src.indexOf("thinking: {");
    const speakingIdx = src.indexOf("speaking: {");
    assert.match(src.slice(listeningIdx, src.indexOf("\n  },", listeningIdx)), /ripple: 1/);
    assert.match(src.slice(thinkingIdx, src.indexOf("\n  },", thinkingIdx)), /pulse: 1/);
    const speakingBlock = src.slice(speakingIdx, src.indexOf("\n  },", speakingIdx));
    assert.match(speakingBlock, /flow: 1/);
    assert.match(speakingBlock, /swirl: 1/);
  });

  test("connecting scatters particles into a ring (particle-scattering/ring behavior)", () => {
    const idx = src.indexOf("connecting: {");
    assert.match(src.slice(idx, src.indexOf("\n  },", idx)), /ring: 1/);
    assert.match(src, /const ringW = clamp01\(p\.ring\)/);
    assert.match(src, /screenX \+= \(circleX - screenX\) \* ringW/);
  });
});

describe("real audio-reactivity via levelRef, read every frame without forcing a React re-render", () => {
  test("useOrbAnimator is wired to the caller's levelRef and drives the frame loop from it", () => {
    assert.match(src, /useOrbAnimator\(hostRef, \{ state, levelRef, speed, onFrame \}\)/);
  });

  test("a negative levelRef value is documented/used as 'no live level, fall back to procedural' — never silently fabricated as 0", () => {
    assert.match(animatorSrc, /hasLive = typeof live === "number" && live >= 0/);
    assert.match(animatorSrc, /target = reduced \? 0 : hasLive \? live : blendEnergy/);
  });

  test("particle radius and ripple/pulse/flow amplitudes scale with the real level, not a constant", () => {
    assert.match(src, /level \* p\.swell/);
    assert.match(src, /0\.04 \+ level \* 0\.22/);
  });
});

describe("respects prefers-reduced-motion by freezing phase advance (not by disappearing)", () => {
  test("phase/time stop advancing while reduced, but the orb still renders its last frame (settles, not static-from-load)", () => {
    assert.match(animatorSrc, /prefersReducedMotion/);
    assert.match(animatorSrc, /frame\.dPhase = reduced \? 0 : dt \* Math\.max\(0, opts\.speed\)/);
    assert.match(animatorSrc, /if \(!reduced\) \{/);
  });

  test("live-subscribes to OS-level reduced-motion changes mid-session, not just at mount", () => {
    assert.match(reducedMotionSrc, /subscribeReducedMotion/);
    assert.match(reducedMotionSrc, /mq\.addEventListener\("change", onChange\)/);
  });
});

describe("cleanup: animation frame and listeners are torn down on unmount", () => {
  test("the rAF loop is cancelled and observers/subscriptions are unsubscribed in the effect's cleanup", () => {
    assert.match(animatorSrc, /cancelAnimationFrame\(raf\)/);
    assert.match(animatorSrc, /return \(\) => \{\s*halt\(\);\s*unobserve\(\);\s*unsubscribe\(\);/);
  });

  test("the draw callback ref is cleared on unmount so a late frame can't draw into a dead canvas", () => {
    assert.match(src, /return \(\) => \{\s*drawRef\.current = null;\s*\};/);
  });

  test("the animation loop pauses (not just visually, the rAF itself stops) when off-screen or the tab is hidden", () => {
    assert.match(inViewSrc, /IntersectionObserver/);
    assert.match(inViewSrc, /visibilitychange/);
    assert.match(animatorSrc, /observeActivity\(el, \(next\) => \{/);
  });
});

describe("ClickAI branding: recolored from VoiceOrbs' pink/purple default to the sky/violet palette", () => {
  test("default colorFrom/colorTo are ClickAI's sky-to-violet, not VoiceOrbs' pink-to-purple", () => {
    assert.match(src, /colorFrom = "#06b6d4"/);
    assert.match(src, /colorTo = "#7c3aed"/);
    assert.doesNotMatch(src, /#f0abfc/);
    assert.doesNotMatch(src, /#818cf8/);
  });
});

describe("MIT attribution for the adapted VoiceOrbs source is present", () => {
  test("LICENSE-voiceorbs.md exists alongside the vendored files", () => {
    assert.ok(existsSync(join(dir, "LICENSE-voiceorbs.md")));
    const notice = readFileSync(join(dir, "LICENSE-voiceorbs.md"), "utf8");
    assert.match(notice, /MIT License/);
    assert.match(notice, /Copyright \(c\) 2026 Alexis Munoz/);
    assert.match(notice, /voiceorbs/i);
  });

  test("each vendored file points back to the attribution notice", () => {
    for (const file of [
      "particles-orb.tsx",
      "orb-state.ts",
      "orb-color.ts",
      "use-orb-animator.ts",
      "use-in-view.ts",
      "use-reduced-motion.ts",
    ]) {
      const content = readFileSync(join(dir, file), "utf8");
      assert.match(content, /LICENSE-voiceorbs\.md/, `${file} is missing the attribution pointer`);
    }
  });
});
