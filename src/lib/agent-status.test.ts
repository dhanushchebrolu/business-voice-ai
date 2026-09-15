import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { agentStatusLabel, type AgentStatusInput } from "./agent-status.ts";

/**
 * Covers two things:
 *   1. The pre-existing "sarvam_app_id unmapped must never show as
 *      Live/Ready" fix — a Sarvam-*managed* number (Sarvam Voice Agents
 *      runs the whole call against an app configured by hand in Sarvam's
 *      own dashboard) is not ready just because Klyro's own agent config is
 *      valid; that mapping is a real, separate prerequisite for that path.
 *   2. The Klyro-owned Exotel runtime's *different* requirement: Sarvam is
 *      an AI backend there, not the telephony provider, so no
 *      sarvam_app_id is needed at all — passing `numberProvider: "exotel"`
 *      (or any non-Sarvam provider) must not demand one.
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

  test("never configured (active_version 0) -> Not configured", () => {
    assert.deepEqual(agentStatusLabel(baseAgent({ active_version: 0 }), true), {
      label: "Not configured",
      tone: "idle",
    });
  });

  test("configured before but currently invalid (status not_configured, active_version > 0) -> Incomplete, never Ready/Live", () => {
    assert.deepEqual(agentStatusLabel(baseAgent({ status: "not_configured" }), true, "exotel"), {
      label: "Incomplete",
      tone: "idle",
    });
  });

  test("has a number, agent-side live, and mapped to Sarvam -> Live (Sarvam-managed number)", () => {
    assert.deepEqual(agentStatusLabel(baseAgent(), true, "sarvam"), {
      label: "Live",
      tone: "live",
    });
  });

  test("mapped but no number yet -> Ready — no number", () => {
    assert.deepEqual(agentStatusLabel(baseAgent(), false, "sarvam"), {
      label: "Ready — no number",
      tone: "ready",
    });
  });

  test("has a number, agent-side live, but sarvam_app_id is unmapped on a Sarvam-managed number -> Provider setup required, never Live", () => {
    assert.deepEqual(agentStatusLabel(baseAgent({ sarvam_app_id: null }), true, "sarvam"), {
      label: "Provider setup required",
      tone: "error",
    });
  });

  test("has a number, but sarvam_app_version is unmapped on a Sarvam-managed number -> Provider setup required, never Ready", () => {
    assert.deepEqual(agentStatusLabel(baseAgent({ sarvam_app_version: null }), false, "sarvam"), {
      label: "Provider setup required",
      tone: "error",
    });
  });

  test("no numberProvider passed (unknown / not yet assigned) -> defaults to the stricter Sarvam-managed behavior, never Ready without a mapping", () => {
    assert.deepEqual(agentStatusLabel(baseAgent({ sarvam_app_id: null }), false), {
      label: "Provider setup required",
      tone: "error",
    });
  });

  test("Klyro-owned Exotel runtime: no sarvam_app_id needed at all -> Live", () => {
    assert.deepEqual(
      agentStatusLabel(
        baseAgent({ sarvam_app_id: null, sarvam_app_version: null }),
        true,
        "exotel",
      ),
      {
        label: "Live",
        tone: "live",
      },
    );
  });

  test("Klyro-owned Exotel runtime, valid config, status ready (not yet live), has a number -> Ready", () => {
    assert.deepEqual(
      agentStatusLabel(
        baseAgent({ status: "ready", sarvam_app_id: null, sarvam_app_version: null }),
        true,
        "exotel",
      ),
      { label: "Ready", tone: "ready" },
    );
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
