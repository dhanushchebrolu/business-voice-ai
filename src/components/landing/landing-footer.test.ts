import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "landing-footer.tsx"),
  "utf8",
);
// Actual code only — strips the file's own doc comment, which legitimately
// discusses (in prose) the very things these assertions check are absent
// from the real markup below it.
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("LandingFooter has no invented social/company links, no fake form, real contact info, and only real destinations", () => {
  test("does not link to any social platform (none are real/verified for this app)", () => {
    for (const platform of [
      "twitter.com",
      "x.com/",
      "facebook.com",
      "instagram.com",
      "linkedin.com",
      "youtube.com",
      "github.com/clickai",
    ]) {
      assert.equal(src.toLowerCase().includes(platform), false, `must not link to ${platform}`);
    }
  });

  test("has no email-subscribe input pretending to submit somewhere real (no backend for it exists)", () => {
    assert.doesNotMatch(code, /type="email"/);
    assert.doesNotMatch(code, /Subscribe/i);
  });

  test("the primary footer action is a real link to /contact, not a fake form", () => {
    assert.match(code, /to="\/contact"[\s\S]{0,200}Get in touch/);
  });

  test("every real-route footer link points to a page that actually exists in this build", () => {
    for (const to of [
      "/pricing",
      "/contact",
      "/auth",
      "/about",
      "/privacy-policy",
      "/terms",
      "/acceptable-use-policy",
      "/messaging-policy",
      "/cookie-policy",
      "/refund-cancellation-policy",
      "/ai-disclaimer",
    ]) {
      assert.match(
        src,
        new RegExp(`to:\\s*"${to.replace(/\//g, "\\/")}"|to="${to.replace(/\//g, "\\/")}"`),
      );
    }
  });

  test("every section-scroll link targets a real homepage section id", () => {
    for (const id of [
      "voice-demo",
      "ai-sales-executive",
      "ai-receptionist",
      "ai-customer-care",
      "integrations",
      "ai-order-booking",
      "value-propositions",
      "industries",
    ]) {
      assert.match(src, new RegExp(`targetId:\\s*"${id}"`));
    }
  });

  test("cross-page section links navigate home with a hash instead of silently no-oping off the homepage", () => {
    assert.match(code, /Link to="\/" hash=\{targetId\}/);
  });

  test("the Legal column links to all seven required compliance pages", () => {
    const legalBlock = code.slice(code.indexOf("LEGAL_LINKS"), code.indexOf("LEGAL_LINKS") + 800);
    for (const label of [
      "Privacy Policy",
      "Terms & Conditions",
      "Acceptable Use Policy",
      "Messaging Policy",
      "Cookie Policy",
      "Refund & Cancellation Policy",
      "AI Disclaimer",
    ]) {
      assert.match(legalBlock, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  test("shows the correct legal entity from the Certificate of Incorporation, not the earlier incorrect name", () => {
    assert.match(code, /CLICKAI_LEGAL_NAME/);
    assert.doesNotMatch(src, /ClickAI Private Limited/);
    assert.doesNotMatch(src, /Click AI Private Limited/i);
  });

  test("shows the confirmed contact details", () => {
    assert.match(code, /mailto:hello@clickai\.in/);
    assert.match(code, /tel:\+917660001231/);
    assert.match(code, /\+91 76600 01231/);
  });

  test("copyright year is computed, not a hardcoded past/future year", () => {
    assert.match(code, /new Date\(\)\.getFullYear\(\)/);
  });

  test("shows the confirmed registered address, not an invented or old one", () => {
    assert.match(code, /CLICKAI_ADDRESS_LINES/);
    assert.doesNotMatch(src, /rajahmundry/i);
  });

  test("the trust row names no fake certifications (SOC 2, ISO 27001, GDPR certified, etc.)", () => {
    for (const fake of ["SOC 2", "SOC2", "ISO 27001", "ISO27001", "GDPR Certified", "HIPAA"]) {
      assert.equal(src.includes(fake), false, `must not claim "${fake}"`);
    }
  });

  test("no dead href/onClick placeholders", () => {
    assert.doesNotMatch(src, /href="#"/);
    assert.doesNotMatch(src, /onClick=\{\(\) => \{\}\}/);
  });
});
