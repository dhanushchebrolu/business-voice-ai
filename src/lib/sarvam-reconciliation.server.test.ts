import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { outcomeFromAttempt, reconcileSarvamCall } from "./sarvam-reconciliation.server.ts";
import type { SarvamAttemptSummary } from "./telephony/sarvam-api-client.server.ts";

const attempt = (over: Partial<SarvamAttemptSummary> = {}): SarvamAttemptSummary => ({
  attemptId: "att-1",
  interactionId: "20261111/abc",
  connectivityStatus: "connected",
  durationSeconds: 61.4,
  nextActionStatus: "UNKNOWN",
  failureReason: "NO_FAILURE_REASON",
  appVersion: 2,
  attemptedAt: "2026-11-11T10:00:00",
  ...over,
});

const CALL = {
  id: "call-1",
  organization_id: "org-1",
  provider: "sarvam",
  direction: "outbound",
  status: "initiated",
  provider_call_id: "att-1",
  phone_number_id: "num-1",
  started_at: "2026-11-11T10:00:00Z",
};

/** Each table returns one fixed row. */
function fakeAdmin(rows: Record<string, unknown>) {
  return {
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      };
      return q;
    },
  } as never;
}

const defaultRows = {
  call_logs: CALL,
  phone_numbers: { organization_id: "org-1", agent_config_id: "agent-1" },
  agent_configs: { organization_id: "org-1", sarvam_app_id: "app-x" },
};

describe("outcomeFromAttempt", () => {
  test("maps Sarvam's connectivity to a final outcome, duration only when connected", () => {
    assert.deepEqual(outcomeFromAttempt(attempt()), { outcome: "completed", durationSeconds: 61 });
    assert.deepEqual(
      outcomeFromAttempt(attempt({ connectivityStatus: "no_answer", durationSeconds: 9 })),
      {
        outcome: "no_answer",
        durationSeconds: 0,
      },
    );
    assert.deepEqual(outcomeFromAttempt(attempt({ connectivityStatus: "failed" })), {
      outcome: "failed",
      durationSeconds: 0,
    });
  });

  test("not final while Sarvam will retry, or for an unknown status", () => {
    assert.equal(outcomeFromAttempt(attempt({ nextActionStatus: "retry" })), null);
    assert.equal(outcomeFromAttempt(attempt({ connectivityStatus: "ringing" })), null);
    assert.equal(outcomeFromAttempt(attempt({ connectivityStatus: null })), null);
  });
});

describe("reconcileSarvamCall", () => {
  const run = async (rows: Record<string, unknown>, found: SarvamAttemptSummary | null) => {
    const resolved: unknown[] = [];
    const searched: unknown[] = [];
    const result = await reconcileSarvamCall(fakeAdmin(rows), "call-1", {
      findAttempt: async (appId, attemptId, since, until) => {
        searched.push({ appId, attemptId, since: since.toISOString(), until: until.toISOString() });
        return found;
      },
      resolve: async (input) => {
        resolved.push(input);
      },
      now: () => new Date("2026-11-11T12:00:00Z"),
    });
    return { result, resolved, searched };
  };

  test("a final Sarvam outcome resolves the call through the shared path", async () => {
    const { result, resolved, searched } = await run(defaultRows, attempt());
    assert.deepEqual(result, { state: "resolved", outcome: "completed", durationSeconds: 61 });
    assert.deepEqual(resolved, [
      { callId: "call-1", outcome: "completed", durationSeconds: 61, attemptId: "att-1" },
    ]);
    assert.deepEqual(searched, [
      {
        appId: "app-x",
        attemptId: "att-1",
        since: "2026-11-11T09:50:00.000Z",
        until: "2026-11-11T12:00:00.000Z",
      },
    ]);
  });

  test("not found or not final yet stays pending; nothing is resolved", async () => {
    for (const found of [null, attempt({ nextActionStatus: "retry" })]) {
      const { result, resolved } = await run(defaultRows, found);
      assert.equal(result.state, "pending");
      assert.equal(resolved.length, 0);
    }
  });

  test("no recorded attempt id goes to an operator; nothing is looked up or resolved", async () => {
    const { result, resolved, searched } = await run(
      { ...defaultRows, call_logs: { ...CALL, status: "outcome_unknown", provider_call_id: null } },
      attempt(),
    );
    assert.equal(result.state, "needs_operator");
    assert.equal(searched.length + resolved.length, 0);
  });

  test("a number or agent belonging to another organization is never used", async () => {
    for (const rows of [
      { ...defaultRows, phone_numbers: { organization_id: "org-2", agent_config_id: "agent-1" } },
      { ...defaultRows, agent_configs: { organization_id: "org-2", sarvam_app_id: "app-x" } },
    ]) {
      const { result, searched, resolved } = await run(rows, attempt());
      assert.equal(result.state, "needs_operator");
      assert.equal(searched.length + resolved.length, 0);
    }
  });

  test("an already final call is left alone", async () => {
    const { result, searched } = await run(
      { ...defaultRows, call_logs: { ...CALL, status: "completed" } },
      attempt(),
    );
    assert.deepEqual(result, { state: "already_final", status: "completed" });
    assert.equal(searched.length, 0);
  });
});
