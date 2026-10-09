import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "calendar-dashboard.functions.ts"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

/**
 * Source-scan verification, same technique as bookings.functions.test.ts's
 * own tests — appropriate here for the same reason: these are thin
 * createServerFn wrappers whose interesting behavior IS the wiring
 * (auth middleware present, tenant/role checks actually called, no
 * server-trusted field ever sourced from client input), which a static
 * scan verifies directly and unambiguously, rather than needing to
 * reconstruct TanStack Start's server-function runtime to invoke them.
 * The actual business logic these functions delegate to
 * (resolveEffectiveOpenRangesUtc, the override precedence rules) is
 * already covered by calendar-service.server.test.ts.
 */

describe("authentication and tenant derivation", () => {
  test("every exported server function is gated by requireSupabaseAuth", () => {
    const matches = src.match(/\.middleware\(\[requireSupabaseAuth\]\)/g) ?? [];
    assert.equal(
      matches.length,
      5,
      "getCalendarDayView, setWeeklyHours, applyDailyOverride, removeDailyOverride, resolveSyncConflict",
    );
  });

  test("organizationId always comes from organization_members via resolveOrgContext, never from client input", () => {
    assert.match(src, /await resolveOrgContext\(context\)/);
    assert.doesNotMatch(src, /organizationId:\s*(data|input)\./);
  });

  test("no input schema accepts an organizationId or role field from the client", () => {
    assert.doesNotMatch(src, /organizationId:\s*z\./);
    assert.doesNotMatch(src, /role:\s*z\./);
  });

  test("business ownership is re-validated via resolveBusiness for every function that takes a businessId", () => {
    // getCalendarDayView's call is wrapped in timedStep (diagnostics for
    // the deployed-calendar-page investigation), so it reads
    // `timedStep(..., () => resolveBusiness(...))` rather than a bare
    // `await resolveBusiness(...)` — still awaited, just one level deeper.
    const occurrences = (code.match(/resolveBusiness\(supabaseAdmin,/g) ?? []).length;
    assert.ok(
      occurrences >= 4,
      "expected resolveBusiness to be called for getCalendarDayView, setWeeklyHours, applyDailyOverride, removeDailyOverride",
    );
    assert.match(code, /business\.organization_id !== organizationId/);
  });

  test("a sync conflict's organization ownership is re-validated before it can be resolved", () => {
    assert.match(code, /conflict\.organization_id !== organizationId/);
  });
});

describe("role-based authorization — viewer is read-only", () => {
  test("every write function calls requireWriteRole before touching the database", () => {
    const matches = code.match(/requireWriteRole\(role\);/g) ?? [];
    assert.equal(
      matches.length,
      4,
      "setWeeklyHours, applyDailyOverride, removeDailyOverride, resolveSyncConflict",
    );
  });

  test("getCalendarDayView (a read) never calls requireWriteRole", () => {
    const dayViewHandler = code.slice(
      code.indexOf("export const getCalendarDayView"),
      code.indexOf("export const setWeeklyHours"),
    );
    assert.doesNotMatch(dayViewHandler, /requireWriteRole/);
  });

  test("requireWriteRole rejects exactly the 'viewer' role and nothing else by name", () => {
    assert.match(code, /role === "viewer"/);
  });
});

describe("schedule mutations go through the locked RPCs, never a direct table write", () => {
  test("applyDailyOverride calls apply_business_schedule_override, not a direct .upsert()", () => {
    const applyHandler = code.slice(
      code.indexOf("export const applyDailyOverride"),
      code.indexOf("export const removeDailyOverride"),
    );
    assert.match(applyHandler, /\.rpc\(\s*"apply_business_schedule_override"/);
    assert.doesNotMatch(applyHandler, /\.upsert\(/);
  });

  test("removeDailyOverride calls remove_business_schedule_override, not a direct .delete()", () => {
    const removeHandler = code.slice(
      code.indexOf("export const removeDailyOverride"),
      code.indexOf("const resolveConflictInputSchema"),
    );
    assert.match(removeHandler, /\.rpc\(\s*"remove_business_schedule_override"/);
    assert.doesNotMatch(removeHandler, /\.delete\(\)/);
  });

  test("setWeeklyHours calls set_business_weekly_hours, not a direct .update()", () => {
    const setHoursHandler = code.slice(
      code.indexOf("export const setWeeklyHours"),
      code.indexOf("const overrideIntervalSchema"),
    );
    assert.match(setHoursHandler, /\.rpc\(\s*"set_business_weekly_hours"/);
    assert.doesNotMatch(setHoursHandler, /\.update\(/);
  });

  test("a full-day closure clears any stored sub-interval decisions sent to the RPC (intervals become irrelevant once is_full_day_closure is true)", () => {
    assert.match(code, /p_intervals:\s*data\.isFullDayClosure\s*\?\s*\[\]\s*:\s*data\.intervals/);
  });

  test("applyDailyOverride maps the RPC's active-booking conflict into a clear, non-raw error message", () => {
    const applyHandler = code.slice(
      code.indexOf("export const applyDailyOverride"),
      code.indexOf("export const removeDailyOverride"),
    );
    assert.match(applyHandler, /CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING/);
  });

  test("every new RPC call passes p_organization_id sourced from resolveOrgContext, never a client-supplied field", () => {
    const rpcCalls =
      code.match(
        /\.rpc\(\s*"(apply_business_schedule_override|remove_business_schedule_override|set_business_weekly_hours)"[\s\S]*?\}\)/g,
      ) ?? [];
    assert.ok(rpcCalls.length >= 3, "expected all three new RPC call sites");
    for (const call of rpcCalls) {
      assert.match(call, /p_organization_id:\s*organizationId/);
    }
  });
});

describe("day-view slot state reuses the one precedence resolver, never a second implementation", () => {
  test("imports resolveEffectiveOpenRangesUtc from calendar-service.server rather than re-deriving precedence here", () => {
    assert.match(
      src,
      /import\(?.*resolveEffectiveOpenRangesUtc.*from ["']@\/lib\/calendar\/calendar-service\.server["']/s,
    );
  });

  test("a slot already covered by a confirmed/pending booking is never reported as merely 'open', regardless of the override state", () => {
    assert.match(code, /overlapsBooking\s*\?\s*"booked"/);
  });
});

/**
 * Deployed-calendar-page investigation (klyro.aiblaze-io.workers.dev
 * /app/calendar showing the generic "Could not load this day's calendar."
 * with no console error and no failed network request): every operation
 * getCalendarDayView performs now carries a correlation id, a fixed
 * operation name, and elapsed time, logged server-side, with a
 * DiagnosedStepError (embedding the same operation name + correlation id
 * + sanitized error code) reaching the client in place of the original
 * error — so the failing step is always identifiable from the rendered
 * ErrorState text alone, not just from logs the client can't see.
 */
describe("getCalendarDayView — every step is wrapped in structured diagnostics (correlation id, operation name, elapsed time)", () => {
  test("imports newCorrelationId/timedStep from the shared diagnostics module", () => {
    assert.match(
      src,
      /import \{ newCorrelationId, timedStep \} from "@\/lib\/observability\/server-fn-diagnostics"/,
    );
  });

  test("generates one correlation id per request, shared across every step", () => {
    const handlerStart = code.indexOf("export const getCalendarDayView");
    const handlerEnd = code.indexOf("\nconst setWeeklyHoursInputSchema");
    const handlerBody = code.slice(handlerStart, handlerEnd);
    assert.match(handlerBody, /const correlationId = newCorrelationId\(\);/);
    const correlationUsages = (handlerBody.match(/correlationId/g) ?? []).length;
    assert.ok(
      correlationUsages >= 6,
      "expected the one correlationId to be threaded through every timedStep call",
    );
  });

  test("every database-touching step (org context, business, schedule/sync fetch, bookings/external) is wrapped in timedStep with a distinct operation name", () => {
    const handlerStart = code.indexOf("export const getCalendarDayView");
    const handlerEnd = code.indexOf("\nconst setWeeklyHoursInputSchema");
    const handlerBody = code.slice(handlerStart, handlerEnd);
    for (const operation of [
      "resolve_org_context",
      "resolve_business",
      "fetch_schedule_and_sync_state",
      "compute_day_bounds",
      "fetch_bookings_and_external_busy",
      "resolve_effective_open_ranges",
    ]) {
      assert.match(
        handlerBody,
        new RegExp(`timedStep\\(\\s*"${operation}"`),
        `expected a timedStep("${operation}", ...) call`,
      );
    }
  });

  test("resolveOrgContext checks the Supabase error field before falling back to 'No workspace found' — a real query failure must never be misreported as 'no workspace'", () => {
    const fnStart = code.indexOf("async function resolveOrgContext(");
    const fnEnd = code.indexOf("\nfunction requireWriteRole", fnStart);
    const fnBody = code.slice(fnStart, fnEnd);
    assert.match(fnBody, /const \{ data: membership, error \} = await supabase/);
    assert.match(fnBody, /if \(error\) throw error;/);
  });
});
