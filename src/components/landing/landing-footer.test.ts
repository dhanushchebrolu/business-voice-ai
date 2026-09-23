import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "landing-footer.tsx"),
  "utf8",
);
// Actual code only — strips the file's own doc comment, which legitimately
// discusses (in prose) the very things these assertions check are absent
// from the real markup below it.
const code = src.replace(/\/\*\*[\s\S]*?\*\//, "");

describe("LandingFooter has no invented social/company links, no fake form, and only real destinations", () => {
  test("does not link to any social platform (none are real/verified for this app)", () => {
    for (const platform of [
      "twitter.com",
      "x.com/",
      "facebook.com",
      "instagram.com",
      "linkedin.com",
      "youtube.com",
      "github.com/clickai",
    ]) {
      assert.equal(src.toLowerCase().includes(platform), false, `must not link to ${platform}`);
    }
  });

  test("has no email-subscribe input pretending to submit somewhere real (no backend for it exists)", () => {
    assert.doesNotMatch(code, /type="email"/);
    assert.doesNotMatch(code, /Subscribe/i);
  });

  test("the primary footer action is a real link to /contact, not a fake form", () => {
    assert.match(code, /to="\/contact"[\s\S]{0,200}Get in touch/);
  });

  test("every footer link is either a real route or a real in-page scroll target", () => {
    assert.match(src, /to: "\/pricing"/);
    assert.match(src, /to: "\/contact"/);
    assert.match(src, /to: "\/auth"/);
    assert.match(src, /targetId: "value-propositions"/);
    assert.match(src, /targetId: "voice-demo"/);
    assert.match(src, /targetId: "feature-showcase"/);
    assert.match(src, /targetId: "integrations"/);
  });

  test("no dead href/onClick placeholders", () => {
    assert.doesNotMatch(src, /href="#"/);
    assert.doesNotMatch(src, /onClick=\{\(\) => \{\}\}/);
  });
});
