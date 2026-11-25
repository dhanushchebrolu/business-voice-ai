import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatSeconds, parseConversationStats, projectSeconds } from "./conversation-counter.ts";

describe("parseConversationStats: only a well-formed answer is believed", () => {
  test("accepts the three numbers", () => {
    assert.deepEqual(
      parseConversationStats({ completedSeconds: 10, activeCalls: 1, activeElapsedSeconds: 4 }),
      { completedSeconds: 10, activeCalls: 1, activeElapsedSeconds: 4 },
    );
  });
  test("rejects errors, missing, negative, fractional-string and non-numeric values", () => {
    for (const bad of [
      null,
      undefined,
      "x",
      { error: "unavailable" },
      { completedSeconds: 1, activeCalls: 0 },
      { completedSeconds: -1, activeCalls: 0, activeElapsedSeconds: 0 },
      { completedSeconds: "10", activeCalls: 0, activeElapsedSeconds: 0 },
      { completedSeconds: NaN, activeCalls: 0, activeElapsedSeconds: 0 },
    ])
      assert.equal(parseConversationStats(bad), null, JSON.stringify(bad));
  });
  test("ignores extra fields, so nothing else can ride along to the page", () => {
    const parsed = parseConversationStats({
      completedSeconds: 5,
      activeCalls: 0,
      activeElapsedSeconds: 0,
      phone: "+910000000000",
    });
    assert.deepEqual(Object.keys(parsed!).sort(), [
      "activeCalls",
      "activeElapsedSeconds",
      "completedSeconds",
    ]);
  });
});

describe("projectSeconds: the number on the page", () => {
  const quiet = { completedSeconds: 1000, activeCalls: 0, activeElapsedSeconds: 0 };
  test("zero calls stays at zero and never moves", () => {
    const zero = { completedSeconds: 0, activeCalls: 0, activeElapsedSeconds: 0 };
    assert.equal(projectSeconds(zero, 0), 0);
    assert.equal(projectSeconds(zero, 600), 0);
  });
  test("with no live calls the total is fixed however long the page stays open", () => {
    assert.equal(projectSeconds(quiet, 0), 1000);
    assert.equal(projectSeconds(quiet, 90), 1000);
  });
  test("each live call adds one second per second on top of what it had already", () => {
    const s = { completedSeconds: 1000, activeCalls: 1, activeElapsedSeconds: 40 };
    assert.equal(projectSeconds(s, 0), 1040);
    assert.equal(projectSeconds(s, 5), 1045);
  });
  test("overlapping calls each count: two calls add two seconds per second", () => {
    const s = { completedSeconds: 0, activeCalls: 2, activeElapsedSeconds: 150 };
    assert.equal(projectSeconds(s, 10), 170);
  });
  test("a call that ends is not counted twice: its live estimate gives way to the final value", () => {
    // 100 s in, read at t0.
    const live = { completedSeconds: 1000, activeCalls: 1, activeElapsedSeconds: 100 };
    const justBefore = projectSeconds(live, 20); // 1120
    // The call ended at 120 s of conversation; the next read has it in completed, none active.
    const after = { completedSeconds: 1120, activeCalls: 0, activeElapsedSeconds: 0 };
    assert.equal(justBefore, 1120);
    assert.equal(projectSeconds(after, 0), 1120);
    assert.equal(projectSeconds(after, 30), 1120);
  });
  test("a negative or fractional elapsed time cannot move the count backwards", () => {
    const s = { completedSeconds: 10, activeCalls: 1, activeElapsedSeconds: 0 };
    assert.equal(projectSeconds(s, -50), 10);
    assert.equal(projectSeconds(s, 2.9), 12);
  });
});

describe("formatSeconds", () => {
  test("groups thousands with commas, in any locale", () => {
    assert.equal(formatSeconds(0), "0");
    assert.equal(formatSeconds(1234567), "1,234,567");
    assert.equal(formatSeconds(999.9), "999");
  });
});
