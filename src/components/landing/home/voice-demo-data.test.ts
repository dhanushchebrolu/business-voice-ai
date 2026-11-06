import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEMO_CALLS } from "./voice-demo-data.ts";

/** Durations of the three real recordings (seconds), from the files themselves. */
const DURATION: Record<string, number> = { en: 34.84, te: 39.92, hi: 38.28 };
const SCRIPT: Record<string, RegExp> = { en: /^[\x20-\x7e]+$/, te: /[ఀ-౿]/, hi: /[ऀ-ॿ]/ };

describe("call demo data", () => {
  test("three languages, each with its own recording", () => {
    assert.deepEqual(
      DEMO_CALLS.map((c) => c.id),
      ["en", "te", "hi"],
    );
    assert.equal(new Set(DEMO_CALLS.map((c) => c.src)).size, 3);
  });
  for (const call of DEMO_CALLS) {
    test(`${call.id}: segments are ordered, inside the recording, and in that language's script`, () => {
      let prevEnd = 0;
      const ids = new Set<string>();
      for (const s of call.segments) {
        assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
        ids.add(s.id);
        assert.ok(s.start !== undefined && s.end !== undefined && s.start < s.end, s.id);
        assert.ok(s.start! >= prevEnd - 0.01, `${s.id} overlaps the previous segment`);
        assert.ok(s.end! <= DURATION[call.id]! + 0.01, `${s.id} runs past the end of the audio`);
        assert.match(s.text, SCRIPT[call.id]!);
        prevEnd = s.end!;
      }
    });
  }
  test("Telugu stays in the pending state until a verified transcript exists", () => {
    assert.equal(DEMO_CALLS.find((c) => c.id === "te")!.segments.length, 0);
  });
});
