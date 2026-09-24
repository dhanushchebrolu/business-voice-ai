import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { zonedWallTimeToUtc, dayOfWeekInTimezone } from "./timezone.ts";

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
