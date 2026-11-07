import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { callsByDay, countsByWeek, isAnswered, isMissed, percent } from "./overview-metrics.ts";

const NOW = new Date(2026, 10, 7, 15, 0, 0); // 7 Nov 2026, local
const at = (d: number, h = 10) => new Date(2026, 10, d, h).toISOString();
const call = (status: string, day: number, extra: object = {}) => ({
  status,
  started_at: at(day),
  created_at: at(day),
  ...extra,
});

describe("answered / missed classification", () => {
  test("answered statuses and an answered_at stamp count as answered", () => {
    for (const s of ["answered", "in_progress", "completed"])
      assert.equal(isAnswered({ status: s }), true);
    assert.equal(isAnswered({ status: "failed", answered_at: at(5) }), true);
  });
  test("no_answer, busy, failed and cancelled are missed; ringing/initiated are neither", () => {
    for (const s of ["no_answer", "busy", "failed", "cancelled"])
      assert.equal(isMissed({ status: s }), true);
    for (const s of ["ringing", "initiated"]) {
      assert.equal(isMissed({ status: s }), false);
      assert.equal(isAnswered({ status: s }), false);
    }
  });
});

describe("callsByDay", () => {
  test("returns exactly `days` buckets, today last, with answered and missed split", () => {
    const b = callsByDay(
      [call("completed", 7), call("completed", 7), call("no_answer", 7), call("completed", 5)],
      7,
      NOW,
    );
    assert.equal(b.length, 7);
    assert.deepEqual([b[6]!.answered, b[6]!.missed], [2, 1]);
    assert.deepEqual([b[4]!.answered, b[4]!.missed], [1, 0]);
  });
  test("calls outside the window and unfinished calls are not counted", () => {
    const b = callsByDay([call("completed", 0), call("ringing", 7)], 7, NOW);
    assert.equal(
      b.reduce((n, x) => n + x.answered + x.missed, 0),
      0,
    );
  });
});

describe("countsByWeek", () => {
  test("buckets by Monday-start week, newest last", () => {
    // 7 Nov 2026 is a Saturday: its week starts Mon 2 Nov; 28 Oct (Wed) is in the week of 26 Oct.
    const w = countsByWeek([at(7), at(3), at(2), at(28).replace("-11-", "-10-")], 4, NOW);
    assert.equal(w.length, 4);
    assert.equal(w[3]!.count, 3);
    assert.equal(w[2]!.count, 1);
  });
  test("ignores null dates", () => {
    assert.equal(
      countsByWeek([null, undefined], 2, NOW).reduce((n, x) => n + x.count, 0),
      0,
    );
  });
});

test("percent returns null instead of dividing by zero", () => {
  assert.equal(percent(1, 0), null);
  assert.equal(percent(1, 4), 25);
});
