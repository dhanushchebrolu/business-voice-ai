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

  test("fetch_bookings is scoped by business_id, not calendar_connection_id, and runs unconditionally — a business with no Google Calendar connection must still see its own booked slots as booked, not as open", () => {
    const fnStart = code.indexOf('timedStep("fetch_bookings"');
    const fnEnd = code.indexOf("}),", fnStart);
    const fnBody = code.slice(fnStart, fnEnd);
    assert.match(fnBody, /\.eq\("business_id", data\.businessId\)/);
    assert.doesNotMatch(fnBody, /calendar_connection_id/);
    // Must not be gated behind `if (connection)` — the booking fetch itself
    // sits in a Promise.all with no such guard around it, unlike the
    // external-calendar-events fetch right after it (which legitimately
    // stays connection-gated, since it has no meaning without one).
    const guardIdx = code.lastIndexOf("if (connection)", fnStart);
    const promiseAllIdx = code.lastIndexOf("Promise.all([", fnStart);
    assert.ok(
      guardIdx === -1 || guardIdx < promiseAllIdx,
      "fetch_bookings must not be nested inside an `if (connection)` block",
    );
  });

  test("fetch_calendar_sync_conflicts is gated behind `connection ?` — a business with no Google Calendar connection can never have any conflict rows (calendar_sync_conflicts.calendar_connection_id is NOT NULL with a foreign key to google_calendar_connections), so this must not run unconditionally, and must not be in the FIRST Promise.all (before connectionRes is even known)", () => {
    const stepIdx = code.indexOf('timedStep("fetch_calendar_sync_conflicts"');
    assert.ok(stepIdx > -1, "expected a fetch_calendar_sync_conflicts step to still exist");
    const guardIdx = code.lastIndexOf("connection\n        ? timedStep(", stepIdx);
    assert.ok(
      guardIdx > -1 && guardIdx < stepIdx && stepIdx - guardIdx < 200,
      "fetch_calendar_sync_conflicts must be the ternary branch taken only when `connection` is truthy",
    );
    // Must be in the SECOND Promise.all (alongside fetch_bookings/
    // fetch_external_calendar_events, which already runs after
    // connectionRes resolves), never the first one (business_hours/
    // business_hour_overrides/google_calendar_connection), which runs
    // before connectionRes exists at all — fetching it there was the
    // actual production bug ("Could not load this — step
    // 'fetch_calendar_sync_conflicts' failed ... PGRST205"): it made a
    // business with no Google Calendar connection fail its entire day
    // view on a query that can only ever return rows if a connection
    // exists in the first place.
    const firstPromiseAllIdx = code.indexOf("Promise.all([");
    const firstPromiseAllEnd = code.indexOf("]);", firstPromiseAllIdx);
    assert.ok(
      stepIdx > firstPromiseAllEnd,
      "fetch_calendar_sync_conflicts must not be inside the first Promise.all",
    );
  });

  test("a disconnected business (no google_calendar_connections row) never fails getCalendarDayView on fetch_calendar_sync_conflicts — that step is skipped entirely, not merely caught", () => {
    const stepStart = code.indexOf('timedStep("fetch_calendar_sync_conflicts"');
    const elseIdx = code.indexOf(": Promise.resolve({", stepStart);
    const elseBlockEnd = code.indexOf("}),", elseIdx);
    const elseBlock = code.slice(elseIdx, elseBlockEnd);
    assert.match(
      elseBlock,
      /data: \[\]/,
      'the no-connection branch must resolve synchronously to an empty list, never call .from("calendar_sync_conflicts") at all',
    );
  });

  test("fetch_google_calendar_connection treats PGRST205 (table not in schema cache) as 'no connection', never as a fatal failure — Google Calendar is an optional, historical integration whose own table may genuinely not be provisioned on a given deployment", () => {
    const stepStart = code.indexOf('timedStep("fetch_google_calendar_connection"');
    const stepEnd = code.indexOf("\n      }),", stepStart);
    const stepBody = code.slice(stepStart, stepEnd);
    assert.match(
      stepBody,
      /if \(res\.error\.code === "PGRST205"\)/,
      "must check the specific PGRST205 code, not react to res.error being truthy in general",
    );
    const pgrst205Idx = stepBody.indexOf('res.error.code === "PGRST205"');
    const pgrst205Block = stepBody.slice(pgrst205Idx, pgrst205Idx + 400);
    assert.match(
      pgrst205Block,
      /return \{ data: null, error: null \};/,
      "PGRST205 must fall back to the same shape a legitimate 'no connection row' .maybeSingle() result has",
    );
  });

  test("fetch_google_calendar_connection still throws every OTHER error unchanged — the PGRST205 carve-out must not widen into 'any error here means disconnected'", () => {
    const stepStart = code.indexOf('timedStep("fetch_google_calendar_connection"');
    const stepEnd = code.indexOf("\n      }),", stepStart);
    const stepBody = code.slice(stepStart, stepEnd);
    const pgrst205Idx = stepBody.indexOf('res.error.code === "PGRST205"');
    const afterCarveOut = stepBody.slice(pgrst205Idx);
    assert.match(
      afterCarveOut,
      /\n\s*}\n\s*throw res\.error;/,
      "a non-PGRST205 error must still reach `throw res.error;` after the PGRST205 branch returns early",
    );
  });

  test("the PGRST205 carve-out logs a warning server-side (never silent) so a genuinely missing table stays diagnosable, distinct from a real 'no connection configured' business", () => {
    const stepStart = code.indexOf('timedStep("fetch_google_calendar_connection"');
    const stepEnd = code.indexOf("\n      }),", stepStart);
    const stepBody = code.slice(stepStart, stepEnd);
    assert.match(stepBody, /console\.warn\(`\$\{LOG\}:google_calendar_connections_unavailable`/);
  });

  test("fetch_business_hour_overrides treats PGRST205 differently from fetch_google_calendar_connection — it must NOT silently pretend the date has no override; it must flip overridesUnavailable and log at error level, since overrides are native functionality, not an optional Google Calendar convenience", () => {
    const stepStart = code.indexOf('timedStep("fetch_business_hour_overrides"');
    const stepEnd = code.indexOf("\n      }),", stepStart);
    const stepBody = code.slice(stepStart, stepEnd);
    assert.match(
      stepBody,
      /if \(res\.error\.code === "PGRST205"\)/,
      "must check the specific PGRST205 code, not react to res.error being truthy in general",
    );
    assert.match(
      stepBody,
      /console\.error\(`\$\{LOG\}:business_hour_overrides_table_missing`/,
      "must log at error level (more severe than the google_calendar_connections warning) since this breaks native functionality",
    );
    assert.match(
      stepBody,
      /overridesUnavailable = true;/,
      "must set the visible overridesUnavailable flag — the whole point is that the UI shows an honest warning, not a silent empty state",
    );
    const pgrst205Idx = stepBody.indexOf('res.error.code === "PGRST205"');
    const pgrst205Block = stepBody.slice(pgrst205Idx, pgrst205Idx + 500);
    assert.match(pgrst205Block, /return \{ data: null, error: null \};/);
  });

  test("fetch_business_hour_overrides still throws every OTHER error unchanged", () => {
    const stepStart = code.indexOf('timedStep("fetch_business_hour_overrides"');
    const stepEnd = code.indexOf("\n      }),", stepStart);
    const stepBody = code.slice(stepStart, stepEnd);
    const pgrst205Idx = stepBody.indexOf('res.error.code === "PGRST205"');
    const afterCarveOut = stepBody.slice(pgrst205Idx);
    assert.match(
      afterCarveOut,
      /\n\s*}\n\s*throw res\.error;/,
      "a non-PGRST205 error must still reach `throw res.error;` after the PGRST205 branch returns early",
    );
  });

  test("overridesUnavailable is declared before the first Promise.all (readable regardless of which branch runs) and returned from getCalendarDayView", () => {
    const handlerStart = code.indexOf("export const getCalendarDayView");
    const firstPromiseAllIdx = code.indexOf("Promise.all([", handlerStart);
    const declIdx = code.indexOf("let overridesUnavailable = false;", handlerStart);
    assert.ok(
      declIdx > -1 && declIdx < firstPromiseAllIdx,
      "overridesUnavailable must be declared before the first Promise.all, not inside it",
    );
    const returnIdx = code.indexOf("return {\n      role,", handlerStart);
    assert.ok(returnIdx > -1, "expected to find getCalendarDayView's final return object");
    const returnEnd = code.indexOf("\n    };", returnIdx);
    assert.match(code.slice(returnIdx, returnEnd), /overridesUnavailable,/);
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

  test("every database-touching step has its OWN timedStep with a distinct, per-table operation name — never one combined step covering several tables", () => {
    // A combined step (the original design) can only say "something in
    // this batch failed," which is exactly what made a live PGRST205
    // report ambiguous between 4 different tables. One step per table
    // means the operation name alone identifies the relation.
    const handlerStart = code.indexOf("export const getCalendarDayView");
    const handlerEnd = code.indexOf("\nconst setWeeklyHoursInputSchema");
    const handlerBody = code.slice(handlerStart, handlerEnd);
    for (const operation of [
      "resolve_org_context",
      "resolve_business",
      "fetch_business_hours",
      "fetch_business_hour_overrides",
      "fetch_google_calendar_connection",
      "fetch_calendar_sync_conflicts",
      "compute_day_bounds",
      "fetch_bookings",
      "fetch_external_calendar_events",
      "resolve_effective_open_ranges",
    ]) {
      assert.match(
        handlerBody,
        new RegExp(`timedStep\\(\\s*"${operation}"|timedStep\\("${operation}",`),
        `expected a timedStep("${operation}", ...) call`,
      );
    }
    assert.doesNotMatch(handlerBody, /timedStep\(\s*"fetch_schedule_and_sync_state"/);
    assert.doesNotMatch(handlerBody, /timedStep\(\s*"fetch_bookings_and_external_busy"/);
  });

  test("the three schedule-state queries run in parallel (one Promise.all of three timedSteps), not sequentially — calendar_sync_conflicts is deliberately NOT one of them (see its own connection-gated test above)", () => {
    const handlerStart = code.indexOf("export const getCalendarDayView");
    const promiseAllIdx = code.indexOf("Promise.all([", handlerStart);
    const promiseAllEnd = code.indexOf("]);", promiseAllIdx);
    const block = code.slice(promiseAllIdx, promiseAllEnd);
    assert.match(block, /timedStep\("fetch_business_hours"/);
    assert.match(block, /timedStep\("fetch_business_hour_overrides"/);
    assert.match(block, /timedStep\("fetch_google_calendar_connection"/);
    assert.doesNotMatch(block, /timedStep\("fetch_calendar_sync_conflicts"/);
  });

  test("resolveOrgContext checks the Supabase error field before falling back to 'No workspace found' — a real query failure must never be misreported as 'no workspace'", () => {
    const fnStart = code.indexOf("async function resolveOrgContext(");
    const fnEnd = code.indexOf("\nfunction requireWriteRole", fnStart);
    const fnBody = code.slice(fnStart, fnEnd);
    assert.match(fnBody, /const \{ data: membership, error \} = await supabase/);
    assert.match(fnBody, /if \(error\) throw error;/);
  });
});

describe("business-hours interval validation wiring", () => {
  test("setWeeklyHours validates intervals before calling the RPC, only when the day is not closed", () => {
    const fnStart = code.indexOf("export const setWeeklyHours");
    const fnEnd = code.indexOf("export const applyDailyOverride");
    const fnBody = code.slice(fnStart, fnEnd);
    const guardIdx = fnBody.indexOf("if (!data.isClosed)");
    const validateIdx = fnBody.indexOf("describeInvalidIntervals(data.intervals)");
    const rpcIdx = fnBody.indexOf('supabaseAdmin.rpc("set_business_weekly_hours"');
    assert.ok(guardIdx > -1 && validateIdx > -1 && rpcIdx > -1);
    assert.ok(
      guardIdx < validateIdx && validateIdx < rpcIdx,
      "validation must run inside the !isClosed guard, before the RPC call",
    );
    assert.match(fnBody, /if \(validationError\) throw new Error\(validationError\);/);
  });

  test("setWeeklyHours translates a trigger rejection into a friendly message instead of the raw Postgres error", () => {
    const fnStart = code.indexOf("export const setWeeklyHours");
    const fnEnd = code.indexOf("export const applyDailyOverride");
    const fnBody = code.slice(fnStart, fnEnd);
    assert.match(fnBody, /describeBusinessHoursWriteError\(error\)/);
  });

  test("applyDailyOverride validates override intervals before calling the RPC, only when not a full-day closure", () => {
    const fnStart = code.indexOf("export const applyDailyOverride");
    const fnEnd = code.indexOf("const resolveConflictInputSchema");
    const fnBody = code.slice(fnStart, fnEnd);
    const guardIdx = fnBody.indexOf("if (!data.isFullDayClosure)");
    const validateIdx = fnBody.indexOf("describeInvalidOverrideIntervals(data.intervals)");
    const rpcIdx = fnBody.indexOf('supabaseAdmin.rpc("apply_business_schedule_override"');
    assert.ok(guardIdx > -1 && validateIdx > -1 && rpcIdx > -1);
    assert.ok(guardIdx < validateIdx && validateIdx < rpcIdx);
  });

  test("applyDailyOverride still maps CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING before falling back to describeBusinessHoursWriteError", () => {
    const fnStart = code.indexOf("export const applyDailyOverride");
    const fnEnd = code.indexOf("const resolveConflictInputSchema");
    const fnBody = code.slice(fnStart, fnEnd);
    const activeBookingIdx = fnBody.indexOf("CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING");
    const translateIdx = fnBody.indexOf("describeBusinessHoursWriteError(error)");
    assert.ok(activeBookingIdx > -1 && translateIdx > -1 && activeBookingIdx < translateIdx);
  });

  test("getCalendarDayView computes scheduleConfigWarning via selectScheduleConfigWarning, scoped to this date's weekday and override, and returns it", () => {
    const fnStart = code.indexOf("export const getCalendarDayView");
    const fnEnd = code.indexOf("const setWeeklyHoursInputSchema");
    const fnBody = code.slice(fnStart, fnEnd);
    assert.match(
      fnBody,
      /selectScheduleConfigWarning\(\s*weeklyHours\.find\(\(d\) => d\.dayOfWeek === dayOfWeek\),\s*override,\s*data\.dateIso,\s*\)/,
    );
    assert.match(fnBody, /scheduleConfigWarning,/);
  });
});
