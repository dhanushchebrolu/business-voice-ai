import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildCampaignReport,
  campaignSpend,
  classifyCampaignResult,
  evaluateEligibility,
  nextAction,
} from "./campaign-results.ts";
import { decideCampaignContactOutcome } from "./campaign-outcome.ts";

const plus91 = (e: string) => e.startsWith("+91");

describe("contact eligibility", () => {
  test("opted out, invalid, outside +91 and repeated numbers are excluded with their reason", () => {
    const v = evaluateEligibility(
      [
        { e164: "+919800000001", optedOut: false },
        { e164: "+919800000002", optedOut: true },
        { e164: null, optedOut: false },
        { e164: "+14155550100", optedOut: false },
        { e164: "+919800000001", optedOut: false },
      ],
      plus91,
    );
    assert.deepEqual(v, [
      { eligible: true },
      { eligible: false, reason: "opted_out" },
      { eligible: false, reason: "invalid_number" },
      { eligible: false, reason: "country_not_allowed" },
      { eligible: false, reason: "duplicate_number" },
    ]);
  });

  test("selecting everyone never makes an opted-out or foreign number eligible", () => {
    const contacts = Array.from({ length: 500 }, (_, i) => ({
      e164: i % 10 === 0 ? "+14155550100" : `+9198${String(i).padStart(8, "0")}`,
      optedOut: i % 17 === 0,
    }));
    const v = evaluateEligibility(contacts, plus91);
    v.forEach((r, i) => {
      if (contacts[i]!.optedOut || !contacts[i]!.e164!.startsWith("+91"))
        assert.equal(r.eligible, false);
    });
  });
});

describe("conversation results, as recorded after each call", () => {
  const completed = (vars: Record<string, string>) => classifyCampaignResult("completed", vars);

  test("interested; wants an appointment (nothing was booked); asked to be contacted later", () => {
    assert.equal(completed({ outbound_result: "interested" }), "interested");
    assert.equal(
      completed({ outbound_result: "interested", requested_slot: "2026-11-21 08:00" }),
      "appointment_intent",
    );
    assert.equal(completed({ outbound_result: "callback_requested" }), "callback_requested");
    assert.deepEqual(nextAction("appointment_intent"), {
      action: "They were asked to call the business to book; nothing was booked",
      done: false,
    });
    assert.equal(
      nextAction("callback_requested")!.done,
      false,
      "a follow-up is pending, never claimed done",
    );
  });

  test("not interested; opted out; wrong number; voicemail", () => {
    assert.equal(completed({ outbound_result: "not_interested" }), "not_interested");
    assert.equal(
      completed({ outbound_result: "interested", opted_out: "yes" }),
      "opted_out",
      "opt-out wins",
    );
    assert.equal(classifyCampaignResult("opted_out", {}), "opted_out");
    assert.equal(completed({ wrong_number: "yes", outbound_result: "interested" }), "wrong_number");
    assert.equal(completed({ outbound_result: "wrong_person" }), "wrong_number");
    assert.equal(
      classifyCampaignResult("no_answer", { outbound_result: "voicemail" }),
      "voicemail",
    );
    assert.equal(nextAction("opted_out")!.done, true);
  });

  test("busy, no answer and failed calls, and calls still open", () => {
    assert.equal(classifyCampaignResult("busy", null), "busy");
    assert.equal(classifyCampaignResult("no_answer", null), "no_answer");
    assert.equal(classifyCampaignResult("failed", null), "failed");
    assert.equal(classifyCampaignResult("calling", null), "in_progress");
    assert.equal(classifyCampaignResult("outcome_unknown", null), "unconfirmed");
    assert.equal(classifyCampaignResult("retry_scheduled", null), "queued");
    assert.equal(classifyCampaignResult("excluded", null), "excluded");
  });

  test("a connected call with no clear result is unclassified, never counted as interest", () => {
    assert.equal(completed({ outbound_result: "no_conversation" }), "unclassified");
    assert.equal(completed({}), "unclassified");
  });

  test("retry policy for these results: busy/no answer retried, voicemail and opt-out never", () => {
    const policy = {
      maxAttempts: 3,
      retryAfterMinutes: 60,
      retryStatuses: ["no_answer", "busy", "failed"],
    };
    assert.equal(decideCampaignContactOutcome("busy", 1, policy, null).status, "retry_scheduled");
    assert.equal(
      decideCampaignContactOutcome("no_answer", 1, policy, null).status,
      "retry_scheduled",
    );
    assert.equal(
      decideCampaignContactOutcome("no_answer", 3, policy, null).nextAttemptAt,
      null,
      "attempts exhausted",
    );
    assert.equal(
      decideCampaignContactOutcome("no_answer", 1, policy, { outbound_result: "voicemail" })
        .nextAttemptAt,
      null,
    );
    assert.equal(
      decideCampaignContactOutcome("completed", 1, policy, { opted_out: "yes" }).status,
      "opted_out",
    );
  });
});

describe("campaign report and spend", () => {
  test("distinguishes attempted, connected, interested, callbacks, opt-outs, failures and exclusions", () => {
    const r = buildCampaignReport([
      { status: "completed", attempts: 1, output_variables: { outbound_result: "interested" } },
      {
        status: "completed",
        attempts: 1,
        output_variables: { outbound_result: "callback_requested" },
      },
      { status: "completed", attempts: 2, output_variables: { outbound_result: "not_interested" } },
      { status: "opted_out", attempts: 1, output_variables: { opted_out: "yes" } },
      { status: "no_answer", attempts: 3, output_variables: {} },
      { status: "failed", attempts: 1, output_variables: {} },
      { status: "excluded", attempts: 0, excluded_reason: "country_not_allowed" },
      { status: "pending", attempts: 0 },
    ]);
    assert.equal(r.total, 8);
    assert.equal(r.eligible, 7);
    assert.equal(r.excluded, 1);
    assert.deepEqual(r.excludedByReason, { country_not_allowed: 1 });
    assert.equal(r.attempted, 6);
    assert.equal(r.connected, 4);
    assert.equal(r.interested, 2);
    assert.equal(r.callbacks, 1);
    assert.equal(r.optOuts, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.queued, 1);
  });

  test("spend: billed calls at their charge, unbilled at worst case, failed starts free", () => {
    const s = campaignSpend([
      {
        status: "completed",
        customer_charge: 800,
        billing_applied_at: "x",
        billing_cap_minutes: 5,
        billing_rate_per_minute: 400,
      },
      {
        status: "initiated",
        customer_charge: null,
        billing_applied_at: null,
        billing_cap_minutes: 5,
        billing_rate_per_minute: 400,
      },
      {
        status: "completed",
        customer_charge: null,
        billing_applied_at: null,
        billing_cap_minutes: 5,
        billing_rate_per_minute: 400,
      },
      {
        status: "failed",
        customer_charge: null,
        billing_applied_at: null,
        billing_cap_minutes: 5,
        billing_rate_per_minute: 400,
        resolution_source: "start_failure",
      },
    ]);
    assert.deepEqual(s, { spent: 800, reserved: 4000 });
  });
});
