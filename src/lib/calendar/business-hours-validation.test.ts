import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  describeInvalidInterval,
  describeInvalidOverrideInterval,
  describeInvalidIntervals,
  describeInvalidOverrideIntervals,
  describeBusinessHoursWriteError,
  describeInvalidWeeklyDay,
  describeInvalidOverride,
  logInvalidBusinessHoursOnce,
  _resetWarnedKeysForTests,
} from "./business-hours-validation.ts";

describe("describeInvalidInterval — plain {start,end}", () => {
  test("a normal daytime interval is valid", () => {
    assert.equal(describeInvalidInterval({ start: "09:00", end: "19:00" }), null);
  });

  test("00:00 -> 23:59 (the established all-day convention) is valid", () => {
    assert.equal(describeInvalidInterval({ start: "00:00", end: "23:59" }), null);
  });

  test("equal start and end is rejected", () => {
    const err = describeInvalidInterval({ start: "09:00", end: "09:00" });
    assert.ok(err);
    assert.match(err!, /after opening time/);
  });

  test("reversed 23:59 -> 00:00 is rejected, not reinterpreted as overnight", () => {
    const err = describeInvalidInterval({ start: "23:59", end: "00:00" });
    assert.ok(err);
    assert.match(err!, /Overnight hours are not supported/);
  });

  for (const bad of ["9:00", "25:00", "12:60", "", "09-00", "0900"]) {
    test(`malformed time "${bad}" is rejected`, () => {
      const err = describeInvalidInterval({ start: bad, end: "19:00" });
      assert.ok(err, `expected "${bad}" to be rejected`);
      assert.match(err!, /not a valid time/);
    });
  }

  test("non-string start/end is rejected without throwing", () => {
    const err = describeInvalidInterval({ start: 900, end: "19:00" });
    assert.ok(err);
    assert.match(err!, /not a valid time/);
  });

  test("missing field is rejected without throwing", () => {
    const err = describeInvalidInterval({ start: "09:00", end: undefined });
    assert.ok(err);
  });
});

describe("describeInvalidOverrideInterval — {start,end,isOpen}", () => {
  test("a valid override interval with isOpen is accepted", () => {
    assert.equal(
      describeInvalidOverrideInterval({ start: "10:00", end: "11:00", isOpen: true }),
      null,
    );
  });

  test("missing isOpen is rejected", () => {
    const err = describeInvalidOverrideInterval({
      start: "10:00",
      end: "11:00",
      isOpen: undefined,
    });
    assert.ok(err);
    assert.match(err!, /whether it opens or closes/);
  });

  test("isOpen as a non-boolean is rejected", () => {
    const err = describeInvalidOverrideInterval({ start: "10:00", end: "11:00", isOpen: "true" });
    assert.ok(err);
  });

  test("a well-typed isOpen does not mask a bad time range", () => {
    const err = describeInvalidOverrideInterval({ start: "23:59", end: "00:00", isOpen: true });
    assert.ok(err);
    assert.match(err!, /Overnight hours are not supported/);
  });
});

describe("describeInvalidIntervals / describeInvalidOverrideIntervals — lists", () => {
  test("an empty list is always valid", () => {
    assert.equal(describeInvalidIntervals([]), null);
    assert.equal(describeInvalidOverrideIntervals([]), null);
  });

  test("the first invalid entry's message is returned", () => {
    const err = describeInvalidIntervals([
      { start: "09:00", end: "12:00" },
      { start: "15:00", end: "14:00" },
    ]);
    assert.ok(err);
    assert.match(err!, /Overnight hours are not supported/);
  });
});

describe("describeBusinessHoursWriteError — translating the trigger's exception", () => {
  test("strips the INVALID_BUSINESS_HOURS_INTERVAL prefix", () => {
    const err = new Error(
      'INVALID_BUSINESS_HOURS_INTERVAL: interval 1 end "00:00" must be after start "23:59" (overnight hours are not supported)',
    );
    const msg = describeBusinessHoursWriteError(err);
    assert.ok(msg);
    assert.doesNotMatch(msg!, /INVALID_BUSINESS_HOURS_INTERVAL/);
    assert.match(msg!, /must be after start/);
  });

  test("returns null for an unrelated error", () => {
    assert.equal(
      describeBusinessHoursWriteError(new Error("CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING")),
      null,
    );
  });

  test("returns null for a non-error value", () => {
    assert.equal(describeBusinessHoursWriteError("just a string"), null);
    assert.equal(describeBusinessHoursWriteError(null), null);
  });

  test("handles a PostgrestError-shaped object (no Error prototype)", () => {
    const pgError = {
      message: "INVALID_BUSINESS_HOURS_INTERVAL: intervals must be a JSON array (got object)",
    };
    const msg = describeBusinessHoursWriteError(pgError);
    assert.ok(msg);
    assert.match(msg!, /must be a JSON array/);
  });
});

