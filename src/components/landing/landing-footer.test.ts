import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "landing-footer.tsx"),
  "utf8",
);

describe("LandingFooter has no invented social/company links and only real destinations", () => {
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

  test("every footer link is either a real route or a real in-page scroll target", () => {
    assert.match(src, /to: "\/pricing"/);
    assert.match(src, /to: "\/contact"/);
    assert.match(src, /to: "\/auth"/);
    assert.match(src, /targetId: "value-propositions"/);
    assert.match(src, /targetId: "white-label"/);
    assert.match(src, /targetId: "integrations"/);
  });

  test("no dead href/onClick placeholders", () => {
    assert.doesNotMatch(src, /href="#"/);
    assert.doesNotMatch(src, /onClick=\{\(\) => \{\}\}/);
  });
});
