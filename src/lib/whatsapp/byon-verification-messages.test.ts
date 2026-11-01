import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BYON_ELIGIBILITY_NOTES, byonRequestMessages } from "./byon-verification-messages.ts";

// An affirmative claim of sending/delivery ("whether a code was sent" is not one).
const NEVER_CLAIMED =
  /(?<!whether a )code (was |has been )?(sent|delivered)|otp sent|sent to \+|should reach|delivered to/i;

describe("BYON verification wording", () => {
  test("an accepted (pending) request says accepted, and that delivery is not confirmed", () => {
    const m = byonRequestMessages({
      phoneNumber: "+919876543210",
      state: "verification_requested",
      expiresAt: null,
    });
    assert.equal(m.tone, "success");
    assert.equal(m.toast, "Verification request accepted. Delivery has not been confirmed.");
    assert.match(m.panel, /Vobiz accepted the verification request/);
    assert.match(m.panel, /Delivery has not been confirmed/);
    assert.doesNotMatch(`${m.toast} ${m.panel}`, NEVER_CLAIMED);
  });

  test("the expiry Vobiz returned is mentioned without implying a code arrived", () => {
    const m = byonRequestMessages({
      phoneNumber: "+919876543210",
      state: "verification_requested",
      expiresAt: "2026-10-28T10:00:00.000Z",
    });
    assert.match(m.panel, /If a code arrives, it expires at/);
    assert.doesNotMatch(m.panel, NEVER_CLAIMED);
  });

  test("an unrecognized answer is a warning that says the outcome is unknown", () => {
    const m = byonRequestMessages({
      phoneNumber: "+919876543210",
      state: "verification_unconfirmed",
      expiresAt: null,
    });
    assert.equal(m.tone, "warning");
    assert.match(m.panel, /isn't known whether a code was sent/);
    assert.doesNotMatch(m.toast, /accepted\. Delivery/);
    assert.doesNotMatch(`${m.toast} ${m.panel}`, NEVER_CLAIMED);
  });

  test("eligibility notes state Vobiz's rule and that ClickAI never unregisters an account", () => {
    const text = BYON_ELIGIBILITY_NOTES.join(" ");
    assert.match(text, /can't stay registered in the WhatsApp or WhatsApp Business app/);
    assert.match(text, /one provider only/);
    assert.match(text, /ClickAI never unregisters or deletes an existing WhatsApp account/);
  });
});
