import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import {
  changeContactOptOut,
  reverseContactOptOut,
  isNumberSuppressed,
  suppressContact,
} from "./contact-suppression.server.ts";
import { applyOutcomeToCampaignContact } from "./campaign-dispatch.server.ts";
import { partitionDoNotCall } from "./campaign-cohort.ts";
import { csvToTable, validateContactRows } from "./contacts-import.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Persistent contact-level do-not-call, against an in-memory database. The
 * database-side guard (no clearing outside the audited reversal) is covered
 * by supabase/migrations/contact_opt_out_guard.pg.test.ts.
 */

type Row = Record<string, unknown>;
const ORG_A = "org_a";
const ORG_B = "org_b";
const PHONE = "+919876500001";
const POLICY = { max_attempts: 3, retry_after_minutes: 60, retry_statuses: ["no_answer"] };

function setup() {
  const audit: Row[] = [];
  const db = memorySupabase({
    tables: {
      contacts: [
        { id: "c_a", organization_id: ORG_A, phone: PHONE, opted_out: false, custom_fields: {} },
        { id: "c_b", organization_id: ORG_B, phone: PHONE, opted_out: false, custom_fields: {} },
      ],
      campaign_contacts: [
        {
          id: "cc_1",
          campaign_id: "camp_1",
          organization_id: ORG_A,
          contact_id: "c_a",
          status: "calling",
        },
        {
          id: "cc_2",
          campaign_id: "camp_2",
          organization_id: ORG_A,
          contact_id: "c_a",
          status: "pending",
        },
        {
          id: "cc_3",
          campaign_id: "camp_b",
          organization_id: ORG_B,
          contact_id: "c_b",
          status: "pending",
        },
      ],
      audit_logs: audit,
    },
    uniques: [
      {
        table: "campaign_contacts",
        key: (r) => `${r["campaign_id"]}:${r["contact_id"]}`,
      },
      { table: "contacts", key: (r) => `${r["organization_id"]}:${r["phone"]}` },
    ],
    // No rpc on the service-role client: the database refuses reverse_contact_opt_out
    // to the service role, so any attempt fails here too and is recorded.
    rpc: {},
  });
  const serviceRoleRpcCalls: string[] = [];
  const adminClient = db.client as unknown as {
    from: unknown;
    rpc: (n: string, a: Row) => Promise<unknown>;
  };
  const adminRpc = adminClient.rpc;
  adminClient.rpc = (name: string, args: Row) => {
    serviceRoleRpcCalls.push(name);
    return adminRpc(name, args);
  };
  const members: Row[] = [
    { organization_id: ORG_A, user_id: "u_owner", role: "owner" },
    { organization_id: ORG_A, user_id: "u_admin", role: "admin" },
    { organization_id: ORG_A, user_id: "u_staff", role: "staff" },
    { organization_id: ORG_B, user_id: "u_admin_b", role: "admin" },
  ];
  const userRpcArgs: Row[] = [];
  /**
   * The signed-in user's client: the actor is the JWT subject (`jwtUserId`),
   * exactly as auth.uid() in reverse_contact_opt_out. Mirrors its checks.
   */
  const user = (jwtUserId: string) =>
    ({
      from: adminClient.from,
      rpc: async (name: string, args: Row) => {
        userRpcArgs.push(args);
        if (name !== "reverse_contact_opt_out") return { data: null, error: { message: "no rpc" } };
        const role = members.find(
          (m) => m["organization_id"] === args["p_organization_id"] && m["user_id"] === jwtUserId,
        )?.["role"];
        if (role !== "owner" && role !== "admin")
          return {
            data: null,
            error: { message: "only an owner or admin can remove a do-not-call entry" },
          };
        const c = db.tables["contacts"]!.find(
          (r) =>
            r["id"] === args["p_contact_id"] && r["organization_id"] === args["p_organization_id"],
        );
        if (!c) return { data: null, error: { message: "contact not found" } };
        if (!c["opted_out"]) return { data: null, error: null }; // duplicate: no second audit row
        audit.push({
          action: "contact.opt_out_reversed",
          entity_id: c["id"],
          organization_id: c["organization_id"],
          admin_user_id: jwtUserId,
          reason: args["p_reason"],
          old_value: { opted_out: c["opted_out"], opted_out_reason: c["opted_out_reason"] },
        });
        Object.assign(c, { opted_out: false, opted_out_at: null, opted_out_reason: null });
        return { data: null, error: null };
      },
    }) as never;
  const t = (name: string) => db.tables[name] ?? [];
  const row = (name: string, id: string) => t(name).find((r) => r["id"] === id)!;
  return { db, t, row, audit, user, userRpcArgs, serviceRoleRpcCalls };
}

