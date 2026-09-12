import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { provisioningStatusLabel, type ProvisioningStatusInput } from "./provisioning-status.ts";

/**
 * Coverage for the six client-dashboard provisioning labels (Task #96):
 * "Setting up your phone agent", "Waiting for phone number", "Activating
 * inbound calling", "Outbound calling ready", "Active", "Setup needs admin
 * attention". Every case here corresponds to a real, reachable combination
 * of provisioning-orchestrator.server.ts's own signals — never an invented
 * state.
 */

function base(overrides: Partial<ProvisioningStatusInput> = {}): ProvisioningStatusInput {
  return {
    lifecycleStatus: "provisioning",
    hasNumber: true,
    numberActive: true,
    connectionLinked: true,
    agentSarvamMapped: true,
    inboundEnabled: true,
    outboundEnabled: true,
    ...overrides,
  };
}

describe("provisioningStatusLabel", () => {
  test("number active, inbound and outbound both on -> Active", () => {
    assert.deepEqual(provisioningStatusLabel(base()), { label: "Active", tone: "live" });
  });

  test("number active, inbound on, outbound still off -> Outbound calling ready", () => {
    assert.deepEqual(provisioningStatusLabel(base({ outboundEnabled: false })), {
      label: "Outbound calling ready",
      tone: "ready",
    });
  });

  test("has a number, connection linked, agent mapped, but not active/inbound yet -> Activating inbound calling", () => {
    assert.deepEqual(
      provisioningStatusLabel(base({ numberActive: false, inboundEnabled: false })),
      { label: "Activating inbound calling", tone: "ready" },
    );
  });

  test("has a number but no connection registered -> Setup needs admin attention", () => {
    assert.deepEqual(
      provisioningStatusLabel(
        base({ numberActive: false, inboundEnabled: false, connectionLinked: false }),
      ),
      { label: "Setup needs admin attention", tone: "error" },
    );
  });

  test("has a number but agent not mapped to a Sarvam app -> Setup needs admin attention", () => {
    assert.deepEqual(
      provisioningStatusLabel(
        base({ numberActive: false, inboundEnabled: false, agentSarvamMapped: false }),
      ),
      { label: "Setup needs admin attention", tone: "error" },
    );
  });

  test("no number yet, right after payment (lifecycle_status still setup_paid) -> Setting up your phone agent", () => {
    assert.deepEqual(
      provisioningStatusLabel(
        base({ hasNumber: false, numberActive: false, lifecycleStatus: "setup_paid" }),
      ),
      { label: "Setting up your phone agent", tone: "ready" },
    );
  });

  test("no number yet, lifecycle already past setup_paid (pool was empty) -> Waiting for phone number", () => {
    assert.deepEqual(
      provisioningStatusLabel(
        base({ hasNumber: false, numberActive: false, lifecycleStatus: "provisioning" }),
      ),
      { label: "Waiting for phone number", tone: "ready" },
    );
  });

  test("never shows a raw identifier or error string — every branch returns one of the six fixed labels", () => {
    const FIXED_LABELS = new Set([
      "Setting up your phone agent",
      "Waiting for phone number",
      "Activating inbound calling",
      "Outbound calling ready",
      "Active",
      "Setup needs admin attention",
    ]);
    const scenarios: ProvisioningStatusInput[] = [
      base(),
      base({ outboundEnabled: false }),
      base({ numberActive: false, inboundEnabled: false }),
      base({ numberActive: false, inboundEnabled: false, connectionLinked: false }),
      base({ numberActive: false, inboundEnabled: false, agentSarvamMapped: false }),
      base({ hasNumber: false, numberActive: false, lifecycleStatus: "setup_paid" }),
      base({ hasNumber: false, numberActive: false, lifecycleStatus: "ready" }),
    ];
    for (const scenario of scenarios) {
      assert.ok(FIXED_LABELS.has(provisioningStatusLabel(scenario).label));
    }
  });
});
