import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeKlyroRuntimeReadiness,
  type KlyroRuntimeReadinessInput,
} from "./klyro-runtime-readiness.ts";

function baseInput(
  overrides: Partial<KlyroRuntimeReadinessInput> = {},
): KlyroRuntimeReadinessInput {
  return {
    exotelCredentialsPresent: true,
    sarvamKeyPresent: true,
    agentReady: true,
    numberAssigned: true,
    numberIsExotel: true,
    webhookBaseUrlConfigured: true,
    runtimeHealthCheck: null,
    ...overrides,
  };
}

describe("computeKlyroRuntimeReadiness", () => {
  test("missing Exotel credentials takes priority over everything else", () => {
    const result = computeKlyroRuntimeReadiness(
      baseInput({
        exotelCredentialsPresent: false,
        sarvamKeyPresent: false,
        agentReady: false,
      }),
    );
    assert.equal(result.state, "missing_exotel_credentials");
    assert.equal(result.runtimeVerified, false);
  });

  test("missing Sarvam key (Exotel credentials present)", () => {
    const result = computeKlyroRuntimeReadiness(baseInput({ sarvamKeyPresent: false }));
    assert.equal(result.state, "missing_sarvam_key");
  });

  test("agent not ready", () => {
    const result = computeKlyroRuntimeReadiness(baseInput({ agentReady: false }));
    assert.equal(result.state, "agent_incomplete");
  });

  test("no phone number assigned at all", () => {
    const result = computeKlyroRuntimeReadiness(
      baseInput({ numberAssigned: false, numberIsExotel: false }),
    );
    assert.equal(result.state, "number_not_assigned");
  });

  test("a number is assigned but mapped to a different provider (e.g. sarvam) -> treated as not assigned for this runtime", () => {
    const result = computeKlyroRuntimeReadiness(
      baseInput({ numberAssigned: true, numberIsExotel: false }),
    );
    assert.equal(result.state, "number_not_assigned");
  });

  test("webhook base URL not configured", () => {
    const result = computeKlyroRuntimeReadiness(baseInput({ webhookBaseUrlConfigured: false }));
    assert.equal(result.state, "webhook_not_configured");
  });

  test("runtime health check explicitly failed -> runtime_unavailable", () => {
    const result = computeKlyroRuntimeReadiness(baseInput({ runtimeHealthCheck: false }));
    assert.equal(result.state, "runtime_unavailable");
    assert.equal(result.runtimeVerified, false);
  });

  test("every checkable prerequisite passes, no health probe run (null) -> ready_for_test_call, but not verified", () => {
    const result = computeKlyroRuntimeReadiness(baseInput({ runtimeHealthCheck: null }));
    assert.equal(result.state, "ready_for_test_call");
    assert.equal(result.runtimeVerified, false);
  });

  test("every checkable prerequisite passes, health probe omitted entirely -> ready_for_test_call, not verified", () => {
    const { runtimeHealthCheck: _omitted, ...withoutHealthCheck } = baseInput();
    const result = computeKlyroRuntimeReadiness(withoutHealthCheck);
    assert.equal(result.state, "ready_for_test_call");
    assert.equal(result.runtimeVerified, false);
  });

  test("every checkable prerequisite passes and health probe actually passed -> ready_for_test_call, verified", () => {
    const result = computeKlyroRuntimeReadiness(baseInput({ runtimeHealthCheck: true }));
    assert.equal(result.state, "ready_for_test_call");
    assert.equal(result.runtimeVerified, true);
  });

  test("checklist reflects every individual input regardless of overall state", () => {
    const input = baseInput({
      exotelCredentialsPresent: true,
      sarvamKeyPresent: false,
      agentReady: false,
      numberAssigned: false,
      numberIsExotel: false,
      webhookBaseUrlConfigured: false,
    });
    const result = computeKlyroRuntimeReadiness(input);
    assert.deepEqual(result.checklist, {
      exotelCredentialsPresent: true,
      sarvamKeyPresent: false,
      agentReady: false,
      numberAssigned: false,
      numberIsExotel: false,
      webhookBaseUrlConfigured: false,
    });
  });
});
