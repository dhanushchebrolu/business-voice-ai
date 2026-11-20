import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CALL_NOT_FOUND,
  callContextSnapshotForMember,
  loadCallContextSnapshot,
} from "./call-context-snapshot.server.ts";
import { readContextSnapshot, snapshotFieldValue } from "./call-context-snapshot.ts";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";

const REVIEWED_V1 = "2026-11-20T10:00:00.000000+00:00";
const snapshotA = {
  version: 1,
  reviewed_at: REVIEWED_V1,
  context: {
    version: 1,
    objective: "Remind patients their six-month check-up is due.",
    audience: "Patients seen over six months ago",
    talkingPoints: ["Check-ups catch problems early", "Evening slots are open"],
    questions: [],
    successCriteria: "Bookings requested",
  },
  sent: {
    campaign_objective: "Remind patients their six-month check-up is due.",
    campaign_instructions: "Audience: Patients seen over six months ago\nTalking points: ...",
  },
};

function setup() {
  const memberships = [
    { user_id: "member_a", organization_id: "org_a", role: "staff" },
    { user_id: "member_b", organization_id: "org_b", role: "owner" },
  ];
  const user = (userId: string) =>
    memorySupabase({
      tables: { organization_members: memberships.filter((m) => m.user_id === userId) },
    }).client;
  const admin = memorySupabase({
    tables: {
      call_logs: [
        {
          id: "call_a_campaign",
          organization_id: "org_a",
          campaign_id: "camp_a",
          campaign_context_snapshot: snapshotA,
        },
        {
          id: "call_a_legacy",
          organization_id: "org_a",
          campaign_id: "camp_a",
          campaign_context_snapshot: null,
        },
        {
          id: "call_a_inbound",
          organization_id: "org_a",
          campaign_id: null,
          campaign_context_snapshot: null,
        },
        {
          id: "call_a_broken",
          organization_id: "org_a",
          campaign_id: "camp_a",
          campaign_context_snapshot: { sent: { campaign_objective: 3 } },
        },
        {
          id: "call_b_campaign",
          organization_id: "org_b",
          campaign_id: "camp_b",
          campaign_context_snapshot: { ...snapshotA, sent: { ...snapshotA.sent } },
        },
      ],
      campaigns: [
        {
          id: "camp_a",
          organization_id: "org_a",
          name: "Check-up reminders",
          context_version: 1,
          // Same instant as the snapshot, different text format.
          context_reviewed_at: "2026-11-20T10:00:00Z",
        },
        {
          id: "camp_b",
          organization_id: "org_b",
          name: "B campaign",
          context_version: 1,
          context_reviewed_at: "2026-11-20T12:00:00Z",
        },
      ],
    },
  }).client;
  return {
    as: (userId: string) => ({ supabase: user(userId), supabaseAdmin: admin }),
    admin,
  };
}

describe("call context snapshot: authorization and tenant isolation", () => {
  test("a member reads the exact snapshot of their own workspace's campaign call", async () => {
    const { as } = setup();
    const view = await callContextSnapshotForMember(as("member_a"), "member_a", "call_a_campaign");
    assert.equal(view.state, "snapshot");
    if (view.state !== "snapshot") return;
    assert.equal(view.snapshot.sent.objective, snapshotA.sent.campaign_objective);
    assert.equal(view.snapshot.sent.instructions, snapshotA.sent.campaign_instructions);
    assert.equal(view.snapshot.version, 1);
    assert.equal(view.snapshot.reviewedAt, REVIEWED_V1);
    assert.deepEqual(view.snapshot.context, snapshotA.context);
    assert.equal(view.campaign?.name, "Check-up reminders");
    assert.equal(view.currentDiffers, false, "same instant in another format is not a change");
  });

  test("another workspace's call is refused exactly like a missing call", async () => {
    const { as } = setup();
    await assert.rejects(
      callContextSnapshotForMember(as("member_a"), "member_a", "call_b_campaign"),
      { message: CALL_NOT_FOUND },
    );
    await assert.rejects(callContextSnapshotForMember(as("member_a"), "member_a", "no_such_call"), {
      message: CALL_NOT_FOUND,
    });
  });

  test("a signed-in user with no membership reads nothing", async () => {
    const { as } = setup();
    await assert.rejects(
      callContextSnapshotForMember(as("stranger"), "stranger", "call_a_campaign"),
      { message: CALL_NOT_FOUND },
    );
  });

  test("the loader's own workspace filter refuses another workspace's call", async () => {
    const { admin } = setup();
    await assert.rejects(loadCallContextSnapshot(admin, "call_b_campaign", "org_a"), {
      message: CALL_NOT_FOUND,
    });
  });
});

