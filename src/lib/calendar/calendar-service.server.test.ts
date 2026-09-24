import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeAvailability, type ComputeAvailabilityInput } from "./calendar-service.server.ts";

const FRIDAY = 5; // 2026-09-25 is a Friday
const BASE: Omit<ComputeAvailabilityInput, "dateIso" | "timezone"> = {
  businessHours: [
    { dayOfWeek: FRIDAY, isClosed: false, intervals: [{ start: "09:00", end: "11:00" }] },
  ],
  durationMinutes: 30,
  googleBusyPeriods: [],
  existingBookings: [],
  now: new Date("2026-09-20T00:00:00Z"), // well before the requested date, so nothing is filtered as "past"
};

describe("computeAvailability — the basic grid", () => {
  test("returns every 30-minute slot inside a 09:00-11:00 window with no conflicts", () => {
    const slots = computeAvailability({ ...BASE, dateIso: "2026-09-25", timezone: "Asia/Kolkata" });
    assert.equal(slots.length, 4); // 09:00, 09:30, 10:00, 10:30
    assert.equal(slots[0]!.start, "2026-09-25T03:30:00.000Z"); // 09:00 IST = 03:30 UTC
    assert.equal(slots[0]!.end, "2026-09-25T04:00:00.000Z");
  });

  test("a closed day returns no slots at all", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      businessHours: [{ dayOfWeek: FRIDAY, isClosed: true, intervals: [] }],
    });
    assert.deepEqual(slots, []);
  });

  test("a day with no business_hours row at all returns no slots (never invents hours)", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      businessHours: [],
    });
    assert.deepEqual(slots, []);
  });
});

describe("computeAvailability — Google Calendar conflicts", () => {
  test("a Google-busy period removes the exact overlapping slot", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      googleBusyPeriods: [{ start: "2026-09-25T04:00:00.000Z", end: "2026-09-25T04:30:00.000Z" }], // 09:30-10:00 IST
    });
    const starts = slots.map((s) => s.start);
    assert.deepEqual(starts, [
      "2026-09-25T03:30:00.000Z", // 09:00
      "2026-09-25T04:30:00.000Z", // 10:00
      "2026-09-25T05:00:00.000Z", // 10:30
    ]);
  });

  test("a Google-busy period spanning multiple candidate slots removes all of them", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      googleBusyPeriods: [{ start: "2026-09-25T03:30:00.000Z", end: "2026-09-25T05:00:00.000Z" }], // 09:00-10:30 IST
    });
    assert.equal(slots.length, 1); // only 10:30 remains
    assert.equal(slots[0]!.start, "2026-09-25T05:00:00.000Z");
  });
});

describe("computeAvailability — existing ClickAI bookings", () => {
  test("an existing ClickAI booking blocks its own slot the same way a Google event does", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      existingBookings: [{ start: "2026-09-25T03:30:00.000Z", end: "2026-09-25T04:00:00.000Z" }],
    });
    assert.equal(
      slots.some((s) => s.start === "2026-09-25T03:30:00.000Z"),
      false,
    );
  });
});

describe("computeAvailability — buffer time", () => {
  test("a buffer blocks adjacent slots, not just the exact overlap", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      bufferMinutes: 15,
      googleBusyPeriods: [{ start: "2026-09-25T04:00:00.000Z", end: "2026-09-25T04:30:00.000Z" }], // 09:30-10:00 IST
    });
    // With a 15-minute buffer on both sides of the busy period (09:15-10:15
    // effectively blocked), the 09:00 slot (ends 09:30, buffered end 09:45 > 09:15) and
    // 10:00 slot (buffered start 09:45 < 10:15) are also blocked; only 10:30 survives.
    const starts = slots.map((s) => s.start);
    assert.deepEqual(starts, ["2026-09-25T05:00:00.000Z"]);
  });

  test("no buffer (default) only blocks the exact overlap", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      googleBusyPeriods: [{ start: "2026-09-25T04:00:00.000Z", end: "2026-09-25T04:30:00.000Z" }],
    });
    assert.equal(slots.length, 3);
  });
});

describe("computeAvailability — never offers the past", () => {
  test("a slot earlier than `now` on the requested day is excluded", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      now: new Date("2026-09-25T04:15:00.000Z"), // 09:45 IST — after the 09:00 and 09:30 slots have started
    });
    const starts = slots.map((s) => s.start);
    assert.deepEqual(starts, ["2026-09-25T04:30:00.000Z", "2026-09-25T05:00:00.000Z"]);
  });

  test("a fully past day returns no slots", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      now: new Date("2026-09-26T00:00:00.000Z"),
    });
    assert.deepEqual(slots, []);
  });
});

describe("computeAvailability — different timezones never bleed into each other", () => {
  test("the same business_hours interval produces different UTC slot times in different timezones", () => {
    const kolkataSlots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
    });
    const newYorkSlots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "America/New_York",
    });
    assert.notEqual(kolkataSlots[0]!.start, newYorkSlots[0]!.start);
  });
});

describe("computeAvailability — service duration determines slot length", () => {
  test("a 45-minute service produces 45-minute slots, not 30-minute ones", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      durationMinutes: 45,
    });
    for (const slot of slots) {
      const durationMs = new Date(slot.end).getTime() - new Date(slot.start).getTime();
      assert.equal(durationMs, 45 * 60_000);
    }
  });
});
