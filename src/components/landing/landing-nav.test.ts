import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Functionality-requirements coverage for the landing-page nav: dashboard
 * access must be delegated to the existing backend-authoritative hook (not
 * re-derived), every nav item must resolve to a real destination, the
 * three dropdowns (Products/Integrations/Industries) must be genuine
 * open/close menus (not decorative), and the single menu overlay (mobile
 * nav + auth-aware CTAs) must remain a real open/close dialog with Escape
 * handling and a body-scroll lock.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "landing-nav.tsx"), "utf8");

describe("LandingNav reuses the existing dashboard-access hook and has only real nav destinations", () => {
  test("auth-awareness is delegated to the existing useAuth + useDashboardAccess hooks, not re-derived", () => {
    assert.match(src, /from "@\/hooks\/useAuth"/);
    assert.match(src, /from "@\/components\/app\/PublicNav"/);
    assert.match(src, /useDashboardAccess\(\)/);
  });

  test("top-level bar is Products / Pricing / Integrations / Industries, plus a persistent Contact CTA", () => {
    assert.match(src, /label="Products"/);
    assert.match(src, /to="\/pricing"/);
    assert.match(src, /label="Integrations"/);
    assert.match(src, /label="Industries"/);
    assert.match(src, /to="\/contact"/);
  });

  test("Products dropdown lists all four AI employee products, each targeting a real product-card id", () => {
    for (const [label, targetId] of [
      ["AI Sales Executive", "ai-sales-executive"],
      ["AI Receptionist", "ai-receptionist"],
      ["AI Order Booking", "ai-order-booking"],
      ["AI Customer Care", "ai-customer-care"],
    ]) {
      assert.match(src, new RegExp(`label: "${label}",\\s*targetId: "${targetId}"`));
    }
  });

  test("Integrations dropdown lists WhatsApp, Instagram, Razorpay, Google Calendar, Shopify, WooCommerce, all targeting the real #integrations section", () => {
    for (const label of [
      "WhatsApp",
      "Instagram",
      "Razorpay",
      "Google Calendar",
      "Shopify",
      "WooCommerce",
    ]) {
      assert.match(src, new RegExp(`label: "${label}",\\s*targetId: "integrations"`));
    }
  });

  test("Industries dropdown is built from the shared BUSINESS_TYPES source of truth, not a separately-maintained list", () => {
    assert.match(src, /from "@\/lib\/business-types"/);
    assert.match(src, /BUSINESS_TYPES\.map/);
    assert.match(src, /targetId: "industries"/);
  });

  test("no invented /product, /solutions, /developers, or /resources routes", () => {
    for (const invented of [
      'to="/product"',
      'to="/solutions"',
      'to="/developers"',
      'to="/resources"',
    ]) {
      assert.equal(src.includes(invented), false, `must not link to invented route ${invented}`);
    }
  });

  test("dropdowns are real open/close menus: click-toggle, outside-click close, Escape close, correct ARIA", () => {
    assert.match(src, /aria-haspopup="true"/);
    assert.match(src, /aria-expanded=\{open\}/);
    assert.match(src, /setOpen\(\(v\) => !v\)/);
    assert.match(src, /mousedown/);
    assert.match(src, /e\.key === "Escape"/);
    assert.match(src, /role="menu"/);
  });

  test("the single menu overlay is a real dialog with body-scroll lock and Escape-to-close, and closes on every link/button", () => {
    assert.match(src, /role="dialog"/);
    assert.match(src, /aria-modal="true"/);
    assert.match(src, /document\.body\.style\.overflow = "hidden"/);
    assert.match(src, /e\.key === "Escape"/);
    assert.match(src, /setMenuOpen\(false\)/);
    assert.match(src, /aria-expanded=\{menuOpen\}/);
    assert.match(src, /aria-controls="landing-menu"/);
  });

  test("sign out navigates to the public home, not a stale/admin route", () => {
    assert.match(src, /await signOut\(\)/);
    assert.match(src, /navigate\(\{ to: "\/" \}\)/);
  });
});
