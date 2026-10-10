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

describe("Google Calendar is optional for dashboard-created/-managed bookings, never a hard requirement", () => {
  test("createBookingManual never throws a 'Connect a Google Calendar' error — it computes hasUsableConnection and proceeds either way", () => {
    assert.doesNotMatch(code, /Connect a Google Calendar for this business/);
    const fnStart = code.indexOf("export const createBookingManual");
    const fnEnd = code.indexOf("\nconst rescheduleInputSchema");
    const fnBody = code.slice(fnStart, fnEnd);
    assert.match(fnBody, /const hasUsableConnection = Boolean\(/);
    assert.match(fnBody, /createBooking\(supabaseAdmin, provider, \{/);
    assert.match(fnBody, /calendarConnectionId: hasUsableConnection \? connection!\.id : null/);
  });

  test("rescheduleBookingManual never throws for a booking with no connected calendar — it passes provider/calendarId as null instead", () => {
    assert.doesNotMatch(code, /This booking has no connected calendar to reschedule against/);
    const fnStart = code.indexOf("export const rescheduleBookingManual");
    const fnEnd = code.indexOf("\nconst cancelInputSchema");
    const fnBody = code.slice(fnStart, fnEnd);
    assert.match(fnBody, /let provider: CalendarProvider \| null = null;/);
    assert.match(fnBody, /let calendarId: string \| null = null;/);
    assert.match(fnBody, /if \(booking\.calendar_connection_id\) \{/);
    assert.match(fnBody, /rescheduleBooking\(supabaseAdmin, provider, \{/);
  });

  test("cancelBookingManual already handled the no-connection case via cancel_booking_atomic before this fix, and still does", () => {
    const fnStart = code.indexOf("export const cancelBookingManual");
    const fnBody = code.slice(fnStart);
    assert.match(fnBody, /if \(!calendarId \|\| !booking\.calendar_connection_id\) \{/);
    assert.match(fnBody, /"cancel_booking_atomic"/);
  });
});
