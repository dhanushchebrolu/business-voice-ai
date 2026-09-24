import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Functionality coverage for the hero: both CTAs must be real (a genuine
 * signup route, and a genuine smooth-scroll to a section that exists on
 * the page), not placeholder handlers, and the decorative product-UI
 * mockup (silhouette + floating cards) must be marked non-interactive so
 * it never masquerades as a clickable control.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hero.tsx"), "utf8");

describe("Hero has two real, working CTAs", () => {
  test("Get Started with ClickAI links to the real signup route", () => {
    assert.match(src, /to="\/auth" search=\{\{ mode: "signup" \}\}/);
    assert.match(src, /Get Started with ClickAI/);
  });

  test('Explore AI Employees scrolls to the real products section (not a href="#" placeholder)', () => {
    assert.match(src, /scrollToSection\("value-propositions"\)/);
    assert.match(src, /Explore AI Employees/);
    assert.doesNotMatch(src, /href="#"/);
  });

  test("the decorative silhouette/product-UI illustration is marked aria-hidden, not an interactive control", () => {
    assert.match(src, /aria-hidden="true"/);
  });
});
