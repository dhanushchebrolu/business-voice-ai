import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hub-graphic.tsx"), "utf8");

describe("HubGraphic is decorative and shows only real, live ClickAI channels", () => {
  test("the whole graphic is aria-hidden, never masquerading as an interactive control", () => {
    assert.match(src, /aria-hidden="true"/);
  });

  test("respects prefers-reduced-motion via the existing shared hook, not a re-derived check", () => {
    assert.match(src, /from "@\/hooks\/usePrefersReducedMotion"/);
    assert.match(src, /usePrefersReducedMotion\(\)/);
  });

  test("shows WhatsApp, Instagram and Razorpay by name, per the product brief", () => {
    assert.match(src, /label: "WhatsApp"/);
    assert.match(src, /label: "Instagram"/);
    assert.match(src, /label: "Razorpay"/);
  });

  test("does not include any integration still marked Coming soon on the Integrations section", () => {
    for (const notYetLive of ["Shopify", "WooCommerce", "SMS", "Email"]) {
      assert.equal(src.includes(`label: "${notYetLive}"`), false, `${notYetLive} is not live yet`);
    }
  });

  test("center node shows the ClickAI brand", () => {
    assert.match(src, />\s*ClickAI\s*</);
  });
});
