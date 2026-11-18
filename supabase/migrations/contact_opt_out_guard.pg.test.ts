import { test, describe, before, after, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapCluster,
  makeExecSql,
  registerSignalCleanup,
  teardownCluster,
  type Cluster,
  type RunResult,
} from "./pg-test-cluster.ts";

/**
 * REAL-PostgreSQL coverage for 20261118120000_contact_opt_out_guard.sql:
 * contacts.opted_out cannot be cleared by a member or the service role
 * directly, a repeated opt-out keeps the first record, and the only way back
 * is reverse_contact_opt_out (the signed-in owner/admin from the JWT, a reason,
 * an audit_logs row, one transaction), which the service role cannot call.
 * Opted-out contacts cannot be deleted, renumbered, moved or truncated away.
 * Re-runnable.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261118120000_contact_opt_out_guard.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();

const SUPABASE_STANDIN = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY);
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated' $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
`;

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregisterSignalCleanup: (() => void) | null = null;

const OWNER = randomUUID();
const ADMIN = randomUUID();
const STAFF = randomUUID();
const ORG = randomUUID();
const CONTACT = randomUUID();

function as(role: "service_role" | "authenticated", user: string | null, sql: string): RunResult {
  const claim = user ? `SET request.jwt.claim.sub = '${user}';\n` : "";
  return execSql!(
    `\\pset format unaligned\n\\pset tuples_only on\n${claim}SET ROLE ${role};\n${sql}`,
  );
}
function rows(sql: string): string[] {
  const r = as("service_role", null, sql);
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr}\n${sql}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only") && l !== "SET",
    );
}
/** Database-owner statements (test setup only), as migrations and admins run them. */
function ownerRows(sql: string): string[] {
  const r = execSql!(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`);
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr}\n${sql}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}
const optOutState = () =>
  rows(
    `SELECT opted_out || '|' || coalesce(opted_out_reason, '-') FROM public.contacts WHERE id = '${CONTACT}';`,
  );

before(() => {
  const result = bootstrapCluster();
  if (!result.ok) {
    skipReason = result.reason;
    return;
  }
  cluster = result.cluster;
  execSql = makeExecSql(cluster);
  unregisterSignalCleanup = registerSignalCleanup(() => cluster);
  const standin = execSql(SUPABASE_STANDIN);
  if (standin.status !== 0) {
    setupFailure = `Supabase stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of MIGRATION_FILES.filter((f) => f < MIGRATION)) {
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  for (let i = 0; i < 2; i++) {
    const applied = execSql(
      `BEGIN;\n${readFileSync(join(migrationsDir, MIGRATION), "utf8")}\nCOMMIT;`,
    );
    if (applied.status !== 0) {
      setupFailure = `${MIGRATION} failed to apply (run ${i + 1}): ${applied.stderr}`;
      return;
    }
  }
  const seed = execSql(`
    INSERT INTO auth.users (id) VALUES ('${OWNER}'), ('${ADMIN}'), ('${STAFF}');
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'Clinic', '${OWNER}');
    INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
      ('${ORG}', '${ADMIN}', 'admin'), ('${ORG}', '${STAFF}', 'staff')
      ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role;
    INSERT INTO public.organization_members (organization_id, user_id, role)
      VALUES ('${ORG}', '${OWNER}', 'owner') ON CONFLICT (organization_id, user_id) DO NOTHING;
    INSERT INTO public.contacts (id, organization_id, phone, opted_out, opted_out_at, opted_out_reason)
      VALUES ('${CONTACT}', '${ORG}', '+919876500001', true, '2026-11-18T10:00:00Z', 'Requested during an outbound call');
  `);
  if (seed.status !== 0) setupFailure = `seed failed: ${seed.stderr}`;
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

describe("contacts do-not-call guard", () => {
  test("a member cannot clear do-not-call directly", (t) => {
    if (!ready(t)) return;
    const r = as(
      "authenticated",
      STAFF,
      `UPDATE public.contacts SET opted_out = false WHERE id = '${CONTACT}';`,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /do-not-call list/);
    assert.deepEqual(optOutState(), ["true|Requested during an outbound call"]);
  });

  test("the service role cannot clear it directly either", (t) => {
    if (!ready(t)) return;
    const r = as(
      "service_role",
      null,
      `UPDATE public.contacts SET opted_out = false, opted_out_reason = NULL WHERE id = '${CONTACT}';`,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /do-not-call list/);
  });

  test("a repeated opt-out keeps the first time and reason", (t) => {
    if (!ready(t)) return;
    rows(
      `UPDATE public.contacts SET opted_out = true, opted_out_at = now(), opted_out_reason = 'later' WHERE id = '${CONTACT}';`,
    );
    assert.deepEqual(
      rows(
        `SELECT opted_out_reason || '|' || (opted_out_at = '2026-11-18T10:00:00Z') FROM public.contacts WHERE id = '${CONTACT}';`,
      ),
      ["Requested during an outbound call|true"],
    );
  });

  const reverse = (id: string, reason: string) =>
    `SELECT public.reverse_contact_opt_out('${id}', '${ORG}', '${reason}');`;
  const asUser = (user: string, sql: string) => {
    const r = as("authenticated", user, sql);
    assert.equal(r.status, 0, r.stderr);
    return r;
  };

  test("the service role cannot call the reversal, even claiming an owner's identity", (t) => {
    if (!ready(t)) return;
    for (const claim of [null, OWNER]) {
      const r = as("service_role", claim, reverse(CONTACT, "Customer asked in writing"));
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /permission denied/);
    }
    assert.deepEqual(optOutState(), ["true|Requested during an outbound call"]);
  });

  test("there is no actor parameter to forge", (t) => {
    if (!ready(t)) return;
    const r = as(
      "authenticated",
      STAFF,
      `SELECT public.reverse_contact_opt_out('${CONTACT}', '${ORG}', '${OWNER}', 'Customer asked in writing');`,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not exist/);
    assert.deepEqual(optOutState(), ["true|Requested during an outbound call"]);
  });

  test("the reversal needs a signed-in owner/admin of this workspace and a reason, and is audited", (t) => {
    if (!ready(t)) return;
    const anonymous = as("authenticated", null, reverse(CONTACT, "Customer asked in writing"));
    assert.notEqual(anonymous.status, 0);
    assert.match(anonymous.stderr, /signed-in owner or admin/);
    const staff = as("authenticated", STAFF, reverse(CONTACT, "Customer asked in writing"));
    assert.notEqual(staff.status, 0);
    assert.match(staff.stderr, /owner or admin/);
    const noReason = as("authenticated", ADMIN, reverse(CONTACT, " ok "));
    assert.notEqual(noReason.status, 0);
    assert.match(noReason.stderr, /reason is required/);
    assert.deepEqual(optOutState(), ["true|Requested during an outbound call"]);

    asUser(ADMIN, reverse(CONTACT, "Customer asked in writing"));
    assert.deepEqual(optOutState(), ["false|-"]);
    assert.deepEqual(
      rows(
        `SELECT action || '|' || admin_user_id || '|' || reason || '|' || (old_value->>'opted_out_reason') || '|' || (new_value->>'actor_role')
           FROM public.audit_logs WHERE entity_id = '${CONTACT}';`,
      ),
      [
        `contact.opt_out_reversed|${ADMIN}|Customer asked in writing|Requested during an outbound call|admin`,
      ],
    );
    // The bypass setting does not outlive the reversal.
    rows(
      `UPDATE public.contacts SET opted_out = true, opted_out_reason = 'Requested during an outbound call' WHERE id = '${CONTACT}';`,
    );
    const r = as(
      "service_role",
      null,
      `UPDATE public.contacts SET opted_out = false WHERE id = '${CONTACT}';`,
    );
    assert.notEqual(r.status, 0);
  });

  test("an admin of another workspace cannot reverse this workspace's contact", (t) => {
    if (!ready(t)) return;
    const otherOrg = randomUUID();
    const otherAdmin = randomUUID();
    ownerRows(`INSERT INTO auth.users (id) VALUES ('${otherAdmin}');`);
    rows(
      `INSERT INTO public.organizations (id, name, owner_id) VALUES ('${otherOrg}', 'Elsewhere', '${otherAdmin}');`,
    );
    rows(
      `INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ('${otherOrg}', '${otherAdmin}', 'admin') ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'admin';`,
    );
    const r = as("authenticated", otherAdmin, reverse(CONTACT, "Customer asked in writing"));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /owner or admin/);
    assert.deepEqual(optOutState(), ["true|Requested during an outbound call"]);
  });

  test("a failed audit write rolls the reversal back (one transaction)", (t) => {
    if (!ready(t)) return;
    // Make the audit insert fail inside the function, then confirm nothing changed.
    ownerRows(
      `ALTER TABLE public.audit_logs ADD CONSTRAINT test_no_audit CHECK (action <> 'contact.opt_out_reversed') NOT VALID;`,
    );
    const r = as("authenticated", ADMIN, reverse(CONTACT, "Customer asked in writing"));
    ownerRows(`ALTER TABLE public.audit_logs DROP CONSTRAINT test_no_audit;`);
    assert.notEqual(r.status, 0);
    assert.deepEqual(optOutState(), ["true|Requested during an outbound call"]);
  });

  test("a duplicate reversal request changes nothing and writes no second audit row", (t) => {
    if (!ready(t)) return;
    const id = randomUUID();
    rows(
      `INSERT INTO public.contacts (id, organization_id, phone, opted_out) VALUES ('${id}', '${ORG}', '+919876500020', true);`,
    );
    asUser(OWNER, reverse(id, "Customer asked in writing"));
    asUser(OWNER, reverse(id, "Customer asked in writing"));
    assert.deepEqual(rows(`SELECT count(*) FROM public.audit_logs WHERE entity_id = '${id}';`), [
      "1",
    ]);
  });
});