describe("describeInvalidWeeklyDay — dashboard diagnostic, specific to the affected day", () => {
  test("a closed day is never flagged, regardless of its stored intervals", () => {
    assert.equal(
      describeInvalidWeeklyDay({
        dayOfWeek: 1,
        isClosed: true,
        intervals: [{ start: "23:59", end: "00:00" }],
      }),
      null,
    );
  });

  test("an open day with a valid interval is not flagged", () => {
    assert.equal(
      describeInvalidWeeklyDay({
        dayOfWeek: 1,
        isClosed: false,
        intervals: [{ start: "09:00", end: "19:00" }],
      }),
      null,
    );
  });

  test("an open day with the known legacy-invalid interval names the weekday and the exact problem", () => {
    const warning = describeInvalidWeeklyDay({
      dayOfWeek: 1,
      isClosed: false,
      intervals: [{ start: "23:59", end: "00:00" }],
    });
    assert.ok(warning);
    assert.match(warning!, /^Monday's weekly hours/);
    assert.match(warning!, /Overnight hours are not supported/);
  });

  test("undefined day (no row at all) is not flagged", () => {
    assert.equal(describeInvalidWeeklyDay(undefined), null);
  });
});

describe("describeInvalidOverride — dashboard diagnostic, specific to the affected date", () => {
  test("a full-day closure is never flagged", () => {
    assert.equal(
      describeInvalidOverride(
        { isFullDayClosure: true, intervals: [{ start: "23:59", end: "00:00" }] },
        "2026-10-09",
      ),
      null,
    );
  });

  test("an override with the legacy-invalid interval names the exact date", () => {
    const warning = describeInvalidOverride(
      { isFullDayClosure: false, intervals: [{ start: "23:59", end: "00:00" }] },
      "2026-10-09",
    );
    assert.ok(warning);
    assert.match(warning!, /2026-10-09/);
  });

  test("no override at all is not flagged", () => {
    assert.equal(describeInvalidOverride(undefined, "2026-10-09"), null);
  });
});

describe("logInvalidBusinessHoursOnce — bounded dedup, no full clear", () => {
  beforeEach(() => {
    _resetWarnedKeysForTests();
  });

  test("logs on the first occurrence of a key", () => {
    const calls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      logInvalidBusinessHoursOnce("biz-1:1", { businessId: "biz-1", dayOfWeek: 1 });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(calls.length, 1);
  });

  test("does not log again for the same key", () => {
    const calls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      logInvalidBusinessHoursOnce("biz-1:1", { businessId: "biz-1", dayOfWeek: 1 });
      logInvalidBusinessHoursOnce("biz-1:1", { businessId: "biz-1", dayOfWeek: 1 });
      logInvalidBusinessHoursOnce("biz-1:1", { businessId: "biz-1", dayOfWeek: 1 });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(calls.length, 1, "repeated calls with the same key must not re-log");
  });

  test("logs separately for a different key", () => {
    const calls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      logInvalidBusinessHoursOnce("biz-1:1", {});
      logInvalidBusinessHoursOnce("biz-1:2", {});
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(calls.length, 2);
  });

  test("logged payload never includes a message field that looks like PII (shape check only)", () => {
    const calls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      logInvalidBusinessHoursOnce("biz-1:1", {
        businessId: "biz-1",
        dayOfWeek: 1,
        start: "23:59",
        end: "00:00",
      });
    } finally {
      console.warn = originalWarn;
    }
    const [, details] = calls[0]!;
    const keys = Object.keys(details as Record<string, unknown>);
    for (const key of keys) {
      assert.doesNotMatch(key, /name|phone|email|customer|patient/i);
    }
  });
});
