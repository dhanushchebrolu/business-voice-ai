import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decideCampaignContactOutcome,
  retrySettingsProblem,
  type CampaignRetryPolicy,
} from "./campaign-outcome.ts";

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

describe("detectSpecialOutcome (also gates campaign leads)", () => {
  test("an opt-out wins; wrong number next; anything else is not special", async () => {
    const { detectSpecialOutcome } = await import("./campaign-outcome.ts");
    assert.equal(
      detectSpecialOutcome({ opted_out: "yes", call_outcome: "callback_requested" }),
      "opted_out",
    );
    assert.equal(detectSpecialOutcome({ opted_out: true }), "opted_out");
    assert.equal(detectSpecialOutcome({ do_not_call: "true" }), "opted_out");
    assert.equal(detectSpecialOutcome({ opted_out: "no", wrong_number: "yes" }), "wrong_number");
    assert.equal(detectSpecialOutcome({ opted_out: "no", interest_level: "high" }), null);
    assert.equal(detectSpecialOutcome(null), null);
  });
});

describe("voicemail is never retried", () => {
  test("a voicemail attempt is final even when the provider reported a retryable status", () => {
    for (const status of ["no_answer", "busy", "failed", "completed"] as const)
      assert.deepEqual(
        decideCampaignContactOutcome(status, 1, policy, { outbound_result: "voicemail" }),
        { status, nextAttemptAt: null },
        status,
      );
  });

  test("an opt-out or wrong number on the same call still takes precedence", () => {
    assert.equal(
      decideCampaignContactOutcome("no_answer", 1, policy, {
        outbound_result: "voicemail",
        opted_out: "yes",
      }).status,
      "opted_out",
    );
    assert.equal(
      decideCampaignContactOutcome("no_answer", 1, policy, {
        outbound_result: "voicemail",
        wrong_number: "yes",
      }).status,
      "wrong_number",
    );
  });

  test("other results keep the normal retry policy", () => {
    assert.equal(
      decideCampaignContactOutcome("no_answer", 1, policy, { outbound_result: "no_conversation" })
        .status,
      "retry_scheduled",
    );
  });
});

describe("retry limits (GATE C4 H1): someone who answered is never called again", () => {
  const now = new Date("2026-09-12T10:00:00Z");
  const unsafe: CampaignRetryPolicy = {
    maxAttempts: 10,
    retryAfterMinutes: 0,
    retryStatuses: ["completed", "cancelled", "no_answer", "busy", "failed"],
  };

  test("a completed or cancelled call is final even when the campaign lists it for retry", () => {
    for (const status of ["completed", "cancelled"] as const)
      assert.deepEqual(decideCampaignContactOutcome(status, 1, unsafe, null, now), {
        status,
        nextAttemptAt: null,
      });
  });

  test("a retry never comes sooner than 15 minutes, whatever the campaign says", () => {
    for (const retryAfterMinutes of [0, -60, 5, Number.NaN]) {
      const d = decideCampaignContactOutcome(
        "no_answer",
        1,
        { ...unsafe, retryAfterMinutes },
        null,
        now,
      );
      assert.equal(d.status, "retry_scheduled");
      assert.equal(d.nextAttemptAt, new Date("2026-09-12T10:15:00Z").toISOString());
    }
  });

  test("nor later than 7 days", () => {
    const d = decideCampaignContactOutcome(
      "busy",
      1,
      { ...policy, retryAfterMinutes: 999_999 },
      null,
      now,
    );
    assert.equal(d.nextAttemptAt, new Date("2026-09-19T10:00:00Z").toISOString());
  });

  test("launch refuses settings outside the limits", () => {
    const ok = { retry_statuses: ["no_answer", "busy", "failed"], retry_after_minutes: 120 };
    assert.equal(retrySettingsProblem(ok), null);
    assert.equal(retrySettingsProblem({ retry_statuses: [], retry_after_minutes: 15 }), null);
    assert.equal(retrySettingsProblem({ ...ok, retry_after_minutes: 10080 }), null);
    assert.match(
      retrySettingsProblem({ ...ok, retry_statuses: ["no_answer", "completed"] }) ?? "",
      /Only no-answer, busy or failed/,
    );
    for (const retry_after_minutes of [0, 14, 10081, 1.5, null])
      assert.match(
        retrySettingsProblem({ ...ok, retry_after_minutes }) ?? "",
        /between 15 minutes and 7 days/,
      );
  });
});
