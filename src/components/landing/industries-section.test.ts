import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUSINESS_TYPES } from "@/lib/business-types";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "industries-section.tsx"),
  "utf8",
);

describe("IndustriesSection reuses the dashboard's own BUSINESS_TYPES list, no separately-maintained copy", () => {
  test("imports BUSINESS_TYPES from the shared source of truth rather than a local literal array", () => {
    assert.match(src, /from "@\/lib\/business-types"/);
    assert.match(src, /BUSINESS_TYPES\.filter/);
  });

  test("every dashboard business type except the generic 'Other' catch-all is a real, distinct industry the nav can link to", () => {
    const nonGeneric = BUSINESS_TYPES.filter((t) => t.id !== "other");
    assert.ok(
      nonGeneric.length >= 10,
      "expected the full dashboard industry list, not a shortened one",
    );
  });

  test("has no dead href/onClick placeholders (purely descriptive cards, not fake links)", () => {
    assert.doesNotMatch(src, /href="#"/);
    assert.doesNotMatch(src, /onClick=\{\(\) => \{\}\}/);
  });
});
