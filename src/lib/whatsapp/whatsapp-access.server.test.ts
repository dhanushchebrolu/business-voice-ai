import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  assignWhatsAppBotForUser,
  disconnectWhatsAppConnectionForUser,
  requireWhatsAppManager,
  WhatsAppAccessError,
} from "./whatsapp-access.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

/**
 * Runtime coverage for WhatsApp connection-management authorization:
 * the real functions run against the in-memory Supabase stand-in
 * (whatsapp-test-db.ts), so every check here is on rows actually read and
 * written, not on source text.
 */

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000b1";
const BIZ = "00000000-0000-4000-8000-0000000000a2";
const OTHER_BIZ = "00000000-0000-4000-8000-0000000000b2";
const CONN = "00000000-0000-4000-8000-0000000000a3";
const OTHER_CONN = "00000000-0000-4000-8000-0000000000b3";
const AGENT = "00000000-0000-4000-8000-0000000000a4";
const OTHER_AGENT = "00000000-0000-4000-8000-0000000000b4";

const USERS = {
  owner: "00000000-0000-4000-8000-000000000001",
  admin: "00000000-0000-4000-8000-000000000002",
  manager: "00000000-0000-4000-8000-000000000003",
  staff: "00000000-0000-4000-8000-000000000004",
  viewer: "00000000-0000-4000-8000-000000000005",
  otherOwner: "00000000-0000-4000-8000-000000000006",
  multi: "00000000-0000-4000-8000-000000000007",
  nobody: "00000000-0000-4000-8000-000000000008",
};

function seed(options: Parameters<typeof createFakeDb>[1] = {}) {
  return createFakeDb(
    {
      organization_members: [
        { organization_id: ORG, user_id: USERS.owner, role: "owner" },
        { organization_id: ORG, user_id: USERS.admin, role: "admin" },
        { organization_id: ORG, user_id: USERS.manager, role: "manager" },
        { organization_id: ORG, user_id: USERS.staff, role: "staff" },
        { organization_id: ORG, user_id: USERS.viewer, role: "viewer" },
        { organization_id: OTHER_ORG, user_id: USERS.otherOwner, role: "owner" },
        { organization_id: ORG, user_id: USERS.multi, role: "owner" },
        { organization_id: OTHER_ORG, user_id: USERS.multi, role: "owner" },
      ],
      businesses: [
        { id: BIZ, organization_id: ORG },
        { id: OTHER_BIZ, organization_id: OTHER_ORG },
      ],
      agent_configs: [
        { id: AGENT, organization_id: ORG, business_id: BIZ },
        { id: OTHER_AGENT, organization_id: OTHER_ORG, business_id: OTHER_BIZ },
      ],
      whatsapp_connections: [
        {
          id: CONN,
          organization_id: ORG,
          business_id: BIZ,
          phone_number_id: "pn-a",
          status: "connected",
          agent_config_id: null,
          disconnected_at: null,
        },
        {
          id: OTHER_CONN,
          organization_id: OTHER_ORG,
          business_id: OTHER_BIZ,
          phone_number_id: "pn-b",
          status: "connected",
          agent_config_id: OTHER_AGENT,
          disconnected_at: null,
        },
      ],
    },
    options,
  );
}

const conn = (db: ReturnType<typeof seed>, id: string) =>
  db.rows("whatsapp_connections").find((r) => r["id"] === id)!;

async function rejectsWith(promise: Promise<unknown>, code: WhatsAppAccessError["code"]) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof WhatsAppAccessError, String(err));
    assert.equal(err.code, code);
    return true;
  });
}

