import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  activationGate,
  provisioningChecklist,
  queueStatus,
  queueStatusTone,
  registrationGate,
  type ChecklistInput,
} from "./provisioning-view.ts";

const NOW = new Date("2026-11-14T10:00:00Z");
const ready: ChecklistInput = {
  blockers: [],
  number: {
    e164: "+917900000002",
    status: "provisioning",
    deploymentId: null,
    confirmedInSarvam: true,
    verifiedDeploymentId: null,
    admissionBlockedReason: null,
  },
  connectionRegistered: true,
  credential: { status: "active", expiresAt: null },
  agent: { appId: "Customer-app-1", appVersion: 1 },
  masterAgentAppId: "Master-agent",
  verification: null,
  voiceLanguage: { problem: null, appliedAppId: "Customer-app-1", appliedVersion: 1 },
  now: NOW,
};
const statusOf = (i: ChecklistInput, step: number) =>
  provisioningChecklist(i).find((c) => c.step === step)!.status;

describe("queue status", () => {
  test("waiting on data or assignment is shown as blocked; waiting on the Sarvam step is waiting", () => {
    assert.equal(
      queueStatus({ status: "waiting", current_step: "waiting_for_onboarding" }),
      "blocked",
    );
    assert.equal(queueStatus({ status: "waiting", current_step: "waiting_for_number" }), "blocked");
    assert.equal(queueStatus({ status: "waiting", current_step: "waiting_for_agent" }), "waiting");
    assert.equal(queueStatus({ status: "failed", current_step: "verification_failed" }), "failed");
    assert.equal(queueStatusTone("blocked"), "error");
    assert.equal(queueStatusTone("succeeded"), "live");
  });
});

describe("checklist rendering states", () => {
  test("a fresh customer shows onboarding blocked and nothing else done", () => {
    const i: ChecklistInput = {
      ...ready,
      blockers: ["Business name is missing."],
      number: null,
      credential: null,
      agent: { appId: null, appVersion: null },
    };
    const list = provisioningChecklist(i);
    assert.equal(list.length, 10);
    assert.equal(statusOf(i, 1), "blocked");
    assert.match(list[0]!.detail, /Business name is missing/);
    assert.equal(statusOf(i, 2), "blocked");
    assert.equal(statusOf(i, 6), "todo");
    assert.ok(list.find((c) => c.step === 5)!.manual, "the Sarvam console step is marked manual");
  });

  test("an expired credential is not done", () => {
    assert.equal(
      statusOf(
        { ...ready, credential: { status: "active", expiresAt: "2026-11-01T00:00:00Z" } },
        4,
      ),
      "todo",
    );
    assert.equal(statusOf(ready, 4), "done");
  });

  test("a master-template registration shows step 6 failed", () => {
    assert.equal(
      statusOf({ ...ready, agent: { appId: "Master-agent", appVersion: 3 } }, 6),
      "failed",
    );
  });

  test("failed verification checks mark 8 or 9 failed and keep 10 not done", () => {
    const bad = {
      ...ready,
      number: { ...ready.number!, deploymentId: "dep-1" },
      verification: {
        checks: [
          { id: "status", ok: false },
          { id: "routes_number", ok: true },
          { id: "clickai_mapping", ok: true },
        ],
      },
    };
    assert.equal(statusOf(bad, 8), "failed");
    assert.equal(statusOf(bad, 9), "done");
    assert.equal(statusOf(bad, 10), "todo");
    const mapBad = {
      ...bad,
      verification: {
        checks: [
          { id: "status", ok: true },
          { id: "routes_number", ok: false },
        ],
      },
    };
    assert.equal(statusOf(mapBad, 9), "failed");
  });

  test("everything verified and active shows all ten done", () => {
    const live: ChecklistInput = {
      ...ready,
      number: {
        ...ready.number!,
        status: "active",
        deploymentId: "dep-1",
        verifiedDeploymentId: "dep-1",
      },
      verification: {
        checks: ["status", "agent", "version", "webhook", "routes_number", "clickai_mapping"].map(
          (id) => ({ id, ok: true }),
        ),
      },
    };
    assert.ok(provisioningChecklist(live).every((c) => c.status === "done"));
  });
});

