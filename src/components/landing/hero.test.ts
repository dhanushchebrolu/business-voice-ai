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
    assert.match(src, /to="\/auth" search=\{\{ mode: "signup" \}\}/);
    assert.match(src, />\s*Get Started\s*</);
  });

  test('"Book a Demo" links to the real /contact route', () => {
    assert.match(src, /to="\/contact"/);
    assert.match(src, />\s*Book a Demo\s*</);
  });

  test('"Test Agent" scrolls to the real #voice-demo section (not a href="#" placeholder)', () => {
    assert.match(src, /scrollToSection\("voice-demo"\)/);
    assert.match(src, />\s*Test Agent\s*</);
    assert.doesNotMatch(src, /href="#"/);
  });

  test("the animated flow diagram is imported and rendered, not the removed particle orb", () => {
    assert.match(src, /import \{ HeroFlow \} from "\.\/hero-flow\/hero-flow"/);
    assert.match(src, /<HeroFlow \/>/);
    assert.doesNotMatch(src, /HeroVoiceDemo|particles-orb/);
  });

  test("no fabricated customer/rating/stat claims in the headline or copy", () => {
    assert.doesNotMatch(src, /\d[\d,]*\+?\s*(businesses|customers|calls)/i);
    assert.doesNotMatch(src, /\d(\.\d)?\s*\/\s*5/);
  });
});