describe("campaign opt-out marks the verified contact", () => {
  test("an opted_out outcome sets contacts.opted_out on ClickAI's own contact and stops its other enrolments", async () => {
    const s = setup();
    await applyOutcomeToCampaignContact(
      "cc_1",
      "completed",
      1,
      POLICY,
      { opted_out: "yes" },
      s.db.client,
    );
    assert.equal(
      s.row("campaign_contacts", "cc_1")["status"],
      "opted_out",
      "campaign-level record kept",
    );
    assert.equal(s.row("contacts", "c_a")["opted_out"], true);
    assert.equal(s.row("contacts", "c_a")["opted_out_reason"], "Requested during an outbound call");
    assert.equal(
      s.row("campaign_contacts", "cc_2")["status"],
      "opted_out",
      "other campaign stopped",
    );
    // Same number in another customer's workspace: untouched.
    assert.equal(s.row("contacts", "c_b")["opted_out"], false);
    assert.equal(s.row("campaign_contacts", "cc_3")["status"], "pending");
  });

  test("a non-opt-out outcome leaves the contact callable", async () => {
    const s = setup();
    await applyOutcomeToCampaignContact(
      "cc_1",
      "completed",
      1,
      POLICY,
      { opted_out: "no" },
      s.db.client,
    );
    assert.equal(s.row("contacts", "c_a")["opted_out"], false);
    assert.equal(s.row("campaign_contacts", "cc_2")["status"], "pending");
  });

  test("duplicate events and retries keep the first record and never clear it", async () => {
    const s = setup();
    const first = await suppressContact(s.db.client, {
      organizationId: ORG_A,
      contactId: "c_a",
      reason: "Requested during an outbound call",
      now: new Date("2026-11-18T10:00:00Z"),
    });
    const again = await suppressContact(s.db.client, {
      organizationId: ORG_A,
      contactId: "c_a",
      reason: "something else",
      now: new Date("2026-11-18T11:00:00Z"),
    });
    await applyOutcomeToCampaignContact(
      "cc_1",
      "completed",
      1,
      POLICY,
      { opted_out: "yes" },
      s.db.client,
    );
    await applyOutcomeToCampaignContact(
      "cc_1",
      "completed",
      1,
      POLICY,
      { opted_out: "no" },
      s.db.client,
    );
    assert.deepEqual([first.newlySuppressed, again.newlySuppressed], [true, false]);
    const c = s.row("contacts", "c_a");
    assert.equal(c["opted_out"], true, "a later non-opt-out event never clears it");
    assert.equal(c["opted_out_at"], "2026-11-18T10:00:00.000Z");
    assert.equal(c["opted_out_reason"], "Requested during an outbound call");
  });

  test("a contact id from another organization is never suppressed", async () => {
    const s = setup();
    const r = await suppressContact(s.db.client, {
      organizationId: ORG_A,
      contactId: "c_b",
      reason: "x",
    });
    assert.equal(r.newlySuppressed, false);
    assert.equal(s.row("contacts", "c_b")["opted_out"], false);
    assert.equal(s.row("campaign_contacts", "cc_3")["status"], "pending");
  });
});

describe("future campaigns and imports exclude opted-out contacts", () => {
  // A CSV upload skipping an opted-out contact (and never clearing it) now happens inside
  // the import_campaign_contacts database function; it is proven against real PostgreSQL
  // in supabase/migrations/campaign_contact_import_atomic.pg.test.ts.

  test("a Sarvam cohort launch never uploads an opted-out or missing contact", () => {
    const { dialable, excluded } = partitionDoNotCall([
      { id: "a", contacts: { opted_out: false } },
      { id: "b", contacts: { opted_out: true } },
      { id: "c", contacts: null },
    ]);
    assert.deepEqual(
      dialable.map((r) => r.id),
      ["a"],
    );
    assert.deepEqual(
      excluded.map((r) => r.id),
      ["b", "c"],
    );
  });

  test("a lead the person asked not to be contacted about suppresses the number, in that workspace only", async () => {
    const s = setup();
    s.db.tables["leads"] = [
      { id: "l1", organization_id: ORG_A, phone: PHONE, status: "do_not_contact" },
      { id: "l2", organization_id: ORG_A, phone: "+919876500009", status: "new" },
    ];
    assert.equal(await isNumberSuppressed(s.db.client, ORG_A, PHONE), true);
    assert.equal(await isNumberSuppressed(s.db.client, ORG_B, PHONE), false);
    assert.equal(await isNumberSuppressed(s.db.client, ORG_A, "+919876500009"), false);
  });

  test("single calls are refused for a number this workspace has on do-not-call, only in that workspace", async () => {
    const s = setup();
    s.row("contacts", "c_a")["opted_out"] = true;
    assert.equal(await isNumberSuppressed(s.db.client, ORG_A, PHONE), true);
    assert.equal(await isNumberSuppressed(s.db.client, ORG_B, PHONE), false);
    assert.equal(await isNumberSuppressed(s.db.client, ORG_A, "+919876500009"), false);
  });
});