describe("call context snapshot: calls without a snapshot", () => {
  test("a non-campaign call is reported as such", async () => {
    const { as } = setup();
    const view = await callContextSnapshotForMember(as("member_a"), "member_a", "call_a_inbound");
    assert.deepEqual(view, { state: "not_campaign" });
  });

  test("a campaign call recorded before snapshots existed has none, with its campaign", async () => {
    const { as } = setup();
    const view = await callContextSnapshotForMember(as("member_a"), "member_a", "call_a_legacy");
    assert.equal(view.state, "no_snapshot");
    if (view.state === "no_snapshot") assert.equal(view.campaign?.id, "camp_a");
  });

  test("a malformed snapshot is reported as unreadable, never half-shown", async () => {
    const { as } = setup();
    const view = await callContextSnapshotForMember(as("member_a"), "member_a", "call_a_broken");
    assert.equal(view.state, "unreadable");
  });

  test("a campaign re-reviewed after the call is flagged as differing", async () => {
    const { admin } = setup();
    const view = await loadCallContextSnapshot(admin, "call_b_campaign", null);
    assert.equal(view.state, "snapshot");
    if (view.state === "snapshot") assert.equal(view.currentDiffers, true);
  });
});

describe("call context snapshot: reading the stored value", () => {
  test("only the shape admission writes is accepted", () => {
    assert.equal(readContextSnapshot(null), null);
    assert.equal(readContextSnapshot({ version: 1 }), null);
    assert.equal(readContextSnapshot({ sent: { campaign_objective: "x" } }), null);
    const minimal = readContextSnapshot({
      sent: { campaign_objective: "", campaign_instructions: "" },
    });
    assert.deepEqual(minimal, {
      version: null,
      reviewedAt: null,
      context: null,
      sent: { objective: "", instructions: "" },
    });
  });

  test("context values display as text or lists; empty and non-text values are skipped", () => {
    assert.equal(snapshotFieldValue("Tone: warm"), "Tone: warm");
    assert.equal(snapshotFieldValue("   "), null);
    assert.deepEqual(snapshotFieldValue(["a", "", 3, "b"]), ["a", "b"]);
    assert.equal(snapshotFieldValue([]), null);
    assert.equal(snapshotFieldValue({ nested: true }), null);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

describe("call context snapshot: server-only access and a read-only viewer", () => {
  const fns = read("call-context-snapshot.functions.ts");
  const viewer = read("../components/app/CallContextSnapshot.tsx");
  const history = read("../components/app/CallsHistory.tsx");
  const adminDialog = read("../components/admin/CallDetailDialog.tsx");
  const workspace = read("workspace.ts");

  test("both server functions require a signed-in caller; the admin one a platform admin", () => {
    assert.equal(fns.match(/\.middleware\(\[requireSupabaseAuth\]\)/g)?.length, 2);
    assert.match(fns, /assertPlatformAdmin\(context\.supabase, context\.userId, "billing\.read"\)/);
    assert.match(fns, /callContextSnapshotForMember\(/);
    // The caller never chooses the workspace: it comes from the call.
    assert.doesNotMatch(fns, /organizationId/);
  });

  test("customers never select the snapshot column directly", () => {
    assert.doesNotMatch(workspace, /campaign_context_snapshot/);
    assert.doesNotMatch(viewer, /from\("call_logs"\)|supabase\./);
  });

  test("the viewer is read-only: no buttons, mutations or call actions", () => {
    assert.doesNotMatch(viewer, /<Button|mutate|useMutation|launch|resume|redial|retry\(/i);
    assert.match(viewer, /<LoadingState/);
    assert.match(viewer, /<ErrorState/);
    assert.match(viewer, /Not a campaign call/);
    assert.match(viewer, /No context was recorded for this call/);
    assert.match(viewer, /could not be read/);
    assert.match(viewer, /The campaign's context has been edited since this call/);
    assert.match(viewer, /campaign_objective/);
    assert.match(viewer, /campaign_instructions/);
  });

  test("shown in the existing call details for outbound calls only", () => {
    assert.match(
      history,
      /selected\.direction === "outbound" \? \(\s*<CallContextSnapshot callId=\{selected\.id\} scope="member" \/>/,
    );
    assert.match(
      adminDialog,
      /data\.direction === "outbound" && callId \? \([\s\S]{0,120}<CallContextSnapshot callId=\{callId\} scope="admin" \/>/,
    );
  });
});
