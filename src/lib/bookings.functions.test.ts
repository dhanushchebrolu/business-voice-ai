import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "bookings.functions.ts"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("authentication and tenant derivation", () => {
  test("every exported server function is gated by requireSupabaseAuth", () => {
    const matches = src.match(/\.middleware\(\[requireSupabaseAuth\]\)/g) ?? [];
    assert.equal(
      matches.length,
      4,
      "listBookings, createBookingManual, rescheduleBookingManual, cancelBookingManual",
    );
  });

  test("organizationId always comes from organization_members via resolveOrgId, never from client input", () => {
    assert.match(src, /await resolveOrgId\(context\)/);
    assert.doesNotMatch(src, /organizationId:\s*(data|input)\./);
  });

  test("no input schema accepts an organizationId field", () => {
    assert.doesNotMatch(src, /organizationId:\s*z\./);
  });

  test("business ownership is re-validated for booking creation, not merely assumed from a client-supplied businessId", () => {
    assert.match(src, /business\.organization_id !== organizationId/);
  });

  test("booking ownership is re-validated for reschedule/cancel before any mutation", () => {
    const occurrences = code.split("booking.organization_id !== organizationId").length - 1;
    assert.ok(
      occurrences >= 2,
      "expected the ownership check in both rescheduleBookingManual and cancelBookingManual",
    );
  });
});

describe("calendar writes go through the tested booking-service core, not ad-hoc queries", () => {
  test("creation, reschedule, and cancellation all delegate to calendar/booking-service.server", () => {
    assert.match(code, /import\("@\/lib\/calendar\/booking-service\.server"\)/);
    assert.match(code, /createBooking\(/);
    assert.match(code, /rescheduleBooking\(/);
    assert.match(code, /cancelBooking\(/);
  });

  test("never fabricates a google_event_id or writes calendar state without going through the provider", () => {
    assert.doesNotMatch(code, /google_event_id:\s*["'`]/);
  });
});
