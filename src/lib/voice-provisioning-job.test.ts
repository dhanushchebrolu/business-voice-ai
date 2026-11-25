import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  JOB_STEPS,
  MAX_AUTOMATIC_ATTEMPTS,
  backoffMs,
  beginStep,
  classifyOutcome,
  customerJobView,
  endStep,
  maskPhone,
  sanitizeDiagnostic,
  type StepStates,
} from "./voice-provisioning-job.ts";

const base = { attempts: 1, maxAttempts: MAX_AUTOMATIC_ATTEMPTS };

describe("classifyOutcome", () => {
  test("active succeeds", () => {
    assert.deepEqual(classifyOutcome({ ...base, state: "active", step: "activating" }), {
      kind: "succeeded",
    });
  });

  test("waiting states never retry automatically and give the customer a plain message", () => {
    for (const state of [
      "waiting_for_onboarding",
      "waiting_for_number",
      "waiting_for_agent",
      "waiting_for_voice_language",
      "waiting_for_integration_credential",
    ]) {
      const o = classifyOutcome({ ...base, state, step: "validating" });
      assert.equal(o.kind, "waiting", state);
      if (o.kind === "waiting")
        assert.doesNotMatch(o.customerMessage, /Sarvam|deployment|agent id/i);
    }
  });

  test("transient verification failures retry, then stop as retryable-by-hand", () => {
    const first = classifyOutcome({
      ...base,
      state: "verification_failed",
      step: "verifying_deployment",
    });
    assert.equal(first.kind, "retry");
    const last = classifyOutcome({
      ...base,
      attempts: MAX_AUTOMATIC_ATTEMPTS,
      state: "verification_failed",
      step: "verifying_deployment",
    });
    assert.equal(last.kind, "failed");
    if (last.kind === "failed") {
      assert.equal(last.code, "RETRIES_EXHAUSTED");
      assert.equal(last.retryable, true);
    }
  });

  test("permanent failures are never retried automatically", () => {
    const o = classifyOutcome({
      ...base,
      state: "manual_action_required",
      step: "creating_deployment",
    });
    assert.equal(o.kind, "failed");
    if (o.kind === "failed") assert.equal(o.retryable, false);
    const v = classifyOutcome({ ...base, state: "failed", step: "validating" });
    assert.equal(v.kind, "failed");
  });

  test("an explicit step classification wins over the state default", () => {
    const o = classifyOutcome({
      ...base,
      state: "failed",
      step: "creating_agent",
      failure: { code: "AGENT_CREATE_FAILED", retryable: true },
    });
    assert.equal(o.kind, "retry");
  });

  test("customer messages never expose provider detail", () => {
    for (const state of ["failed", "verification_failed", "manual_action_required"]) {
      const o = classifyOutcome({ ...base, state, step: "creating_deployment" });
      if (o.kind !== "succeeded")
        assert.doesNotMatch(o.customerMessage, /Sarvam|Vobiz|deployment|token|dep-/i);
    }
  });
});

describe("backoff", () => {
  test("grows exponentially and is capped", () => {
    assert.equal(backoffMs(1), 30_000);
    assert.equal(backoffMs(2), 60_000);
    assert.equal(backoffMs(3), 120_000);
    assert.equal(backoffMs(50), 15 * 60_000);
  });
});

describe("sanitizeDiagnostic / maskPhone", () => {
  test("removes bearer tokens, token values, urls and long opaque ids", () => {
    const raw =
      "failed Bearer abc.def.ghi at https://api.example.com/x?token=secret123 key=sk_live_1234567890 id " +
      "A".repeat(50);
    const out = sanitizeDiagnostic(raw);
    assert.doesNotMatch(out, /abc\.def|secret123|sk_live|https:|A{40}/);
  });
  test("truncates", () => assert.equal(sanitizeDiagnostic("word ".repeat(300)).length, 400));
  test("masks all but the last four digits", () => {
    assert.equal(maskPhone("+917965860061"), "••••0061");
    assert.equal(maskPhone(null), null);
    assert.doesNotMatch(sanitizeDiagnostic("number +917965860061 failed"), /7965860061/);
  });
});

describe("step states", () => {
  test("beginStep marks earlier steps done and drops later ones", () => {
    let s: StepStates = beginStep({}, "creating_deployment", "t1");
    assert.equal(s.validating?.status, "done");
    assert.equal(s.creating_agent?.status, "done");
    assert.equal(s.creating_deployment?.status, "running");
    assert.equal(s.verifying_deployment, undefined);
    s = endStep(s, "creating_deployment", "failed", "t2", "DEPLOYMENT_CREATE_FAILED");
    assert.equal(s.creating_deployment?.code, "DEPLOYMENT_CREATE_FAILED");
    // A resumed attempt counts the step's tries and re-runs it.
    s = beginStep(s, "creating_deployment", "t3");
    assert.equal(s.creating_deployment?.attempts, 2);
    assert.equal(s.creating_deployment?.status, "running");
  });
});

describe("customerJobView", () => {
  const run = (over: Record<string, unknown>) => ({
    status: "running",
    attempts: 1,
    current_job_step: "creating_agent",
    step_states: beginStep({}, "creating_agent", "t"),
    customer_message: null,
    retryable: null,
    next_attempt_at: null,
    ...over,
  });

  test("no job yet: queued and not busy", () => {
    const v = customerJobView(null, false);
    assert.equal(v.phase, "queued");
    assert.equal(v.busy, false);
    assert.equal(v.steps.length, JOB_STEPS.length);
    assert.ok(
      v.steps.every((s) => s.status === "pending"),
      "no fake progress",
    );
  });

  test("running shows the persisted steps exactly", () => {
    const v = customerJobView(run({}), false);
    assert.equal(v.phase, "running");
    assert.equal(v.busy, true);
    assert.equal(v.steps.find((s) => s.key === "validating")!.status, "done");
    assert.equal(v.steps.find((s) => s.key === "creating_agent")!.status, "running");
    assert.equal(v.steps.find((s) => s.key === "verifying_agent")!.status, "pending");
  });

  test("retrying, waiting, failed (retryable or not) and completed", () => {
    assert.equal(
      customerJobView(run({ status: "pending", next_attempt_at: "2026-01-01T00:00:00Z" }), false)
        .phase,
      "retrying",
    );
    const waiting = customerJobView(
      run({ status: "waiting", customer_message: "Our team…" }),
      false,
    );
    assert.equal(waiting.phase, "waiting");
    assert.equal(waiting.canRetry, true);
    assert.equal(customerJobView(run({ status: "failed", retryable: true }), false).canRetry, true);
    const perm = customerJobView(run({ status: "failed", retryable: false }), false);
    assert.equal(perm.canRetry, false);
    assert.equal(perm.phase, "failed");
    assert.equal(customerJobView(run({ status: "failed" }), true).phase, "completed");
  });

  test("a succeeded job whose number is not live is not shown as live", () => {
    assert.equal(customerJobView(run({ status: "succeeded" }), false).phase, "waiting");
    // the server only passes numberActive=true when ClickAI's number is verified-active
    assert.equal(customerJobView(null, true).phase, "completed");
  });
});
