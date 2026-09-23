import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The brief is explicit: only verified real application data may appear as
 * a number in this section, and none is verified to cite, so this section
 * must present capability statements only — never a fabricated usage
 * statistic like "13.9% lower costs" or "10M calls processed".
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "metrics-section.tsx"),
  "utf8",
);
// Actual code only — strips the file's own doc comment, which legitimately
// names the fabricated-stat examples this section must never contain.
const code = src.replace(/\/\*\*[\s\S]*?\*\//, "");

describe("MetricsSection presents only real capability statements, never fabricated stats", () => {
  test("renders the three capability statements as the reference's color-blocked stat cards", () => {
    assert.match(src, /"24\/7"/);
    assert.match(src, /"Multi-channel"/);
    assert.match(src, /"White-label"/);
    assert.match(src, /CAPABILITIES\.map/);
  });

  test("contains no fabricated large-number or percentage usage claim", () => {
    assert.doesNotMatch(code, /\d+(\.\d+)?%/);
    assert.doesNotMatch(
      code,
      /\d[\d,]*\+?\s*(calls|customers|businesses|messages|agents deployed)/i,
    );
    assert.doesNotMatch(code, /\bmillion\b/i);
  });
});
