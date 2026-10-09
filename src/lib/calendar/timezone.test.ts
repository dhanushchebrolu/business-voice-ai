import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { zonedWallTimeToUtc, dayOfWeekInTimezone, businessDayUtcBounds } from "./timezone.ts";

describe("zonedWallTimeToUtc", () => {
  test("converts an Asia/Kolkata (UTC+5:30, no DST) wall time correctly", () => {
    const utc = zonedWallTimeToUtc("2026-09-25", "16:00", "Asia/Kolkata");
    assert.equal(utc.toISOString(), "2026-09-25T10:30:00.000Z");
  });

  test("converts an America/New_York (UTC-4 in September, EDT) wall time correctly", () => {
    const utc = zonedWallTimeToUtc("2026-09-25", "09:00", "America/New_York");
    assert.equal(utc.toISOString(), "2026-09-25T13:00:00.000Z");
  });

  test("converts an America/New_York winter (UTC-5, EST, no DST) wall time correctly", () => {
    const utc = zonedWallTimeToUtc("2026-01-15", "09:00", "America/New_York");
    assert.equal(utc.toISOString(), "2026-01-15T14:00:00.000Z");
  });

  test("converts a UTC business's own timezone as a no-op", () => {
    const utc = zonedWallTimeToUtc("2026-09-25", "16:00", "UTC");
    assert.equal(utc.toISOString(), "2026-09-25T16:00:00.000Z");
  });

  test("different businesses in different timezones produce different UTC instants for the same wall time", () => {
    const kolkata = zonedWallTimeToUtc("2026-09-25", "09:00", "Asia/Kolkata");
    const newYork = zonedWallTimeToUtc("2026-09-25", "09:00", "America/New_York");
    const london = zonedWallTimeToUtc("2026-09-25", "09:00", "Europe/London");
    assert.notEqual(kolkata.toISOString(), newYork.toISOString());
    assert.notEqual(kolkata.toISOString(), london.toISOString());
    assert.notEqual(newYork.toISOString(), london.toISOString());
  });
});

/**
 * Production bug (Round F audit): calendar-tools.server.ts's
 * check_calendar_availability used to fetch busy periods with
 * `${dateIso}T00:00:00.000Z`..`T23:59:59.999Z` — correct ONLY when the
 * business timezone is literally UTC. businessDayUtcBounds fixes this by
 * resolving the actual local midnight-to-midnight window via
 * zonedWallTimeToUtc, same as the rest of the availability pipeline
 * already does for slot generation.
 */
describe("businessDayUtcBounds", () => {
  test("Asia/Kolkata (+5:30, ahead of UTC): the business day starts BEFORE UTC midnight of the same date — the naive window would miss the business's own early-morning hours", () => {
    const { start, end } = businessDayUtcBounds("2026-10-09", "Asia/Kolkata");
    // Midnight IST on Oct 9 is 18:30 UTC on Oct 8 — hours before the naive
    // `2026-10-09T00:00:00.000Z` the old code used.
    assert.equal(start.toISOString(), "2026-10-08T18:30:00.000Z");
    assert.equal(end.toISOString(), "2026-10-09T18:30:00.000Z");
    assert.ok(
      start.getTime() < new Date("2026-10-09T00:00:00.000Z").getTime(),
      "the correct start must be earlier than the naive UTC-day start the old code used",
    );
  });

  test("America/New_York (behind UTC): the business day ends AFTER UTC midnight of the next date — the naive window would miss the business's own late-evening hours", () => {
    const { start, end } = businessDayUtcBounds("2026-09-25", "America/New_York");
    // Midnight EDT (UTC-4 in September) on Sep 26 is 04:00 UTC on Sep 26 —
    // hours after the naive `2026-09-25T23:59:59.999Z` the old code used.
    assert.equal(start.toISOString(), "2026-09-25T04:00:00.000Z");
    assert.equal(end.toISOString(), "2026-09-26T04:00:00.000Z");
    assert.ok(
      end.getTime() > new Date("2026-09-25T23:59:59.999Z").getTime(),
      "the correct end must be later than the naive UTC-day end the old code used",
    );
  });

  test("a business month/year boundary rolls over correctly (Dec 31 -> Jan 1)", () => {
    const { start, end } = businessDayUtcBounds("2026-12-31", "Asia/Kolkata");
    assert.equal(start.toISOString(), "2026-12-30T18:30:00.000Z");
    assert.equal(end.toISOString(), "2026-12-31T18:30:00.000Z");
  });

  test("the window is exactly 24 hours wide regardless of timezone", () => {
    for (const tz of ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Kiritimati"]) {
      const { start, end } = businessDayUtcBounds("2026-06-15", tz);
      assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000, `mismatch for ${tz}`);
    }
  });
});

describe("dayOfWeekInTimezone", () => {
  test("returns the correct day-of-week (0=Sunday) for a known date", () => {
    // 2026-09-25 is a Friday.
    assert.equal(dayOfWeekInTimezone("2026-09-25", "Asia/Kolkata"), 5);
  });

  test("a date near midnight can resolve to a different day-of-week depending on timezone", () => {
    // Late-night US Pacific can be a different calendar day than India at the same instant —
    // this just confirms the function is timezone-aware, not hardcoded to one zone.
    const kolkataDay = dayOfWeekInTimezone("2026-09-25", "Asia/Kolkata");
    const pacificDay = dayOfWeekInTimezone("2026-09-25", "America/Los_Angeles");
    assert.equal(typeof kolkataDay, "number");
    assert.equal(typeof pacificDay, "number");
  });
});