describe("an opted-out number cannot be freed by deleting, renumbering or re-adding", () => {
  const DNC = randomUUID();
  const PHONE = "+919876500030";
  const seedDnc = () =>
    rows(
      `INSERT INTO public.contacts (id, organization_id, phone, opted_out, opted_out_reason)
         VALUES ('${DNC}', '${ORG}', '${PHONE}', true, 'Requested during an outbound call')
         ON CONFLICT (id) DO NOTHING;`,
    );
  const stillThere = () => rows(`SELECT opted_out::text FROM public.contacts WHERE id = '${DNC}';`);

  test("a member (staff or admin) cannot delete it", (t) => {
    if (!ready(t)) return;
    seedDnc();
    for (const user of [STAFF, ADMIN]) {
      const r = as("authenticated", user, `DELETE FROM public.contacts WHERE id = '${DNC}';`);
      assert.notEqual(r.status, 0, user);
      assert.match(r.stderr, /cannot be deleted/);
    }
    assert.deepEqual(stillThere(), ["true"]);
  });

  test("the service role cannot delete it, and TRUNCATE is refused", (t) => {
    if (!ready(t)) return;
    seedDnc();
    const del = as("service_role", null, `DELETE FROM public.contacts WHERE phone = '${PHONE}';`);
    assert.notEqual(del.status, 0);
    assert.match(del.stderr, /cannot be deleted/);
    const trunc = as("service_role", null, `TRUNCATE public.contacts CASCADE;`);
    assert.notEqual(trunc.status, 0);
    assert.match(trunc.stderr, /cannot be truncated/);
    assert.deepEqual(stillThere(), ["true"]);
  });

  test("its number and workspace cannot change", (t) => {
    if (!ready(t)) return;
    seedDnc();
    const renumber = as(
      "authenticated",
      ADMIN,
      `UPDATE public.contacts SET phone = '+919876500031' WHERE id = '${DNC}';`,
    );
    assert.notEqual(renumber.status, 0);
    assert.match(renumber.stderr, /number and workspace cannot change/);
    const other = randomUUID();
    rows(
      `INSERT INTO public.organizations (id, name, owner_id) VALUES ('${other}', 'Other', '${OWNER}');`,
    );
    const move = as(
      "service_role",
      null,
      `UPDATE public.contacts SET organization_id = '${other}' WHERE id = '${DNC}';`,
    );
    assert.notEqual(move.status, 0);
    assert.deepEqual(
      rows(`SELECT phone || '|' || organization_id FROM public.contacts WHERE id = '${DNC}';`),
      [`${PHONE}|${ORG}`],
    );
  });

  test("re-adding the same number in the same workspace fails; other changes keep the opt-out", (t) => {
    if (!ready(t)) return;
    seedDnc();
    const add = as(
      "authenticated",
      STAFF,
      `INSERT INTO public.contacts (organization_id, phone) VALUES ('${ORG}', '${PHONE}');`,
    );
    assert.notEqual(add.status, 0);
    assert.match(add.stderr, /duplicate key|unique/);
    // What a re-import does to an existing row: name and custom fields only.
    const update = as(
      "authenticated",
      STAFF,
      `UPDATE public.contacts SET name = 'Asha', custom_fields = '{"x":"1"}' WHERE id = '${DNC}';`,
    );
    assert.equal(update.status, 0, update.stderr);
    assert.deepEqual(stillThere(), ["true"]);
  });

  test("suppression is per workspace: another workspace's contact with the number is unaffected", (t) => {
    if (!ready(t)) return;
    seedDnc();
    const other = randomUUID();
    const theirs = randomUUID();
    rows(
      `INSERT INTO public.organizations (id, name, owner_id) VALUES ('${other}', 'Other clinic', '${OWNER}');`,
    );
    rows(
      `INSERT INTO public.contacts (id, organization_id, phone) VALUES ('${theirs}', '${other}', '${PHONE}');`,
    );
    assert.deepEqual(rows(`SELECT opted_out::text FROM public.contacts WHERE id = '${theirs}';`), [
      "false",
    ]);
    rows(`DELETE FROM public.contacts WHERE id = '${theirs}';`); // not opted out: deletable
    assert.deepEqual(stillThere(), ["true"]);
  });

  test("deleting a whole workspace still removes its opted-out contacts", (t) => {
    if (!ready(t)) return;
    const gone = randomUUID();
    const id = randomUUID();
    rows(
      `INSERT INTO public.organizations (id, name, owner_id) VALUES ('${gone}', 'Closing', '${OWNER}');`,
    );
    rows(
      `INSERT INTO public.contacts (id, organization_id, phone, opted_out) VALUES ('${id}', '${gone}', '${PHONE}', true);`,
    );
    rows(`DELETE FROM public.organizations WHERE id = '${gone}';`);
    assert.deepEqual(rows(`SELECT count(*) FROM public.contacts WHERE id = '${id}';`), ["0"]);
  });

  test("after the audited reversal the contact is an ordinary contact again", (t) => {
    if (!ready(t)) return;
    seedDnc();
    const r = as(
      "authenticated",
      ADMIN,
      `SELECT public.reverse_contact_opt_out('${DNC}', '${ORG}', 'Customer asked in writing');`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(stillThere(), ["false"]);
    rows(`DELETE FROM public.contacts WHERE id = '${DNC}';`);
    assert.deepEqual(stillThere(), []);
  });
});

/** One psql session run in the background, so two sessions can overlap. */
function execSqlAsync(sql: string): Promise<RunResult> {
  return new Promise((resolve) => {
    if (!cluster) {
      resolve({ status: 1, stdout: "", stderr: "cluster not ready" });
      return;
    }
    const args = [
      "-h",
      cluster.sockDir,
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-X",
      "-f",
      "-",
    ];
    const child = cluster.useSu
      ? spawn("su", ["postgres", "-c", [`${cluster.pgBinDir}psql`, ...args].join(" ")])
      : spawn(`${cluster.pgBinDir}psql`, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    child.stdin.write(sql);
    child.stdin.end();
  });
}

describe("concurrent sessions", () => {
  test("two overlapping reversals: the second waits on the row lock, then does nothing", async (t) => {
    if (!ready(t)) return;
    const id = randomUUID();
    rows(
      `INSERT INTO public.contacts (id, organization_id, phone, opted_out) VALUES ('${id}', '${ORG}', '+919876500040', true);`,
    );
    const call = `SELECT public.reverse_contact_opt_out('${id}', '${ORG}', 'Customer asked in writing');`;
    const [a, b] = await Promise.all([
      execSqlAsync(
        `SET request.jwt.claim.sub = '${ADMIN}';\nSET ROLE authenticated;\nBEGIN;\n${call}\nSELECT pg_sleep(1.5);\nCOMMIT;`,
      ),
      execSqlAsync(
        `SELECT pg_sleep(0.3);\nSET request.jwt.claim.sub = '${OWNER}';\nSET ROLE authenticated;\n${call}`,
      ),
    ]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(rows(`SELECT opted_out::text FROM public.contacts WHERE id = '${id}';`), [
      "false",
    ]);
    assert.deepEqual(
      rows(`SELECT admin_user_id::text FROM public.audit_logs WHERE entity_id = '${id}';`),
      [ADMIN],
      "exactly one audit row, from the session that changed it",
    );
  });

  test("a delete racing an opt-out waits, then sees the opt-out and is refused", async (t) => {
    if (!ready(t)) return;
    const id = randomUUID();
    rows(
      `INSERT INTO public.contacts (id, organization_id, phone, opted_out) VALUES ('${id}', '${ORG}', '+919876500041', false);`,
    );
    const [optOut, del] = await Promise.all([
      execSqlAsync(
        `SET ROLE service_role;\nBEGIN;\nUPDATE public.contacts SET opted_out = true, opted_out_reason = 'Requested during an outbound call' WHERE id = '${id}';\nSELECT pg_sleep(1.5);\nCOMMIT;`,
      ),
      execSqlAsync(
        `SELECT pg_sleep(0.3);\nSET request.jwt.claim.sub = '${STAFF}';\nSET ROLE authenticated;\nDELETE FROM public.contacts WHERE id = '${id}';`,
      ),
    ]);
    assert.equal(optOut.status, 0, optOut.stderr);
    assert.notEqual(del.status, 0, "the delete must not win the race");
    assert.match(del.stderr, /cannot be deleted/);
    assert.deepEqual(rows(`SELECT opted_out::text FROM public.contacts WHERE id = '${id}';`), [
      "true",
    ]);
  });
});
