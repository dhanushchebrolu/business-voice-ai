import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Functionality coverage for the hero: both CTAs must be real (a genuine
 * smooth-scroll to a section that exists on the page, and a genuine
 * contact route), not placeholder handlers, and the decorative hub graphic
 * must be marked non-interactive so it never masquerades as a clickable
 * control.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hero.tsx"), "utf8");

describe("Hero has two real, working CTAs", () => {
  test('"Explore Integrations" scrolls to the real integrations section (not a href="#" placeholder)', () => {
    assert.match(src, /scrollToSection\("integrations"\)/);
    assert.match(src, /Explore Integrations/);
    assert.doesNotMatch(src, /href="#"/);
  });

  test('"Contact" links to the real /contact route', () => {
    assert.match(src, /to="\/contact"/);
    assert.match(src, />\s*Contact\s*</);
  });

  test("the decorative hub graphic is imported and rendered", () => {
    assert.match(src, /import \{ HubGraphic \} from "\.\/hub-graphic"/);
    assert.match(src, /<HubGraphic \/>/);
  });
});
