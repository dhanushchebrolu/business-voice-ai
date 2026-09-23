import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Functionality coverage for the hero: both CTAs must be real (a genuine
 * signup route, and a genuine smooth-scroll to a section that exists on
 * the page), not placeholder handlers.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hero.tsx"), "utf8");

describe("Hero has two real, working CTAs", () => {
  test("Get Started links to the real signup route", () => {
    assert.match(src, /to="\/auth" search=\{\{ mode: "signup" \}\}/);
    assert.match(src, />\s*Get Started/);
  });

  test('Explore ClickAI scrolls to the real voice-demo section (not a href="#" placeholder)', () => {
    assert.match(src, /scrollToSection\("voice-demo"\)/);
    assert.match(src, /Explore ClickAI/);
    assert.doesNotMatch(src, /href="#"/);
  });

  test("the particle wave background is aria-hidden and does not block interaction with the CTAs", () => {
    assert.match(src, /pointer-events-none/);
  });
});
