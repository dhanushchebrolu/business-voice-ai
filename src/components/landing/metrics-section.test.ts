import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The brief is explicit: only verified real application data may appear as
 * a number in this section, and none is verified to cite, so this section
 * must present capability statements only — never a fabricated usage
 * statistic like "10M calls processed" or "50,000+ businesses".
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "metrics-section.tsx"),
  "utf8",
);

describe("MetricsSection presents only real capability statements, never fabricated stats", () => {
  test("renders the four required capability statements", () => {
    assert.match(src, /"24\/7"/);
    assert.match(src, /"AI availability"/);
    assert.match(src, /"Multi-channel"/);
    assert.match(src, /"Voice \+ WhatsApp"/);
    assert.match(src, /"One platform"/);
    assert.match(src, /"Multiple AI agents"/);
    assert.match(src, /"White-label"/);
    assert.match(src, /"Built for scale"/);
  });

  test("contains no fabricated large-number usage claim", () => {
    assert.doesNotMatch(
      src,
      /\d[\d,]*\+?\s*(calls|customers|businesses|messages|agents deployed)/i,
    );
    assert.doesNotMatch(src, /\bmillion\b/i);
  });
});
