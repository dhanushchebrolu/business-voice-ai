import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  csvToTable,
  normalizeToE164,
  validateContactRows,
  applyVariableMapping,
} from "./contacts-import.ts";

describe("parseCsv", () => {
  test("parses a simple CSV", () => {
    const rows = parseCsv("name,phone\nRahul,9876543210\nPriya,9876543211\n");
    assert.deepEqual(rows, [
      ["name", "phone"],
      ["Rahul", "9876543210"],
      ["Priya", "9876543211"],
    ]);
  });

  test("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('name,note\n"Rao, Dr","He said ""hello"""\n');
    assert.deepEqual(rows, [
      ["name", "note"],
      ["Rao, Dr", 'He said "hello"'],
    ]);
  });

  test("handles a file with no trailing newline", () => {
    const rows = parseCsv("a,b\n1,2");
    assert.deepEqual(rows, [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("handles CRLF line endings", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n");
    assert.deepEqual(rows, [
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("csvToTable", () => {
  test("builds row objects keyed by header", () => {
    const table = csvToTable("name,phone\nRahul,9876543210\n");
    assert.deepEqual(table.headers, ["name", "phone"]);
    assert.deepEqual(table.rows, [{ name: "Rahul", phone: "9876543210" }]);
  });

  test("dedupes duplicate/blank headers instead of dropping data", () => {
    const table = csvToTable("name,name,\nRahul,Kumar,x\n");
    assert.deepEqual(table.headers, ["name", "name_2", "column_3"]);
  });

  test("returns empty for empty input", () => {
    assert.deepEqual(csvToTable(""), { headers: [], rows: [] });
  });
});

describe("normalizeToE164", () => {
  test("prepends +91 to a bare 10-digit Indian number", () => {
    assert.equal(normalizeToE164("9876543210"), "+919876543210");
  });

  test("strips a leading 0 on an 11-digit number", () => {
    assert.equal(normalizeToE164("09876543210"), "+919876543210");
  });

  test("accepts a 12-digit number already carrying the 91 country code", () => {
    assert.equal(normalizeToE164("919876543210"), "+919876543210");
  });

  test("passes through an already-E.164 number after stripping punctuation", () => {
    assert.equal(normalizeToE164("+91 98765 43210"), "+919876543210");
  });

  test("normalizes a non-Indian E.164 number without reinterpreting it", () => {
    assert.equal(normalizeToE164("+14155552671"), "+14155552671");
  });

  test("rejects an ambiguous bare-digit shape that isn't 10/11/12 digits", () => {
    assert.equal(normalizeToE164("12345"), null);
  });

  test("rejects empty input", () => {
    assert.equal(normalizeToE164(""), null);
    assert.equal(normalizeToE164("   "), null);
  });

  test("rejects garbage with no digits", () => {
    assert.equal(normalizeToE164("not-a-number"), null);
  });
});

describe("validateContactRows", () => {
  test("classifies valid, invalid (missing/invalid phone), and duplicate rows", () => {
    const table = csvToTable(
      "name,phone\nRahul,9876543210\nPriya,\nNoPhone,abc\nDupe,9876543210\n",
    );
    const summary = validateContactRows(table, "phone");
    assert.equal(summary.totalRows, 4);
    assert.equal(summary.valid.length, 1);
    assert.equal(summary.valid[0]?.phone, "+919876543210");
    assert.equal(summary.invalid.length, 2);
    assert.deepEqual(
      summary.invalid.map((r) => r.reason),
      ["Missing phone number", "Invalid or unrecognized phone number"],
    );
    assert.equal(summary.duplicates.length, 1);
    assert.equal(summary.duplicates[0]?.phone, "+919876543210");
  });

  test("never discards a row silently — every row lands in exactly one bucket", () => {
    const table = csvToTable("phone\n9876543210\n\nabc\n9876543210\n9876543211\n");
    const summary = validateContactRows(table, "phone");
    const total = summary.valid.length + summary.invalid.length + summary.duplicates.length;
    assert.equal(total, summary.totalRows);
  });
});

describe("applyVariableMapping", () => {
  test("maps CSV columns to agent variable names, skipping unmapped/empty columns", () => {
    const out = applyVariableMapping(
      { name: "Rahul", appointment_date: "15 Sep", doctor: "", unused: "x" },
      { name: "customer_name", appointment_date: "appointment_date", doctor: "doctor_name" },
    );
    assert.deepEqual(out, { customer_name: "Rahul", appointment_date: "15 Sep" });
  });

  test("returns an empty object for an empty mapping", () => {
    assert.deepEqual(applyVariableMapping({ a: "1" }, {}), {});
  });
});
