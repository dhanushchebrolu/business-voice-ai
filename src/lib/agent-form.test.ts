import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSpeakingPace } from "./agent-form.ts";
import { PACE_MIN, PACE_MAX } from "./voices.ts";

test("valid numbers pass through unchanged", () => {
  assert.equal(normalizeSpeakingPace(1), 1);
  assert.equal(normalizeSpeakingPace(1.25), 1.25);
  assert.equal(normalizeSpeakingPace(PACE_MIN), PACE_MIN);
  assert.equal(normalizeSpeakingPace(PACE_MAX), PACE_MAX);
});

test("missing, null, NaN and non-numeric values fall back to the 1.0 column default", () => {
  for (const v of [undefined, null, NaN, Infinity, "", "  ", "fast", {}, [], true]) {
    assert.equal(normalizeSpeakingPace(v), 1, String(v));
  }
});

test("numeric strings (NUMERIC over the wire) are coerced", () => {
  assert.equal(normalizeSpeakingPace("1.50"), 1.5);
  assert.equal(normalizeSpeakingPace("0.75"), 0.75);
});

test("out-of-range values are clamped to what the save endpoint accepts", () => {
  assert.equal(normalizeSpeakingPace(0.1), PACE_MIN);
  assert.equal(normalizeSpeakingPace(9), PACE_MAX);
  assert.equal(normalizeSpeakingPace("-3"), PACE_MIN);
});

test("the form hydrates speaking_pace through the normalizer (not the raw row value)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../routes/app.agent.tsx", import.meta.url), "utf8");
  assert.match(src, /speaking_pace:\s*normalizeSpeakingPace\(agent\.speaking_pace\)/);
});
