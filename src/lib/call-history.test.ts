import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  callCounterpart,
  callOutcomeLabel,
  callStatusLabel,
  callStatusTone,
  isCallOpen,
} from "./call-history.ts";

describe("customer call history", () => {
  test("shows the other party: the caller inbound, the dialled person outbound", () => {
    const clinic = "+917965860061";
    const person = "+919876543210";
    assert.equal(
      callCounterpart({
        direction: "inbound",
        status: "completed",
        caller_number: person,
        destination_number: clinic,
      }),
      person,
    );
    assert.equal(
      callCounterpart({
        direction: "outbound",
        status: "completed",
        caller_number: clinic,
        destination_number: person,
      }),
      person,
    );
    assert.equal(
      callCounterpart({
        direction: "outbound",
        status: "failed",
        caller_number: clinic,
        destination_number: null,
      }),
      "Unknown",
    );
  });

  test("every stored status has a plain label and a tone", () => {
    assert.equal(callStatusLabel("initiated"), "Calling");
    assert.equal(callStatusLabel("outcome_unknown"), "Unconfirmed");
    assert.equal(callStatusLabel("no_answer"), "No answer");
    assert.equal(callStatusLabel("something_new"), "something new");
    assert.equal(callStatusTone("completed"), "live");
    assert.equal(callStatusTone("failed"), "error");
    assert.equal(callStatusTone("outcome_unknown"), "ready");
    assert.equal(callStatusTone("initiated"), "info");
    assert.equal(callStatusTone("busy"), "idle");
  });

  test("only calls that can still change keep the page refreshing", () => {
    for (const s of ["initiated", "ringing", "answered", "in_progress"])
      assert.ok(isCallOpen(s), s);
    for (const s of ["completed", "failed", "busy", "no_answer", "cancelled", "outcome_unknown"])
      assert.ok(!isCallOpen(s), s);
  });
});

describe("call outcomes", () => {
  test("agent outcome values read as words", () => {
    assert.equal(callOutcomeLabel("callback_requested"), "Callback requested");
    assert.equal(callOutcomeLabel("booked"), "Booked");
    assert.equal(callOutcomeLabel("wrong-number"), "Wrong number");
    assert.equal(callOutcomeLabel(null), "—");
    assert.equal(callOutcomeLabel("  "), "—");
  });
});
