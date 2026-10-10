import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeAvailability,
  resolveEffectiveOpenRangesUtc,
  type ComputeAvailabilityInput,
} from "./calendar-service.server.ts";

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

/**
 * A business break (e.g. a 13:00-14:00 lunch break) is modeled as a GAP
 * between two separate business_hours intervals on the same day — never a
 * busy period, and never a special case computeAvailability needs its own
 * branch for: candidate slots are generated independently per interval
 * (see the `for (const interval of day.intervals)` loop), so a time that
 * falls outside every interval is never offered, by construction.
 */
describe("computeAvailability — business breaks (a gap between two business_hours intervals)", () => {
  test("no slots are ever generated during the gap between a morning and an afternoon interval", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      businessHours: [
        {
          dayOfWeek: FRIDAY,
          isClosed: false,
          intervals: [
            { start: "09:00", end: "13:00" }, // morning
            { start: "14:00", end: "18:00" }, // afternoon, after the lunch break
          ],
        },
      ],
    });
    const breakStartUtc = new Date("2026-09-25T07:30:00.000Z"); // 13:00 IST
    const breakEndUtc = new Date("2026-09-25T08:30:00.000Z"); // 14:00 IST
    for (const slot of slots) {
      const start = new Date(slot.start);
      assert.ok(
        start < breakStartUtc || start >= breakEndUtc,
        `slot ${slot.start} falls inside the 13:00-14:00 IST break`,
      );
    }
    // Sanity: slots on both sides of the break are still offered.
    assert.ok(slots.some((s) => s.start === "2026-09-25T03:30:00.000Z")); // 09:00 IST
    assert.ok(slots.some((s) => s.start === "2026-09-25T08:30:00.000Z")); // 14:00 IST
  });
});

/**
 * Daily override precedence (hospital calendar spec section 3, 6 required
 * schedule-generation scenarios): a full-day closure beats everything; a
 * date-specific open/close decision beats the recurring weekly hours for
 * that one date only; and neither can ever force open a slot that's
 * already booked or externally busy.
 */
describe("computeAvailability — daily override precedence", () => {
  test("1. no override present — the recurring weekly schedule applies unmodified", () => {
    const slots = computeAvailability({ ...BASE, dateIso: "2026-09-25", timezone: "Asia/Kolkata" });
    assert.equal(slots.length, 4); // same as the no-override baseline
  });

  test("2. a full-day closure override removes every slot, even though the recurring weekly day is open", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      override: { isFullDayClosure: true, intervals: [] },
    });
    assert.deepEqual(slots, []);
  });

  test("3. a full-day closure wins even if the same override also lists an 'open' interval", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      override: {
        isFullDayClosure: true,
        intervals: [{ start: "09:00", end: "10:00", isOpen: true }],
      },
    });
    assert.deepEqual(slots, []);
  });

  test("4. an 'open' override interval adds slots outside the recurring weekly hours", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      businessHours: [{ dayOfWeek: FRIDAY, isClosed: true, intervals: [] }], // recurring day is CLOSED
      override: {
        isFullDayClosure: false,
        intervals: [{ start: "09:00", end: "10:00", isOpen: true }],
      },
    });
    const starts = slots.map((s) => s.start);
    assert.deepEqual(starts, ["2026-09-25T03:30:00.000Z", "2026-09-25T04:00:00.000Z"]); // 09:00, 09:30 IST
  });

  test("5. a 'close' override interval removes slots that the recurring weekly hours would otherwise have opened", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      // recurring hours: 09:00-11:00 IST (BASE); close 09:30-10:00 IST for this one date.
      override: {
        isFullDayClosure: false,
        intervals: [{ start: "09:30", end: "10:00", isOpen: false }],
      },
    });
    const starts = slots.map((s) => s.start);
    assert.deepEqual(starts, [
      "2026-09-25T03:30:00.000Z", // 09:00 IST
      "2026-09-25T04:30:00.000Z", // 10:00 IST
      "2026-09-25T05:00:00.000Z", // 10:30 IST
    ]);
  });

  test("6. a 'close' override always wins over an overlapping 'open' in the same override (conservative precedence) and an override can never reopen a slot already taken by a confirmed booking or Google-busy period", () => {
    const sameRangeBothWays = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      override: {
        isFullDayClosure: false,
        intervals: [
          { start: "09:00", end: "09:30", isOpen: true },
          { start: "09:00", end: "09:30", isOpen: false },
        ],
      },
    });
    assert.equal(
      sameRangeBothWays.some((s) => s.start === "2026-09-25T03:30:00.000Z"),
      false,
      "close must win over open for the exact same range",
    );

    // Override opens 14:00-15:00 IST (outside the recurring 09:00-11:00 window), but an
    // existing ClickAI booking already occupies 14:00-14:30 IST — the override cannot
    // silently reopen it.
    const withExistingBooking = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      override: {
        isFullDayClosure: false,
        intervals: [{ start: "14:00", end: "15:00", isOpen: true }],
      },
      existingBookings: [{ start: "2026-09-25T08:30:00.000Z", end: "2026-09-25T09:00:00.000Z" }], // 14:00-14:30 IST
    });
    assert.equal(
      withExistingBooking.some((s) => s.start === "2026-09-25T08:30:00.000Z"),
      false,
      "an override must never reopen a slot an existing booking already occupies",
    );
    assert.ok(
      withExistingBooking.some((s) => s.start === "2026-09-25T09:00:00.000Z"), // 14:30 IST — still offered
    );
  });
});

describe("computeAvailability / resolveEffectiveOpenRangesUtc — legacy-invalid interval regression (production has a business with 7 rows shaped this way)", () => {
  test("a reversed {start:'23:59', end:'00:00'} weekly interval produces zero slots, never a false 'open all day'", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      businessHours: [
        { dayOfWeek: FRIDAY, isClosed: false, intervals: [{ start: "23:59", end: "00:00" }] },
      ],
    });
    assert.deepEqual(slots, []);
  });

  test("the same reversed interval also fails closed via resolveEffectiveOpenRangesUtc (the function booking-time revalidation calls)", () => {
    const ranges = resolveEffectiveOpenRangesUtc(
      "2026-09-25",
      "Asia/Kolkata",
      [{ dayOfWeek: FRIDAY, isClosed: false, intervals: [{ start: "23:59", end: "00:00" }] }],
      undefined,
    );
    // No real [start,end) booking window can ever fall inside a range whose
    // own end precedes its start — confirmed here rather than merely
    // asserted, since this is the exact function booking-service.server.ts
    // checks "start >= r.start && end <= r.end" against.
    for (const range of ranges) {
      assert.ok(
        range.end.getTime() <= range.start.getTime(),
        "if a backwards range survives at all, it must stay backwards/unmatchable, never silently reinterpreted as forward",
      );
    }
  });

  test("a weekly day with NO override still fails closed for a reversed interval (merge path, not just the empty-override-intervals path)", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      businessHours: [
        { dayOfWeek: FRIDAY, isClosed: false, intervals: [{ start: "23:59", end: "00:00" }] },
      ],
      override: undefined,
    });
    assert.deepEqual(slots, []);
  });

  test("an override that exists but has empty intervals does not resurrect a reversed weekly interval as bookable", () => {
    const slots = computeAvailability({
      ...BASE,
      dateIso: "2026-09-25",
      timezone: "Asia/Kolkata",
      businessHours: [
        { dayOfWeek: FRIDAY, isClosed: false, intervals: [{ start: "23:59", end: "00:00" }] },
      ],
      override: { isFullDayClosure: false, intervals: [] },
    });
    assert.deepEqual(slots, []);
  });
});
