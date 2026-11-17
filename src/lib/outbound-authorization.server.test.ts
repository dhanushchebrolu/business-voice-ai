import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  campaignOrganizationForCaller,
  outboundNumberOrganizationForCaller,
  OUTBOUND_ROLE_MESSAGE,
} from "./outbound-authorization.server.ts";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";

/**
 * A user who belongs to two workspaces: staff in A (joined first, so the old
 * "oldest membership" lookup would always pick A) and owner of B.
 */
function setup() {
  const memberships = [
    {
      user_id: "user_1",
      organization_id: "org_a",
      role: "staff",
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      user_id: "user_1",
      organization_id: "org_b",
      role: "owner",
      created_at: "2026-06-01T00:00:00Z",
    },
    {
      user_id: "user_2",
      organization_id: "org_b",
      role: "admin",
      created_at: "2026-06-01T00:00:00Z",
    },
    {
      user_id: "user_3",
      organization_id: "org_b",
      role: "viewer",
      created_at: "2026-06-01T00:00:00Z",
    },
  ];
  const user = memorySupabase({ tables: { organization_members: memberships } });
  const admin = memorySupabase({
    tables: {
      campaigns: [
        { id: "camp_a", organization_id: "org_a" },
        { id: "camp_b", organization_id: "org_b" },
        { id: "camp_c", organization_id: "org_c" },
      ],
      phone_numbers: [
        { id: "num_a", organization_id: "org_a" },
        { id: "num_b", organization_id: "org_b" },
        { id: "num_c", organization_id: "org_c" },
        { id: "num_unassigned", organization_id: null },
      ],
    },
  });
  return { clients: { supabase: user.client, supabaseAdmin: admin.client } };
}

describe("campaigns: the workspace comes from the campaign, not the user's first workspace", () => {
  test("a multi-workspace owner launches a campaign in their second workspace", async () => {
    const { clients } = setup();
    const org = await campaignOrganizationForCaller(clients, "user_1", "camp_b", { dial: true });
    assert.equal(org, "org_b");
  });

  test("the same user cannot launch in the workspace where they are only staff", async () => {
    const { clients } = setup();
    await assert.rejects(
      campaignOrganizationForCaller(clients, "user_1", "camp_a", { dial: true }),
      new RegExp(OUTBOUND_ROLE_MESSAGE),
    );
  });

  test("staff can still pause, cancel or read stats (membership only)", async () => {
    const { clients } = setup();
    const org = await campaignOrganizationForCaller(clients, "user_1", "camp_a", { dial: false });
    assert.equal(org, "org_a");
  });

  test("an admin may launch; a viewer may not", async () => {
    const { clients } = setup();
    assert.equal(
      await campaignOrganizationForCaller(clients, "user_2", "camp_b", { dial: true }),
      "org_b",
    );
    await assert.rejects(
      campaignOrganizationForCaller(clients, "user_3", "camp_b", { dial: true }),
      new RegExp(OUTBOUND_ROLE_MESSAGE),
    );
  });

  test("another customer's campaign looks exactly like a missing one", async () => {
    const { clients } = setup();
    for (const dial of [true, false]) {
      await assert.rejects(
        campaignOrganizationForCaller(clients, "user_1", "camp_c", { dial }),
        /Campaign not found\./,
      );
      await assert.rejects(
        campaignOrganizationForCaller(clients, "user_1", "camp_missing", { dial }),
        /Campaign not found\./,
      );
    }
  });
});

describe("single calls: the workspace comes from the caller number", () => {
  test("an owner dials from their second workspace's number", async () => {
    const { clients } = setup();
    assert.equal(await outboundNumberOrganizationForCaller(clients, "user_1", "num_b"), "org_b");
  });

  test("staff cannot dial; another customer's or an unassigned number is not found", async () => {
    const { clients } = setup();
    await assert.rejects(
      outboundNumberOrganizationForCaller(clients, "user_1", "num_a"),
      new RegExp(OUTBOUND_ROLE_MESSAGE),
    );
    for (const id of ["num_c", "num_unassigned", "num_missing"])
      await assert.rejects(
        outboundNumberOrganizationForCaller(clients, "user_1", id),
        /not assigned to your workspace/,
      );
  });
});