describe("manual changes", () => {
  test("any member can mark do-not-call", async () => {
    const s = setup();
    const r = await changeContactOptOut(s.db.client, s.user("u_staff"), {
      organizationId: ORG_A,
      contactId: "c_a",
      actorRole: "staff",
      optedOut: true,
    });
    assert.equal(r.changed, true);
    assert.equal(s.row("contacts", "c_a")["opted_out_reason"], "Manually marked do-not-call");
  });

  test("clearing needs an owner/admin and a reason, and writes an audit record", async () => {
    const s = setup();
    s.row("contacts", "c_a")["opted_out"] = true;
    s.row("contacts", "c_a")["opted_out_reason"] = "Requested during an outbound call";
    const clear = (actorRole: string, reason?: string) =>
      changeContactOptOut(s.db.client, s.user(actorRole === "owner" ? "u_owner" : "u_staff"), {
        organizationId: ORG_A,
        contactId: "c_a",
        actorRole,
        optedOut: false,
        reason,
      });
    await assert.rejects(clear("staff", "customer asked again"), /owner or admin/);
    await assert.rejects(clear("admin"), /reason is required/);
    await assert.rejects(clear("admin", "  ok "), /reason is required/);
    assert.equal(s.row("contacts", "c_a")["opted_out"], true, "still suppressed");
    assert.equal(s.audit.length, 0);

    await clear("owner", "Customer asked in writing to be called again");
    assert.equal(s.row("contacts", "c_a")["opted_out"], false);
    assert.equal(s.audit.length, 1);
    assert.equal(s.audit[0]!["reason"], "Customer asked in writing to be called again");
    assert.equal(s.audit[0]!["admin_user_id"], "u_owner");
    assert.deepEqual(s.audit[0]!["old_value"], {
      opted_out: true,
      opted_out_reason: "Requested during an outbound call",
    });
  });
});

describe("an opted-out number stays suppressed", () => {
  const optOut = (s: ReturnType<typeof setup>) => {
    Object.assign(s.row("contacts", "c_a"), {
      opted_out: true,
      opted_out_reason: "Requested during an outbound call",
    });
  };

  test("re-importing the number in another format normalizes to the stored number", () => {
    // ... so the import matches the existing (suppressed) contact; that it then stays
    // suppressed and unenrolled is proven in campaign_contact_import_atomic.pg.test.ts.
    const table = csvToTable("phone,name\n+91 98765 00001,Asha\n");
    const summary = validateContactRows(table, "phone");
    assert.equal(summary.valid[0]!.phone, PHONE, "normalized to the stored number");
  });

  test("manually re-adding the number in the same workspace is rejected", async () => {
    const s = setup();
    optOut(s);
    const { error } = await (
      s.db.client as unknown as {
        from: (t: string) => {
          insert: (r: Record<string, unknown>) => Promise<{ error: { code?: string } | null }>;
        };
      }
    )
      .from("contacts")
      .insert({ organization_id: ORG_A, phone: PHONE, opted_out: false });
    assert.equal(error?.code, "23505");
    assert.equal(s.row("contacts", "c_a")["opted_out"], true);
  });

  test("single-call checks normalize the number first", async () => {
    const s = setup();
    optOut(s);
    assert.equal(await isNumberSuppressed(s.db.client, ORG_A, "+91 98765-00001"), true);
    assert.equal(await isNumberSuppressed(s.db.client, ORG_A, "00919876500001"), true);
    assert.equal(await isNumberSuppressed(s.db.client, ORG_B, "+91 98765-00001"), false);
    assert.equal(
      await isNumberSuppressed(s.db.client, ORG_A, "not a number"),
      true,
      "an unusable number is never dialled",
    );
  });

  test("duplicate reversal requests write one audit record", async () => {
    const s = setup();
    optOut(s);
    const clear = () =>
      changeContactOptOut(s.db.client, s.user("u_owner"), {
        organizationId: ORG_A,
        contactId: "c_a",
        actorRole: "owner",
        optedOut: false,
        reason: "Customer asked in writing",
      });
    await Promise.all([clear(), clear()]);
    await clear();
    assert.equal(s.row("contacts", "c_a")["opted_out"], false);
    assert.equal(s.audit.length, 1);
  });

  // (The re-import part of this race now runs in PostgreSQL: campaign_contact_import_atomic.pg.test.ts.)
  test("concurrent opt-outs and a member's mark leave one suppressed contact", async () => {
    const s = setup();
    await Promise.all([
      suppressContact(s.db.client, {
        organizationId: ORG_A,
        contactId: "c_a",
        reason: "Requested during an outbound call",
      }),
      changeContactOptOut(s.db.client, s.user("u_staff"), {
        organizationId: ORG_A,
        contactId: "c_a",
        actorRole: "staff",
        optedOut: true,
      }),
      suppressContact(s.db.client, {
        organizationId: ORG_A,
        contactId: "c_a",
        reason: "duplicate webhook",
      }),
    ]);
    const c = s.row("contacts", "c_a");
    assert.equal(c["opted_out"], true);
    assert.equal(c["opted_out_reason"], "Requested during an outbound call", "first one wins");
    assert.equal(s.t("contacts").filter((r) => r["organization_id"] === ORG_A).length, 1);
    assert.equal(await isNumberSuppressed(s.db.client, ORG_A, PHONE), true);
    assert.equal(s.row("contacts", "c_b")["opted_out"], false, "other workspace untouched");
  });

  test("no application code deletes contacts (deletion is guarded in the database)", () => {
    const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
    const offenders: string[] = [];
    for (const entry of readdirSync(root, { recursive: true }) as string[]) {
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.ts$/.test(entry)) continue;
      const src = readFileSync(join(root, entry), "utf8");
      if (/from\("contacts"\)\s*\.delete\(/.test(src)) offenders.push(entry);
    }
    assert.deepEqual(offenders, []);
  });
});

