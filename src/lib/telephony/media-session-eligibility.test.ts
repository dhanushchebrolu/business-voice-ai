import { test } from "node:test";
import assert from "node:assert/strict";
import { isEligibleForMediaSession } from "./media-session-eligibility.ts";

test("a call still in 'initiated' status is eligible for a media session (the Exotel WS-connects-before-webhook-lands race)", () => {
  assert.equal(isEligibleForMediaSession("initiated"), true);
});

test("'answered' and 'in_progress' remain eligible, unchanged from before this fix", () => {
  assert.equal(isEligibleForMediaSession("answered"), true);
  assert.equal(isEligibleForMediaSession("in_progress"), true);
});

test("terminal statuses are never eligible — a call that already ended or was refused cannot reopen a media session", () => {
  for (const status of ["completed", "failed", "busy", "no_answer", "cancelled"]) {
    assert.equal(isEligibleForMediaSession(status), false, `expected "${status}" to be ineligible`);
  }
});

test("'ringing' is not eligible — only the traced 'initiated' race is being fixed here, not widened beyond it", () => {
  assert.equal(isEligibleForMediaSession("ringing"), false);
});

test("an unrecognized/garbage status string fails closed, never throws", () => {
  assert.equal(isEligibleForMediaSession("some-unexpected-value"), false);
  assert.equal(isEligibleForMediaSession(""), false);
});
