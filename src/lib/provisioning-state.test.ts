import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeProvisioningState,
  type ComputeProvisioningStateInput,
} from "./provisioning-state.ts";

function base(
  overrides: Partial<ComputeProvisioningStateInput> = {},
): ComputeProvisioningStateInput {
  return {
    sarvamCredentialsConfigured: true,
    lastAttemptFailed: false,
    hasNumber: true,
    numberActive: true,
    connectionLinked: true,
    agentSarvamMapped: true,
    inboundEnabled: true,
    ...overrides,
  };
}

describe("computeProvisioningState", () => {
  test("no Sarvam credentials configured -> waiting_for_credentials, regardless of anything else", () => {
    assert.equal(
      computeProvisioningState(base({ sarvamCredentialsConfigured: false })),
      "waiting_for_credentials",
    );
    // Even a fully-active-looking org is still reported this way — the
    // platform-wide blocker always wins.
    assert.equal(
      computeProvisioningState(
        base({ sarvamCredentialsConfigured: false, numberActive: true, inboundEnabled: true }),
      ),
      "waiting_for_credentials",
    );
  });

  test("number active and inbound enabled -> active", () => {
    assert.equal(computeProvisioningState(base()), "active");
  });

  test("active wins over a stale lastAttemptFailed signal", () => {
    assert.equal(computeProvisioningState(base({ lastAttemptFailed: true })), "active");
  });

  test("explicit failure signal, not yet active -> failed", () => {
    assert.equal(
      computeProvisioningState(
        base({ numberActive: false, inboundEnabled: false, lastAttemptFailed: true }),
      ),
      "failed",
    );
  });

  test("no number yet -> waiting_for_number", () => {
    assert.equal(
      computeProvisioningState(
        base({ hasNumber: false, numberActive: false, inboundEnabled: false }),
      ),
      "waiting_for_number",
    );
  });

  test("has a number but no connection linked -> waiting_for_connection", () => {
    assert.equal(
      computeProvisioningState(
        base({ numberActive: false, inboundEnabled: false, connectionLinked: false }),
      ),
      "waiting_for_connection",
    );
  });

  test("has a number and connection but agent not Sarvam-mapped -> waiting_for_agent", () => {
    assert.equal(
      computeProvisioningState(
        base({ numberActive: false, inboundEnabled: false, agentSarvamMapped: false }),
      ),
      "waiting_for_agent",
    );
  });

  test("everything in place, not yet active -> provisioning", () => {
    assert.equal(
      computeProvisioningState(base({ numberActive: false, inboundEnabled: false })),
      "provisioning",
    );
  });

  test("waiting_for_number takes priority over waiting_for_connection/waiting_for_agent when multiple are missing", () => {
    assert.equal(
      computeProvisioningState(
        base({
          hasNumber: false,
          numberActive: false,
          inboundEnabled: false,
          connectionLinked: false,
          agentSarvamMapped: false,
        }),
      ),
      "waiting_for_number",
    );
  });

  test("every branch returns one of exactly the seven documented states", () => {
    const STATES = new Set([
      "waiting_for_credentials",
      "waiting_for_agent",
      "waiting_for_connection",
      "waiting_for_number",
      "provisioning",
      "active",
      "failed",
    ]);
    const scenarios: ComputeProvisioningStateInput[] = [
      base(),
      base({ sarvamCredentialsConfigured: false }),
      base({ numberActive: false, inboundEnabled: false, lastAttemptFailed: true }),
      base({ hasNumber: false, numberActive: false, inboundEnabled: false }),
      base({ numberActive: false, inboundEnabled: false, connectionLinked: false }),
      base({ numberActive: false, inboundEnabled: false, agentSarvamMapped: false }),
      base({ numberActive: false, inboundEnabled: false }),
    ];
    for (const scenario of scenarios) {
      assert.ok(STATES.has(computeProvisioningState(scenario)));
    }
  });
});
