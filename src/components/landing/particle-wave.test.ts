import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Performance/lifecycle and accessibility coverage for the dotted-wave
 * canvas: prefers-reduced-motion must actually disable the animation loop
 * and cursor tracking, the rAF loop must only run while on-screen, and
 * every observer/listener/rAF handle registered in the effect must be torn
 * down on cleanup.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "particle-wave.tsx"),
  "utf8",
);

describe("ParticleWave respects reduced motion and cleans up all of its own resources", () => {
  test("uses the shared prefers-reduced-motion hook and gates the rAF loop + cursor tracking on it", () => {
    assert.match(src, /usePrefersReducedMotion\(\)/);
    assert.match(src, /if \(rafId \|\| reducedMotion\) return;/);
    assert.match(src, /if \(!reducedMotion\) \{/);
  });

  test("the animation loop only runs while the canvas is on-screen (IntersectionObserver-gated)", () => {
    assert.match(src, /new IntersectionObserver\(/);
    assert.match(src, /startLoop\(\)/);
    assert.match(src, /stopLoop\(\)/);
  });

  test("resizes are driven by ResizeObserver (not a resize poll) and are devicePixelRatio-aware", () => {
    assert.match(src, /new ResizeObserver\(resize\)/);
    assert.match(src, /devicePixelRatio/);
  });

  test("every observer/listener/rAF handle is torn down in the effect cleanup", () => {
    const cleanupIdx = src.lastIndexOf("return () => {");
    assert.ok(cleanupIdx > -1, "expected an effect cleanup function");
    const cleanupBlock = src.slice(cleanupIdx, src.indexOf("}, [", cleanupIdx));
    assert.match(cleanupBlock, /stopLoop\(\)/);
    assert.match(cleanupBlock, /resizeObserver\.disconnect\(\)/);
    assert.match(cleanupBlock, /intersectionObserver\.disconnect\(\)/);
    assert.match(cleanupBlock, /removeEventListener\("pointermove"/);
    assert.match(cleanupBlock, /removeEventListener\("pointerleave"/);
  });

  test("the canvas is purely decorative (aria-hidden) so screen readers don't announce it", () => {
    assert.match(src, /aria-hidden="true"/);
  });

  test("the external amplitude prop is read via a ref so rapid audio-driven updates don't restart the effect", () => {
    assert.match(src, /amplitudeRef\.current = amplitude;/);
    assert.match(src, /\[tone, variant, reducedMotion\]/);
    assert.doesNotMatch(src, /\[tone, variant, reducedMotion, amplitude\]/);
  });
});