describe("requireWhatsAppManager", () => {
  test("owners and admins of the target's organization pass; the scope comes from the target row", async () => {
    const db = seed();
    for (const user of [USERS.owner, USERS.admin]) {
      assert.deepEqual(await requireWhatsAppManager(db.client, user, { connectionId: CONN }), {
        organizationId: ORG,
        businessId: BIZ,
        connectionId: CONN,
      });
      assert.deepEqual(await requireWhatsAppManager(db.client, user, { businessId: BIZ }), {
        organizationId: ORG,
        businessId: BIZ,
        connectionId: null,
      });
    }
  });

  test("manager, staff and viewer are refused", async () => {
    const db = seed();
    for (const user of [USERS.manager, USERS.staff, USERS.viewer]) {
      await rejectsWith(
        requireWhatsAppManager(db.client, user, { connectionId: CONN }),
        "FORBIDDEN",
      );
      await rejectsWith(requireWhatsAppManager(db.client, user, { businessId: BIZ }), "FORBIDDEN");
      await rejectsWith(requireWhatsAppManager(db.client, user, { workspace: true }), "FORBIDDEN");
    }
  });

  test("another tenant's connection or business looks exactly like one that doesn't exist", async () => {
    const db = seed();
    const missing = "00000000-0000-4000-8000-0000000000ff";
    for (const target of [
      { connectionId: OTHER_CONN },
      { connectionId: missing },
      { businessId: OTHER_BIZ },
      { businessId: missing },
    ]) {
      await assert.rejects(requireWhatsAppManager(db.client, USERS.owner, target), {
        message: "That business or WhatsApp connection was not found in your workspace.",
      });
    }
  });

  test("without a target business: the caller's only workspace, never an arbitrary one of several", async () => {
    const db = seed();
    assert.deepEqual(await requireWhatsAppManager(db.client, USERS.owner, { workspace: true }), {
      organizationId: ORG,
      businessId: null,
      connectionId: null,
    });
    await rejectsWith(
      requireWhatsAppManager(db.client, USERS.multi, { workspace: true }),
      "AMBIGUOUS_WORKSPACE",
    );
    await rejectsWith(
      requireWhatsAppManager(db.client, USERS.nobody, { workspace: true }),
      "NO_WORKSPACE",
    );
    // A user in several organizations can still act by naming the business.
    const scope = await requireWhatsAppManager(db.client, USERS.multi, { businessId: OTHER_BIZ });
    assert.equal(scope.organizationId, OTHER_ORG);
  });

  test("a database error fails closed", async () => {
    const db = seed({
      failWhen: (table, op) =>
        table === "organization_members" && op === "select"
          ? { code: "57014", message: "statement timeout" }
          : null,
    });
    await assert.rejects(requireWhatsAppManager(db.client, USERS.owner, { connectionId: CONN }), {
      message: "statement timeout",
    });
  });
});

describe("assignWhatsAppBotForUser", () => {
  test("an owner assigns a bot from the same organization, then clears it", async () => {
    const db = seed();
    await assignWhatsAppBotForUser(db.client, USERS.owner, {
      connectionId: CONN,
      agentConfigId: AGENT,
    });
    assert.equal(conn(db, CONN)["agent_config_id"], AGENT);
    await assignWhatsAppBotForUser(db.client, USERS.admin, {
      connectionId: CONN,
      agentConfigId: null,
    });
    assert.equal(conn(db, CONN)["agent_config_id"], null);
  });

  test("a bot from another organization is refused and nothing is written", async () => {
    const db = seed();
    await rejectsWith(
      assignWhatsAppBotForUser(db.client, USERS.owner, {
        connectionId: CONN,
        agentConfigId: OTHER_AGENT,
      }),
      "NOT_FOUND",
    );
    assert.equal(conn(db, CONN)["agent_config_id"], null);
  });

  test("another tenant's connection can't be repointed, even to that tenant's own bot", async () => {
    const db = seed();
    await rejectsWith(
      assignWhatsAppBotForUser(db.client, USERS.owner, {
        connectionId: OTHER_CONN,
        agentConfigId: null,
      }),
      "NOT_FOUND",
    );
    assert.equal(conn(db, OTHER_CONN)["agent_config_id"], OTHER_AGENT);
  });

  test("staff and viewers can't change which bot answers customers", async () => {
    const db = seed();
    for (const user of [USERS.staff, USERS.viewer, USERS.manager]) {
      await rejectsWith(
        assignWhatsAppBotForUser(db.client, user, { connectionId: CONN, agentConfigId: AGENT }),
        "FORBIDDEN",
      );
    }
    assert.equal(conn(db, CONN)["agent_config_id"], null);
    assert.equal(
      db.log.filter((l) => l.table === "whatsapp_connections" && l.op === "update").length,
      0,
    );
  });
});

describe("disconnectWhatsAppConnectionForUser", () => {
  test("marks the connection disconnected and keeps the row; a repeat call changes nothing", async () => {
    const db = seed();
    const first = await disconnectWhatsAppConnectionForUser(db.client, USERS.owner, {
      connectionId: CONN,
    });
    assert.deepEqual(first, { organizationId: ORG, connectionId: CONN, changed: true });
    const row = conn(db, CONN);
    assert.equal(row["status"], "disconnected");
    const disconnectedAt = row["disconnected_at"];
    assert.ok(typeof disconnectedAt === "string");

    const second = await disconnectWhatsAppConnectionForUser(db.client, USERS.admin, {
      connectionId: CONN,
    });
    assert.equal(second.changed, false);
    assert.equal(conn(db, CONN)["disconnected_at"], disconnectedAt);
    assert.equal(db.rows("whatsapp_connections").length, 2);
  });

  test("another tenant's connection and non-managers are refused, with nothing written", async () => {
    const db = seed();
    await rejectsWith(
      disconnectWhatsAppConnectionForUser(db.client, USERS.owner, { connectionId: OTHER_CONN }),
      "NOT_FOUND",
    );
    await rejectsWith(
      disconnectWhatsAppConnectionForUser(db.client, USERS.viewer, { connectionId: CONN }),
      "FORBIDDEN",
    );
    assert.equal(conn(db, CONN)["status"], "connected");
    assert.equal(conn(db, OTHER_CONN)["status"], "connected");
  });
});
