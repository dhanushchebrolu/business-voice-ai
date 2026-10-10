import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scanned like every other route in this codebase (see
 * app.calendar.test.ts, app.knowledge.test.ts) — no DOM-rendering harness
 * exists here. Covers the legacy "Opening hours" editor's business-hours
 * validation guard — this component writes business_hours directly via
 * the browser Supabase client (no server function, no RPC), so the
 * client-side check here is the only defense-in-depth layer before the
 * database trigger (20261010100000_business_hours_interval_validation.sql)
 * itself rejects a malformed/reversed write.
 *
 * The HoursRow component buffers both start/end fields locally and
 * commits once on blur of the pair, rather than writing on every
 * keystroke of either field independently — see its own doc comment for
 * why: the previous per-field-submits-immediately behavior meant a
 * legacy-invalid stored interval (production has rows shaped exactly
 * {"start":"23:59","end":"00:00"}) could never be corrected through this
 * editor at all, since editing either field alone always re-submits it
 * against the other field's still-invalid stored value.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.business.tsx"), "utf8");

describe("app.business.tsx — Opening hours editor validates before writing directly to business_hours", () => {
  test("imports the shared business-hours validator", () => {
    assert.match(src, /from "@\/lib\/calendar\/business-hours-validation"/);
  });

  test("reopening a day never re-persists an already-invalid stored interval — it falls back to a known-good default", () => {
    const fnStart = src.indexOf("async function toggleDay(");
    const fnEnd = src.indexOf("\n  async function saveInterval(");
    const fnBody = src.slice(fnStart, fnEnd);
    assert.match(
      fnBody,
      /const safeInterval =\s*\n?\s*stored && !describeInvalidInterval\(stored\) \? stored : DEFAULT_HOURS_INTERVAL;/,
    );
  });

  test("saveInterval validates the full {start,end} pair before writing, and surfaces a translated trigger rejection", () => {
    const fnStart = src.indexOf("async function saveInterval(");
    const fnEnd = src.indexOf("\n  return (");
    const fnBody = src.slice(fnStart, fnEnd);
    assert.match(fnBody, /describeInvalidInterval\(interval\)/);
    assert.match(fnBody, /describeBusinessHoursWriteError\(error\)/);
  });

  test("HoursRow buffers both start/end fields in local state and commits once, not on every keystroke", () => {
    const compStart = src.indexOf("function HoursRow(");
    const compEnd = src.length;
    const compBody = src.slice(compStart, compEnd);
    assert.match(compBody, /const \[draft, setDraft\] = useState/);
    // Each <Input>'s own onChange must only update local draft state —
    // never call onSaveInterval directly — or the exact bug this fixes
    // (one field's edit immediately re-submitting the other field's
    // still-invalid stored value) would still be present.
    const inputsBlock = compBody.slice(
      compBody.indexOf('<div className="flex items-center gap-2"'),
    );
    assert.doesNotMatch(inputsBlock, /onChange=\{\(e\) => onSaveInterval/);
    assert.match(inputsBlock, /onChange=\{\(e\) => setDraft/g);
  });

  test("the two time inputs commit together on blur of the pair (not of either input individually)", () => {
    const compStart = src.indexOf("function HoursRow(");
    const compBody = src.slice(compStart);
    assert.match(compBody, /function handleGroupBlur/);
    assert.match(compBody, /onBlur=\{handleGroupBlur\}/);
    // Tabbing between the two sibling inputs inside the same group must
    // not count as "done editing" — only a true focus-leaves-the-pair
    // blur should commit.
    assert.match(
      compBody,
      /e\.relatedTarget instanceof Node && e\.currentTarget\.contains\(e\.relatedTarget\)/,
    );
  });

  test("an unchanged draft (re-blurring without editing) does not trigger a redundant write", () => {
    const compStart = src.indexOf("function HoursRow(");
    const compBody = src.slice(compStart);
    const commitFnStart = compBody.indexOf("function commit(");
    const commitFnBody = compBody.slice(commitFnStart, commitFnStart + 200);
    assert.match(commitFnBody, /draft\.start === stored\.start && draft\.end === stored\.end/);
  });

  test("a rejected write (e.g. from the database trigger) is surfaced via toast, not silently ignored", () => {
    assert.match(src, /describeBusinessHoursWriteError\(error\)/);
  });
});

describe("app.business.tsx — HoursRow has save-in-flight protection (last-writer-wins race fix)", () => {
  test("BusinessPage tracks a per-day savingDay state and threads it into HoursRow as `disabled`", () => {
    assert.match(src, /const \[savingDay, setSavingDay\] = useState<number \| null>\(null\);/);
    const callSiteIdx = src.indexOf("<HoursRow");
    const callSiteBody = src.slice(callSiteIdx, callSiteIdx + 300);
    assert.match(callSiteBody, /disabled=\{savingDay === i\}/);
  });

  test("toggleDay and saveInterval both set/clear savingDay around their async write in a try/finally, and bail out if another save is already in flight", () => {
    const toggleStart = src.indexOf("async function toggleDay(");
    const toggleEnd = src.indexOf("\n  async function saveInterval(");
    const toggleBody = src.slice(toggleStart, toggleEnd);
    assert.match(toggleBody, /if \(savingDay !== null\) return;/);
    assert.match(toggleBody, /setSavingDay\(dayIndex\);/);
    assert.match(toggleBody, /finally \{\s*\n\s*setSavingDay\(null\);/);

    const saveStart = src.indexOf("async function saveInterval(");
    const saveEnd = src.indexOf("\n  return (", saveStart);
    const saveBody = src.slice(saveStart, saveEnd);
    assert.match(saveBody, /if \(savingDay !== null\) return;/);
    assert.match(saveBody, /setSavingDay\(dayIndex\);/);
    assert.match(saveBody, /finally \{\s*\n\s*setSavingDay\(null\);/);
  });

  test("HoursRow applies `disabled` to the Switch and both time inputs, so no further edit or toggle can be initiated mid-save", () => {
    const compStart = src.indexOf("function HoursRow(");
    const compBody = src.slice(compStart);
    assert.match(compBody, /<Switch checked=\{!row\?\.is_closed\} disabled=\{disabled\}/);
    const inputsBlock = compBody.slice(
      compBody.indexOf('<div className="flex items-center gap-2"'),
    );
    const disabledInputCount = (inputsBlock.match(/disabled=\{disabled\}/g) ?? []).length;
    assert.equal(disabledInputCount, 2, "both the start and end inputs must be disabled mid-save");
  });

  test("a failed write still clears savingDay (via finally), so the row is not left permanently disabled", () => {
    const toggleStart = src.indexOf("async function toggleDay(");
    const toggleEnd = src.indexOf("\n  async function saveInterval(");
    const toggleBody = src.slice(toggleStart, toggleEnd);
    const tryIdx = toggleBody.indexOf("try {");
    const finallyIdx = toggleBody.indexOf("finally {");
    assert.ok(
      tryIdx > -1 && finallyIdx > tryIdx,
      "the write must be inside try, with setSavingDay(null) in finally so an error still releases the lock",
    );
  });
});
