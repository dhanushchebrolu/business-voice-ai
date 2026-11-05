import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Homepage sections (landing/home + hero): branding, honesty and link rules.
 * Source-scanned, matching this repo's convention for components the node test
 * runner cannot render.
 */
const here = dirname(fileURLToPath(import.meta.url));
const files = [
  ...readdirSync(here)
    .filter((n) => n.endsWith(".tsx"))
    .map((n) => join(here, n)),
  join(here, "..", "hero.tsx"),
  join(here, "..", "..", "..", "routes", "index.tsx"),
];
const src = Object.fromEntries(files.map((f) => [f, readFileSync(f, "utf8")]));
const all = Object.values(src).join("\n");
const footer = readFileSync(join(here, "vx-footer.tsx"), "utf8");

describe("homepage sections", () => {
  test("no reference-template branding remains in the homepage source or copy", () => {
    assert.doesNotMatch(all, /vantage|remix template|logoipsum|cusame/i);
  });

  test("no invented customers, testimonials, certifications or compliance claims", () => {
    assert.doesNotMatch(
      all,
      /SOC ?2|ISO ?27001|HIPAA|GDPR|testimonial|trusted by|\d+\s*\+?\s*(customers|clients|businesses)/i,
    );
  });

  test("the footer links every legal page and a real contact route, and no social or subscribe form", () => {
    for (const to of [
      "/privacy-policy",
      "/terms",
      "/cookie-policy",
      "/refund-cancellation-policy",
      "/messaging-policy",
      "/contact",
    ]) {
      assert.ok(footer.includes(`"${to}"`), `footer must link ${to}`);
    }
    assert.doesNotMatch(
      footer,
      /twitter\.com|x\.com\/|facebook\.com|linkedin\.com|instagram\.com|youtube\.com/i,
    );
    assert.doesNotMatch(footer, /type="email"|Subscribe/i);
  });

  test("the primary CTAs are real: Book a Demo goes to /contact, plans go to signup", () => {
    assert.match(src[join(here, "..", "hero.tsx")]!, /VxLink to="\/contact">Book a Demo/);
    assert.match(all, /to="\/auth"[\s\S]{0,80}mode: "signup"/);
  });

  test("motion respects reduced-motion and nothing hides content without JS", () => {
    const prim = readFileSync(join(here, "primitives.tsx"), "utf8");
    assert.match(prim, /prefers-reduced-motion: reduce/);
    assert.match(prim, /useState\(true\)/); // visible by default, hidden only after mount
  });

  test("illustrative content is labelled", () => {
    assert.match(all, /Illustrative example/);
    assert.match(all, /Example configuration/);
  });
});