describe("the reversal actor comes from the signed-in user, never from a parameter", () => {
  const optOut = (s: ReturnType<typeof setup>) => {
    s.row("contacts", "c_a")["opted_out"] = true;
  };

  test("no actor id is sent; the audit names the JWT user", async () => {
    const s = setup();
    optOut(s);
    await reverseContactOptOut(s.user("u_admin"), {
      organizationId: ORG_A,
      contactId: "c_a",
      reason: "Customer asked in writing",
    });
    assert.deepEqual(Object.keys(s.userRpcArgs[0]!).sort(), [
      "p_contact_id",
      "p_organization_id",
      "p_reason",
    ]);
    assert.equal(s.audit[0]!["admin_user_id"], "u_admin");
  });

  test("a forged role or a forged actor id cannot clear it", async () => {
    const s = setup();
    optOut(s);
    // A staff member's session claiming the owner role: the database checks the JWT user.
    await assert.rejects(
      changeContactOptOut(s.db.client, s.user("u_staff"), {
        organizationId: ORG_A,
        contactId: "c_a",
        actorRole: "owner",
        optedOut: false,
        reason: "Customer asked in writing",
      }),
      /owner or admin/,
    );
    // Extra fields (e.g. an owner's id) are not sent: the function has no actor parameter.
    await assert.rejects(
      reverseContactOptOut(s.user("u_staff"), {
        organizationId: ORG_A,
        contactId: "c_a",
        reason: "Customer asked in writing",
        p_actor_user_id: "u_owner",
      } as never),
      /owner or admin/,
    );
    assert.ok(s.userRpcArgs.every((a) => !("p_actor_user_id" in a)));
    // An admin of another workspace cannot clear this workspace's contact.
    await assert.rejects(
      reverseContactOptOut(s.user("u_admin_b"), {
        organizationId: ORG_A,
        contactId: "c_a",
        reason: "Customer asked in writing",
      }),
      /owner or admin/,
    );
    assert.equal(s.row("contacts", "c_a")["opted_out"], true);
    assert.equal(s.audit.length, 0);
  });

  test("the service-role client cannot reverse, and the app never uses it to", async () => {
    const s = setup();
    optOut(s);
    await assert.rejects(
      reverseContactOptOut(s.db.client, {
        organizationId: ORG_A,
        contactId: "c_a",
        reason: "Customer asked in writing",
      }),
    );
    assert.equal(s.row("contacts", "c_a")["opted_out"], true);
    s.serviceRoleRpcCalls.length = 0;
    await changeContactOptOut(s.db.client, s.user("u_owner"), {
      organizationId: ORG_A,
      contactId: "c_a",
      actorRole: "owner",
      optedOut: false,
      reason: "Customer asked in writing",
    });
    assert.deepEqual(s.serviceRoleRpcCalls, [], "reversal went through the user's client only");
    assert.equal(s.row("contacts", "c_a")["opted_out"], false);
  });
});
