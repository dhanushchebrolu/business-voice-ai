import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Production reliability gap (appointment/calendar audit): the backend
 * reschedule path (rescheduleBookingManual in bookings.functions.ts, which
 * already re-checks for conflicts and updates the real Google Calendar
 * event via booking-service.server.ts) existed but was never reachable
 * from this dashboard page — only cancellation had a UI. Source-scanned
 * like every other React route test in this codebase (see
 * landing-footer.test.ts) rather than rendered — this repo's Node-native
 * test runner has no jsdom/RTL harness wired up for route components.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.bookings.tsx"), "utf8");
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("app.bookings.tsx — reschedule is actually wired to the existing backend, not just cancellation", () => {
  test("imports rescheduleBookingManual from the existing bookings.functions.ts — reuses it rather than reinventing the reschedule logic", () => {
    assert.match(
      src,
      /import \{\s*listBookings,\s*cancelBookingManual,\s*rescheduleBookingManual,?\s*\} from "@\/lib\/bookings\.functions"/,
    );
  });

  test("calls useServerFn(rescheduleBookingManual) and actually invokes it, not just imports it unused", () => {
    assert.match(code, /const rescheduleFn = useServerFn\(rescheduleBookingManual\)/);
    assert.match(code, /await rescheduleFn\(\{/);
  });

  test("the reschedule call sends bookingId/newStartIso/newEndIso — the exact fields rescheduleBookingManual's input schema requires", () => {
    const callStart = code.indexOf("await rescheduleFn({");
    const callEnd = code.indexOf("});", callStart);
    const call = code.slice(callStart, callEnd);
    assert.match(call, /bookingId/);
    assert.match(call, /newStartIso: newStart\.toISOString\(\)/);
    assert.match(call, /newEndIso: newEnd\.toISOString\(\)/);
  });

  test("the new end time preserves the booking's original duration rather than asking for a new one", () => {
    assert.match(
      code,
      /durationMs = new Date\(currentEndIso\)\.getTime\(\) - new Date\(currentStartIso\)\.getTime\(\)/,
    );
    assert.match(code, /newEnd = new Date\(newStart\.getTime\(\) \+ durationMs\)/);
  });

  test("a Reschedule button/dialog renders for every cancellable booking, not only cancel", () => {
    assert.match(code, /Reschedule\s*<\/Button>/, "expected a visible Reschedule action");
    assert.match(
      code,
      /Cancel\s*<\/Button>/,
      "expected the existing Cancel action to still be present",
    );
  });

  test("on success, invalidates the bookings query so the list reflects the new time without a manual refresh", () => {
    const fnStart = code.indexOf("async function handleReschedule(");
    const fnEnd = code.indexOf("\n  }\n", fnStart);
    const fnBody = code.slice(fnStart, fnEnd);
    assert.match(fnBody, /queryClient\.invalidateQueries\(\{ queryKey: \["bookings"\] \}\)/);
  });

  test("a reschedule failure shows an error toast and never silently swallows it", () => {
    const fnStart = code.indexOf("async function handleReschedule(");
    const fnEnd = code.indexOf("\n  }\n", fnStart);
    const fnBody = code.slice(fnStart, fnEnd);
    assert.match(fnBody, /catch \(err\) \{/);
    assert.match(fnBody, /toast\.error\(/);
  });

  test("an empty/invalid new start time is rejected before calling the server function", () => {
    const fnStart = code.indexOf("async function handleReschedule(");
    const fnEnd = code.indexOf("\n  }\n", fnStart);
    const fnBody = code.slice(fnStart, fnEnd);
    assert.match(fnBody, /if \(!newStartLocal\) return;/);
    assert.match(fnBody, /Number\.isNaN\(newStart\.getTime\(\)\)/);
  });
});
