import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decideCampaignContactOutcome, type CampaignRetryPolicy } from "./campaign-outcome.ts";

const policy: CampaignRetryPolicy = {
  maxAttempts: 3,
  retryAfterMinutes: 120,
  retryStatuses: ["no_answer", "busy", "failed"],
};

describe("decideCampaignContactOutcome", () => {
  test("schedules a retry for a retryable status when attempts remain", () => {
    const now = new Date("2026-09-12T10:00:00Z");
    const decision = decideCampaignContactOutcome("no_answer", 1, policy, null, now);
    assert.equal(decision.status, "retry_scheduled");
    assert.equal(decision.nextAttemptAt, new Date("2026-09-12T12:00:00Z").toISOString());
  });

  test("stops retrying once max attempts is reached", () => {
    const decision = decideCampaignContactOutcome("no_answer", 3, policy);
    assert.deepEqual(decision, { status: "no_answer", nextAttemptAt: null });
  });

  test("never retries a non-retryable terminal status", () => {
    const decision = decideCampaignContactOutcome("completed", 1, policy);
    assert.deepEqual(decision, { status: "completed", nextAttemptAt: null });
  });

  test("never retries an explicit customer decline (cancelled is not in retryStatuses)", () => {
    const decision = decideCampaignContactOutcome("cancelled", 1, policy);
    assert.deepEqual(decision, { status: "cancelled", nextAttemptAt: null });
  });

  test("detects an opt-out signal from agent variables and overrides retry entirely", () => {
    const decision = decideCampaignContactOutcome("completed", 1, policy, { opted_out: true });
    assert.deepEqual(decision, { status: "opted_out", nextAttemptAt: null });
  });

  test("detects a wrong-number signal via call_outcome", () => {
    const decision = decideCampaignContactOutcome("completed", 1, policy, {
      call_outcome: "wrong_number",
    });
    assert.deepEqual(decision, { status: "wrong_number", nextAttemptAt: null });
  });

  test("does not treat an unrelated agent variable as a special outcome", () => {
    const decision = decideCampaignContactOutcome("no_answer", 1, policy, {
      appointment_confirmed: "yes",
    });
    assert.equal(decision.status, "retry_scheduled");
  });
});
