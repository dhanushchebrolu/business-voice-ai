import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "organic-orb-fallback.tsx"),
  "utf8",
);

describe("OrganicOrbFallback never pulls in three/@react-three/fiber", () => {
  test("has zero imports from three or @react-three/fiber — this is what lets callers statically import it without the heavy chunk", () => {
    assert.doesNotMatch(src, /from "three"/);
    assert.doesNotMatch(src, /from "@react-three\/fiber"/);
  });

  test("is a plain CSS gradient circle, not a canvas", () => {
    assert.doesNotMatch(src, /<canvas/);
    assert.doesNotMatch(src, /<Canvas/);
    assert.match(src, /radial-gradient/);
  });
});
