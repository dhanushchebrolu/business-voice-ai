import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scan coverage for the staff "Retry calendar sync" server function
 * (createServerFn module — same convention as bookings.functions.test.ts).
 * The retry logic itself is exercised in
 * calendar/booking-calendar-sync-retry.test.ts.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "booking-calendar-sync.functions.ts"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("retryBookingCalendarSyncManual — authorization and tenant scoping", () => {
  test("is gated by requireSupabaseAuth", () => {
    assert.equal((src.match(/\.middleware\(\[requireSupabaseAuth\]\)/g) ?? []).length, 1);
  });

  test("accepts only a booking id — no organizationId from the client", () => {
    assert.match(code, /z\.object\(\{ bookingId: z\.string\(\)\.uuid\(\) \}\)/);
    assert.doesNotMatch(code, /organizationId:\s*z\./);
    assert.doesNotMatch(code, /organizationId:\s*(data|input)\./);
  });

  test("the organization comes from the booking row, and the caller must be a member of THAT organization", () => {
    assert.match(code, /\.eq\("organization_id", booking\.organization_id\)/);
    assert.match(code, /\.eq\("user_id", context\.userId\)/);
    assert.match(code, /organizationId: booking\.organization_id/);
  });

  test("viewers cannot retry; a booking outside the caller's workspace reads as not found", () => {
    assert.match(code, /membership\.role === "viewer"/);
    const notFound = code.match(/throw new Error\("Booking not found\."\)/g) ?? [];
    assert.ok(notFound.length >= 2, "missing booking and non-member both say not found");
  });

  test("runs as a staff-triggered retry through the shared booking-service implementation", () => {
    assert.match(code, /trigger: "staff"/);
    assert.match(code, /retryBookingCalendarSync\(/);
  });
});
