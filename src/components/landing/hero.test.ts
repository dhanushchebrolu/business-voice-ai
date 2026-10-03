import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Functionality coverage for the hero: both CTAs must be real (a genuine
 * smooth-scroll to a section that exists on the page, and a genuine
 * contact route), not placeholder handlers, and the real audio player
 * (hero-voice-demo.tsx) must actually be rendered — this is the one place
 * on the homepage a visitor can press play and hear a sample call.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hero.tsx"), "utf8");

describe("Hero has two real, working CTAs and a real audio player", () => {
  test('"Explore Integrations" scrolls to the real integrations section (not a href="#" placeholder)', () => {
    assert.match(src, /scrollToSection\("integrations"\)/);
    assert.match(src, /Explore Integrations/);
    assert.doesNotMatch(src, /href="#"/);
  });

  test('"Contact" links to the real /contact route', () => {
    assert.match(src, /to="\/contact"/);
    assert.match(src, />\s*Contact\s*</);
  });

  test("the real audio player is imported and rendered, not a decorative placeholder", () => {
    assert.match(src, /import \{ HeroVoiceDemo \} from "\.\/hero-voice-demo"/);
    assert.match(src, /<HeroVoiceDemo \/>/);
  });

  test("no fabricated customer/rating/stat claims in the headline or copy", () => {
    assert.doesNotMatch(src, /\d[\d,]*\+?\s*(businesses|customers|calls)/i);
    assert.doesNotMatch(src, /\d(\.\d)?\s*\/\s*5/);
  });
});