describe("voice & language gates (Phase 4A)", () => {
  test("missing settings: step 3 todo with the reason, registration refused", () => {
    const i = {
      ...ready,
      voiceLanguage: {
        problem: "Voice and languages are not set.",
        appliedAppId: null,
        appliedVersion: null,
      },
    };
    assert.equal(statusOf(i, 3), "todo");
    assert.match(provisioningChecklist(i)[2]!.detail, /not set/);
    assert.match(registrationGate(i, "Customer-app-1").reasons.join(" "), /voice & language/);
  });

  test("settings applied to another version: step 6 not done and activation blocked", () => {
    const i = {
      ...ready,
      voiceLanguage: { problem: null, appliedAppId: "Customer-app-1", appliedVersion: 7 },
    };
    assert.equal(statusOf(i, 6), "todo");
    const g = activationGate(i);
    assert.equal(g.allowed, false);
    assert.match(g.reasons.join(" "), /not recorded as applied/);
  });

  test("settings applied to a DIFFERENT agent with the same version are not applied (Phase 5)", () => {
    const i = {
      ...ready,
      voiceLanguage: { problem: null, appliedAppId: "Other-agent-9", appliedVersion: 1 },
    };
    assert.equal(statusOf(i, 6), "todo");
    assert.equal(activationGate(i).allowed, false);
    assert.match(activationGate(i).reasons.join(" "), /agent and version/);
  });

  test("settings applied to the registered version: step 6 done, activation allowed", () => {
    assert.equal(statusOf(ready, 6), "done");
    assert.equal(activationGate(ready).allowed, true);
  });
});

describe("gates", () => {
  test("registration is refused for the master agent, without a credential, or with onboarding gaps", () => {
    assert.equal(registrationGate(ready, "Customer-app-1").allowed, true);
    assert.match(
      registrationGate(ready, "Master-agent").reasons.join(" "),
      /universal master agent/,
    );
    assert.match(
      registrationGate({ ...ready, credential: null }, "X-app").reasons.join(" "),
      /credential/,
    );
    assert.match(
      registrationGate({ ...ready, blockers: ["x"] }, "X-app").reasons.join(" "),
      /Onboarding/,
    );
  });

  test("activation is blocked until every prerequisite is met", () => {
    assert.equal(activationGate(ready).allowed, true);
    for (const [name, i] of [
      ["no number", { ...ready, number: null }],
      ["no connection", { ...ready, connectionRegistered: false }],
      ["no credential", { ...ready, credential: null }],
      ["no agent", { ...ready, agent: { appId: null, appVersion: null } }],
      ["master agent", { ...ready, agent: { appId: "Master-agent", appVersion: 1 } }],
      ["onboarding gaps", { ...ready, blockers: ["missing hours"] }],
    ] as const) {
      const g = activationGate(i as ChecklistInput);
      assert.equal(g.allowed, false, name);
      assert.ok(g.reasons.length > 0, name);
    }
  });
});

describe("number confirmation and admission (Phase 5)", () => {
  test("an unconfirmed number without a deployment blocks activation and shows step 2 todo", () => {
    const i = { ...ready, number: { ...ready.number!, confirmedInSarvam: false } };
    assert.equal(statusOf(i, 2), "todo");
    assert.match(provisioningChecklist(i)[1]!.detail, /confirm it already exists in Sarvam/);
    const g = activationGate(i);
    assert.equal(g.allowed, false);
    assert.match(g.reasons.join(" "), /Confirm the number exists in Sarvam/);
  });

  test("a number already on a recorded deployment counts as present in Sarvam", () => {
    const i = {
      ...ready,
      number: { ...ready.number!, confirmedInSarvam: false, deploymentId: "dep-1" },
    };
    assert.equal(statusOf(i, 2), "done");
    assert.equal(activationGate(i).allowed, true);
  });

  test("an admission block fails step 10 and blocks activation until cleared", () => {
    const i = {
      ...ready,
      number: { ...ready.number!, admissionBlockedReason: "unverified deployment dep-x" },
    };
    assert.equal(statusOf(i, 10), "failed");
    assert.equal(activationGate(i).allowed, false);
  });

  test("an active number is not shown live until its verified deployment matches", () => {
    const checks = [
      "status",
      "agent",
      "version",
      "webhook",
      "routes_number",
      "clickai_mapping",
    ].map((id) => ({ id, ok: true }));
    const i = {
      ...ready,
      number: {
        ...ready.number!,
        status: "active",
        deploymentId: "dep-2",
        verifiedDeploymentId: "dep-1",
      },
      verification: { checks },
    };
    assert.equal(statusOf(i, 10), "todo");
  });
});

describe("step 10 wording matches what callers actually get (browser check fix)", () => {
  test("an ACTIVE but unverified number says business data is blocked, not answering", () => {
    const i = {
      ...ready,
      number: {
        ...ready.number!,
        status: "active",
        deploymentId: "dep-1",
        verifiedDeploymentId: null,
      },
    };
    const item = provisioningChecklist(i).find((c) => c.step === 10)!;
    assert.equal(item.status, "todo");
    assert.match(item.detail, /business data is blocked until its deployment is verified/);
    assert.doesNotMatch(item.detail, /Answering calls/);
  });
});
