import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "payment-feature-section.tsx"),
  "utf8",
);
// Actual code only — strips the file's own doc comment, which legitimately
// explains why this section describes capability rather than usage.
const code = src.replace(/\/\*\*[\s\S]*?\*\//, "");

describe("PaymentFeatureSection describes the payment workflow without claiming usage stats", () => {
  test("walks through the real payment-confirmation workflow, ending on verified confirmation not a client-side claim", () => {
    assert.match(code, /Razorpay confirms the payment/);
    assert.match(code, /AI receives the payment event in real time/);
  });

  test("contains no fabricated usage/volume claim (this is a capability description, not a stats section)", () => {
    assert.doesNotMatch(code, /\d[\d,]*\+?\s*(payments|transactions|customers|businesses)/i);
    assert.doesNotMatch(code, /\d+(\.\d+)?%/);
  });
});
