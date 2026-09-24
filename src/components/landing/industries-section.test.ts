import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "industries-section.tsx"),
  "utf8",
);

describe("IndustriesSection lists the eight primary industries with no dead links", () => {
  test("renders all eight primary industries", () => {
    for (const name of [
      "Restaurants & Cafés",
      "Hotels & Resorts",
      "Hospitals & Clinics",
      "Salons & Spas",
      "Retail Stores",
      "Diagnostic Centers",
      "Service Businesses",
      "E-commerce / D2C",
    ]) {
      assert.match(src, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  test("has no dead href/onClick placeholders (purely descriptive cards, not fake links)", () => {
    assert.doesNotMatch(src, /href="#"/);
    assert.doesNotMatch(src, /onClick=\{\(\) => \{\}\}/);
  });
});
