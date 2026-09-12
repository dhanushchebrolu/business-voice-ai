import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isWithinCallingWindow } from "./campaign-schedule.ts";

describe("isWithinCallingWindow", () => {
  test("allows any time when the schedule is empty", () => {
    assert.equal(isWithinCallingWindow({}, new Date("2026-09-12T03:00:00Z")), true);
  });

  test("blocks before the start date", () => {
    assert.equal(
      isWithinCallingWindow(
        { startDate: "2026-10-01", timezone: "UTC" },
        new Date("2026-09-12T10:00:00Z"),
      ),
      false,
    );
  });

  test("blocks after the end date", () => {
    assert.equal(
      isWithinCallingWindow(
        { endDate: "2026-09-01", timezone: "UTC" },
        new Date("2026-09-12T10:00:00Z"),
      ),
      false,
    );
  });

  test("blocks a day not in the allowed days list", () => {
    // 2026-09-12 is a Saturday (weekday 6).
    assert.equal(
      isWithinCallingWindow(
        { days: [1, 2, 3, 4, 5], timezone: "UTC" },
        new Date("2026-09-12T10:00:00Z"),
      ),
      false,
    );
  });

  test("allows a day that is in the allowed days list", () => {
    // 2026-09-11 is a Friday (weekday 5).
    assert.equal(
      isWithinCallingWindow(
        { days: [1, 2, 3, 4, 5], timezone: "UTC" },
        new Date("2026-09-11T10:00:00Z"),
      ),
      true,
    );
  });

  test("respects a same-day time window", () => {
    const schedule = { windowStart: "10:00", windowEnd: "18:00", timezone: "UTC" };
    assert.equal(isWithinCallingWindow(schedule, new Date("2026-09-12T09:59:00Z")), false);
    assert.equal(isWithinCallingWindow(schedule, new Date("2026-09-12T10:00:00Z")), true);
    assert.equal(isWithinCallingWindow(schedule, new Date("2026-09-12T17:59:00Z")), true);
    assert.equal(isWithinCallingWindow(schedule, new Date("2026-09-12T18:00:00Z")), false);
  });

  test("respects a window that crosses midnight", () => {
    const schedule = { windowStart: "22:00", windowEnd: "02:00", timezone: "UTC" };
    assert.equal(isWithinCallingWindow(schedule, new Date("2026-09-12T23:00:00Z")), true);
    assert.equal(isWithinCallingWindow(schedule, new Date("2026-09-12T01:00:00Z")), true);
    assert.equal(isWithinCallingWindow(schedule, new Date("2026-09-12T12:00:00Z")), false);
  });

  test("evaluates the window in the configured IANA timezone, not UTC", () => {
    // 03:30 UTC is 09:00 IST (Asia/Kolkata, UTC+5:30) on the same calendar day.
    const schedule = { windowStart: "09:00", windowEnd: "18:00", timezone: "Asia/Kolkata" };
    assert.equal(isWithinCallingWindow(schedule, new Date("2026-09-12T03:30:00Z")), true);
    assert.equal(isWithinCallingWindow(schedule, new Date("2026-09-12T02:00:00Z")), false);
  });

  test("fails safe (not callable) for an invalid timezone rather than ignoring it", () => {
    assert.equal(
      isWithinCallingWindow(
        { windowStart: "09:00", windowEnd: "18:00", timezone: "Not/AZone" },
        new Date("2026-09-12T10:00:00Z"),
      ),
      false,
    );
  });
});
