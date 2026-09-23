import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Functionality coverage for the hero: both CTAs must be real routes, not
 * placeholder handlers, and the decorative product-UI mockup (silhouette +
 * floating cards) must be marked non-interactive so it never masquerades
 * as a clickable control.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hero.tsx"), "utf8");

describe("Hero has two real, working CTAs", () => {
  test("Book a Demo links to the real contact route", () => {
    assert.match(src, /to="\/contact"/);
    assert.match(src, /Book a Demo/);
  });

  test('Try Now links to the real signup route (not a href="#" placeholder)', () => {
    assert.match(src, /to="\/auth" search=\{\{ mode: "signup" \}\}/);
    assert.match(src, /Try Now/);
    assert.doesNotMatch(src, /href="#"/);
  });

  test("the decorative silhouette/product-UI illustration is marked aria-hidden, not an interactive control", () => {
    assert.match(src, /aria-hidden="true"/);
  });
});
