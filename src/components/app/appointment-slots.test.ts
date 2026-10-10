import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scanned like every other route/component in this codebase (see
 * app.business.test.ts, app.knowledge.test.ts) — no DOM-rendering harness
 * exists here.
 *
 * This component used to be the "Day view" half of a standalone
 * /app/calendar page (app.calendar.tsx, now removed) — the weekly-hours
 * half stayed where it already lived, in app.business.tsx's Hours tab,
 * since the task that split this out explicitly required reusing the
 * existing weekly editor rather than duplicating it. Keeping both the day
 * view AND a second weekly-hours editor here would have recreated the
 * exact duplicate-availability-UI problem that split was meant to avoid.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "appointment-slots.tsx"),
  "utf8",
);

describe("AppointmentSlotsSection — never a duplicate weekly-hours editor", () => {
  test("has no WeeklyHoursRow or weekly-hours save path of its own — that stays exclusively in app.business.tsx", () => {
    assert.doesNotMatch(src, /WeeklyHoursRow/);
    assert.doesNotMatch(src, /setWeeklyHours/);
  });

  test("is titled 'Appointment Slots' with the specified description, mounted via SectionCard", () => {
    assert.match(src, /title="Appointment Slots"/);
    assert.match(
      src,
      /description="Manage the exact appointment times customers can book through your AI receptionist\."/,
    );
  });
});

describe("AppointmentSlotsSection — the day-view query's error state is distinguished from its loading state", () => {
  test("destructures isError/error/refetch from the day-view query", () => {
    assert.match(
      src,
      /isError: viewIsError,\s*\n\s*error: viewError,\s*\n\s*refetch: refetchView,/,
    );
  });

  test("viewIsError is checked before the old '!view' fallback, so an error never reads as 'still loading'", () => {
    const sectionIdx = src.indexOf("{isLoading ? (");
    assert.ok(sectionIdx > -1);
    const block = src.slice(sectionIdx, sectionIdx + 600);
    const isLoadingIdx = block.indexOf("isLoading ? (");
    const isErrorIdx = block.indexOf("viewIsError ? (");
    const fallbackIdx = block.indexOf("!view ? (");
    assert.ok(isLoadingIdx > -1 && isErrorIdx > -1 && fallbackIdx > -1);
    assert.ok(isLoadingIdx < isErrorIdx && isErrorIdx < fallbackIdx);
    assert.match(block.slice(isErrorIdx, fallbackIdx), /<ErrorState/);
  });
});

describe("AppointmentSlotsSection — slot grid and overrides reuse the one precedence resolver via getCalendarDayView, never a second client-side notion of 'open'", () => {
  test("renders a slot's state from view.slots (getCalendarDayView's own response), not a locally recomputed decision", () => {
    assert.match(src, /view\.slots\.map\(\(slot\) =>/);
    assert.match(src, /const state = slot\.state as SlotState;/);
  });

  test("a booked or externally-busy slot can never be toggled, even for a writer role", () => {
    const toggleStart = src.indexOf("async function toggleSlot(");
    const toggleBody = src.slice(toggleStart, toggleStart + 300);
    assert.match(
      toggleBody,
      /if \(currentState === "booked" \|\| currentState === "externally_busy"\) return;/,
    );
  });

  test("an empty slot list (closed date, no override) renders an explanatory empty state, not a blank grid", () => {
    assert.match(src, /view\.slots\.length === 0/);
  });
});

describe("AppointmentSlotsSection — overridesUnavailable renders a visible, honest warning, never a silent empty state", () => {
  test("renders a banner when view.overridesUnavailable is true", () => {
    assert.match(src, /view\.overridesUnavailable \? \(/);
  });

  test("the warning banner is placed near scheduleConfigWarning's own banner, using the same destructive styling convention", () => {
    const scheduleWarningIdx = src.indexOf("view.scheduleConfigWarning ?");
    const overridesWarningIdx = src.indexOf("view.overridesUnavailable ?");
    assert.ok(scheduleWarningIdx > -1 && overridesWarningIdx > -1);
    assert.ok(
      overridesWarningIdx > scheduleWarningIdx,
      "overridesUnavailable banner should render after scheduleConfigWarning's, matching this section's existing top-to-bottom warning order",
    );
    const block = src.slice(overridesWarningIdx, overridesWarningIdx + 500);
    assert.match(block, /border-destructive\/30 bg-destructive\/8 .*text-destructive/s);
  });

  test("the banner tells the owner overrides cannot be loaded or saved, never claims the date simply has no override", () => {
    const overridesWarningIdx = src.indexOf("view.overridesUnavailable ?");
    const block = src.slice(overridesWarningIdx, overridesWarningIdx + 600);
    assert.match(block, /could not be loaded/i);
    assert.match(block, /cannot be saved/i);
  });
});
