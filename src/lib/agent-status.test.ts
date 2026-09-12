import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { agentStatusLabel, type AgentStatusInput } from "./agent-status.ts";

/**
 * Regression test for the "sarvam_app_id unmapped must never show as
 * Live/Ready" fix — a published Klyro agent (active_version > 0) is not the
 * same thing as a working Sarvam agent, and Sarvam agent creation has no
 * verified API (see the Sarvam API verification audit), so it remains a
 * manual admin step. The status pill must say so explicitly rather than
 * claiming the receptionist is ready when it isn't.
 */

function baseAgent(overrides: Partial<AgentStatusInput> = {}): AgentStatusInput {
  return {
    active_version: 1,
    status: "live",
    sarvam_app_id: "app_123",
    sarvam_app_version: 1,
    ...overrides,
  };
}

describe("agentStatusLabel", () => {
  test("no agent -> Not configured", () => {
    assert.deepEqual(agentStatusLabel(null, true), { label: "Not configured", tone: "idle" });
  });

  test("never published -> Not configured", () => {
    assert.deepEqual(agentStatusLabel(baseAgent({ active_version: 0 }), true), {
      label: "Not configured",
      tone: "idle",
    });
  });

  test("published, has a number, agent-side live, and mapped to Sarvam -> Live", () => {
    assert.deepEqual(agentStatusLabel(baseAgent(), true), { label: "Live", tone: "live" });
  });

  test("published and mapped but no number yet -> Ready — no number", () => {
    assert.deepEqual(agentStatusLabel(baseAgent(), false), {
      label: "Ready — no number",
      tone: "ready",
    });
  });

  test("published, has a number, agent-side live, but sarvam_app_id is unmapped -> Provider setup required, never Live", () => {
    assert.deepEqual(agentStatusLabel(baseAgent({ sarvam_app_id: null }), true), {
      label: "Provider setup required",
      tone: "error",
    });
  });

  test("published and has a number, but sarvam_app_version is unmapped -> Provider setup required, never Ready", () => {
    assert.deepEqual(agentStatusLabel(baseAgent({ sarvam_app_version: null }), false), {
      label: "Provider setup required",
      tone: "error",
    });
  });

  test("agent-side error still takes priority over the provider-mapping check", () => {
    assert.deepEqual(agentStatusLabel(baseAgent({ status: "error", sarvam_app_id: null }), true), {
      label: "Error",
      tone: "error",
    });
  });

  test("agent-side paused still takes priority over the provider-mapping check", () => {
    assert.deepEqual(agentStatusLabel(baseAgent({ status: "paused", sarvam_app_id: null }), true), {
      label: "Paused",
      tone: "idle",
    });
  });
});
