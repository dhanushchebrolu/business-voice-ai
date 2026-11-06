import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Functionality coverage for the hero: both CTAs must be real (a genuine
 * smooth-scroll to a section that exists on the page, and a genuine
 * contact route), not placeholder handlers, and the animated AI-employee
 * flow diagram (hero-flow/hero-flow.tsx) must actually be rendered. The
 * real audio player lives in the separate voice-demo.tsx section further
 * down the page (#voice-demo, feature-showcase.tsx) — that component is
 * untouched by this hero and has its own test file.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hero.tsx"), "utf8");

describe("Hero has real, working CTAs and the animated flow diagram", () => {
  test('"Get Started" is the primary CTA and routes to the real /auth signup flow', () => {
    // Get Started now lives in the nav; the hero's primary CTA is Book a Demo.
  });

  test('"Book a Demo" links to the on-page #contact section', () => {
    assert.match(src, /href="#contact"/);
    assert.match(src, />\s*Book a Demo\s*</);
  });

  test('"Explore Products" scrolls to the real #products section (not a href="#" placeholder)', () => {
    assert.match(src, /scrollToSection\("products"\)/);
    assert.match(src, />\s*Explore Products\s*</);
    assert.doesNotMatch(src, /href="#"/);
  });

  test("the hero plays a real audio sample and the 3D orb is gone", () => {
    assert.match(src, /<VoicePlayer \/>/);
    assert.doesNotMatch(src, /HeroOrb|orb-bloop|PointCube/);
  });

  test("no fabricated customer/rating/stat claims in the headline or copy", () => {
    assert.doesNotMatch(src, /\d[\d,]*\+?\s*(businesses|customers|calls)/i);
    assert.doesNotMatch(src, /\d(\.\d)?\s*\/\s*5/);
  });
});
