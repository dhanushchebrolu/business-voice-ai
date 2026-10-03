import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkCallTransition,
  maskPhoneNumber,
  TERMINAL_CALL_STATUSES,
} from "./telephony-guard.server.ts";

test("maskPhoneNumber: keeps only the last 4 digits, masking the rest", () => {
  assert.equal(maskPhoneNumber("+919876543210"), "********3210");
});

test("maskPhoneNumber: handles a null/undefined/empty input without throwing", () => {
  assert.equal(maskPhoneNumber(null), "(none)");
  assert.equal(maskPhoneNumber(undefined), "(none)");
  assert.equal(maskPhoneNumber(""), "(none)");
});

test("maskPhoneNumber: a short numeric string masks fully rather than exposing every digit", () => {
  assert.equal(maskPhoneNumber("123"), "***");
});

test("checkCallTransition: same-state event is a no-op, not an error", () => {
  const r = checkCallTransition("in_progress", "in_progress");
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
});

test("checkCallTransition: normal forward progression is allowed", () => {
  assert.equal(checkCallTransition("initiated", "ringing").ok, true);
  assert.equal(checkCallTransition("ringing", "answered").ok, true);
  assert.equal(checkCallTransition("answered", "in_progress").ok, true);
  assert.equal(checkCallTransition("in_progress", "completed").ok, true);
});

test("checkCallTransition: rejects completed -> in_progress", () => {
  const r = checkCallTransition("completed", "in_progress");
  assert.equal(r.ok, false);
  assert.ok(r.reason?.includes("completed -> in_progress"));
});

test("checkCallTransition: rejects failed -> answered", () => {
  const r = checkCallTransition("failed", "answered");
  assert.equal(r.ok, false);
});

test("checkCallTransition: every terminal status has no outgoing transitions", () => {
  for (const status of TERMINAL_CALL_STATUSES) {
    const r = checkCallTransition(status, "answered");
    assert.equal(r.ok, false, `${status} -> answered should be rejected`);
  }
});
