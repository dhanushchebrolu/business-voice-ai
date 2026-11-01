import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
 * 20261029090000_whatsapp_vobiz_reliability on a disposable cluster: every
 * migration replayed in order with production-like privileges, existing
 * rows seeded before it, then checked as the real roles — the BYON claim
 * function's hourly limit (including genuinely concurrent sessions), that
 * browsers can't read or claim verifications, the provider-message-id
 * backfill and uniqueness, that other providers' webhook rows are
 * untouched, that a second run changes nothing, and that it applies on a
 * database without 20261028090000 (not yet applied in production).
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const FIX = "20261029090000_whatsapp_vobiz_reliability.sql";
const NOT_IN_PRODUCTION = "20261028090000_whatsapp_clickai_number_inventory.sql";
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();

const STANDIN = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
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
`;
// Roles are cluster-wide; the second database only needs the schemas.
const STANDIN_SECOND_DB = STANDIN.replace(/^CREATE ROLE .*$/gm, "");

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const CONN_A = randomUUID();
const CONN_B = randomUUID();
const CONV_A = randomUUID();
const CONV_B = randomUUID();
const MSG_UNIQUE = randomUUID();
const MSG_DUP_1 = randomUUID();
const MSG_DUP_2 = randomUUID();

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;

const sql = (statement: string): RunResult => execSql!(statement);

function value(statement: string): string {
  const r = sql(`\\pset format unaligned\n\\pset tuples_only on\n${statement}`);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n").pop()!.trim();
}

function ok(statement: string, message = statement) {
  const r = sql(statement);
  assert.equal(r.status, 0, `${message}\n${r.stderr}`);
}

function refused(statement: string, pattern: RegExp, message = statement) {
  const r = sql(statement);
  assert.notEqual(r.status, 0, `${message} (expected a refusal)`);
  assert.match(r.stderr, pattern, message);
}

function asRole(role: string, statement: string): RunResult {
  return sql(`BEGIN;\nSET LOCAL ROLE ${role};\n${statement}\nCOMMIT;`);
}

function execSqlAsync(statement: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const c = cluster!;
    const args = [
      "-h",
      c.sockDir,
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-X",
      "-f",
      "-",
    ];
    const child = c.useSu
      ? spawn("su", ["postgres", "-c", [`${c.pgBinDir}psql`, ...args].join(" ")])
      : spawn(`${c.pgBinDir}psql`, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    child.stdin.write(statement);
    child.stdin.end();
  });
}

const claim = (org: string, limit = 5) =>
  `SELECT public.claim_whatsapp_byon_verification('${org}', '+919876543210', 'sms', ${limit}, 3600);`;

const SEED_BEFORE_FIX = `
INSERT INTO public.organizations (id, name, owner_id) VALUES
  ('${ORG_A}', 'Smile Dental', '${OWNER_A}'), ('${ORG_B}', 'Other Clinic', '${OWNER_B}');
INSERT INTO public.whatsapp_connections (id, organization_id, waba_id, phone_number_id, status, provider, vobiz_channel_id)
  VALUES ('${CONN_A}', '${ORG_A}', '1001', 'pn-a', 'connected', 'vobiz', 'ch-a'),
         ('${CONN_B}', '${ORG_B}', '1002', 'pn-b', 'connected', 'vobiz', 'ch-b');
INSERT INTO public.whatsapp_conversations (id, organization_id, whatsapp_connection_id, wa_id)
  VALUES ('${CONV_A}', '${ORG_A}', '${CONN_A}', '919800000001'),
         ('${CONV_B}', '${ORG_B}', '${CONN_B}', '919800000002');
INSERT INTO public.whatsapp_messages (id, organization_id, whatsapp_connection_id, conversation_id, direction, message_type, status, metadata) VALUES
  ('${MSG_UNIQUE}', '${ORG_A}', '${CONN_A}', '${CONV_A}', 'outbound', 'text', 'sent', '{"vobiz_message_id":"vmsg-1"}'),
  ('${MSG_DUP_1}', '${ORG_A}', '${CONN_A}', '${CONV_A}', 'outbound', 'text', 'sent', '{"vobiz_message_id":"vmsg-dup"}'),
  ('${MSG_DUP_2}', '${ORG_A}', '${CONN_A}', '${CONV_A}', 'outbound', 'text', 'sent', '{"vobiz_message_id":"vmsg-dup"}');
INSERT INTO public.webhook_events (provider, event_id, event_type, payload, processed_at)
  VALUES ('razorpay', 'pay-evt-1', 'payment.captured', '{}', now());
`;

before(() => {
  const result = bootstrapCluster();
  if (!result.ok) {
    skipReason = result.reason;
    return;
  }
  cluster = result.cluster;
  execSql = makeExecSql(cluster);
  unregister = registerSignalCleanup(() => cluster);
  const standin = sql(STANDIN);
  if (standin.status !== 0) {
    setupFailure = `stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of MIGRATIONS) {
    if (file === FIX) {
      const seed = sql(SEED_BEFORE_FIX);
      if (seed.status !== 0) {
        setupFailure = `seed failed: ${seed.stderr}`;
        return;
      }
    }
    const applied = sql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
});

after(() => {
  unregister?.();
  if (cluster) teardownCluster(cluster);
});

function pgTest(name: string, fn: (t: TestContext) => void | Promise<void>) {
  test(name, async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    if (setupFailure) {
      assert.fail(`PostgreSQL is available, but setup failed — a real failure: ${setupFailure}`);
    }
    await fn(t);
  });
}

describe("20261029090000: existing data", () => {
  pgTest(
    "Vobiz's message id is backfilled where unique; an ambiguous duplicate is left for review",
    () => {
      assert.equal(
        value(
          `SELECT provider_message_id FROM public.whatsapp_messages WHERE id = '${MSG_UNIQUE}';`,
        ),
        "vmsg-1",
      );
      assert.equal(
        value(
          `SELECT count(*) FROM public.whatsapp_messages WHERE id IN ('${MSG_DUP_1}','${MSG_DUP_2}') AND provider_message_id IS NULL;`,
        ),
        "2",
      );
    },
  );

  pgTest("other providers' webhook rows are untouched (attempts 0, no retry scheduled)", () => {
    assert.equal(
      value(
        `SELECT attempts || ',' || coalesce(next_attempt_at::text, 'null') || ',' || (processed_at IS NOT NULL)
           FROM public.webhook_events WHERE provider = 'razorpay';`,
      ),
      "0,null,true",
    );
  });

  pgTest("a second run of the migration changes nothing and doesn't fail", () => {
    const before = value(
      `SELECT count(*) || ':' || coalesce(string_agg(provider_message_id, ',' ORDER BY id), '') FROM public.whatsapp_messages;`,
    );
    ok(`BEGIN;\n${readFileSync(join(migrationsDir, FIX), "utf8")}\nCOMMIT;`, "re-run");
    const afterRun = value(
      `SELECT count(*) || ':' || coalesce(string_agg(provider_message_id, ',' ORDER BY id), '') FROM public.whatsapp_messages;`,
    );
    assert.equal(afterRun, before);
  });
});

describe("20261029090000: provider message id", () => {
  pgTest("unique per connection, free across connections", () => {
    refused(
      `INSERT INTO public.whatsapp_messages (organization_id, whatsapp_connection_id, conversation_id, direction, message_type, status, provider_message_id)
       VALUES ('${ORG_A}', '${CONN_A}', '${CONV_A}', 'outbound', 'text', 'sent', 'vmsg-1');`,
      /idx_whatsapp_messages_connection_provider_id/,
    );
    ok(
      `INSERT INTO public.whatsapp_messages (organization_id, whatsapp_connection_id, conversation_id, direction, message_type, status, provider_message_id)
       VALUES ('${ORG_B}', '${CONN_B}', '${CONV_B}', 'outbound', 'text', 'sent', 'vmsg-1');`,
    );
  });
});

describe("20261029090000: BYON verification attempts", () => {
  pgTest("browsers can neither read nor write verifications, nor claim one", () => {
    for (const role of ["anon", "authenticated"]) {
      const read = asRole(role, `SELECT * FROM public.whatsapp_byon_verifications;`);
      assert.notEqual(read.status, 0, `${role} read`);
      assert.match(read.stderr, /permission denied/);
      const write = asRole(
        role,
        `INSERT INTO public.whatsapp_byon_verifications (organization_id, phone_number, method) VALUES ('${ORG_A}', '+919876543210', 'sms');`,
      );
      assert.notEqual(write.status, 0, `${role} write`);
      const call = asRole(role, claim(ORG_A));
      assert.notEqual(call.status, 0, `${role} claim`);
      assert.match(call.stderr, /permission denied/);
    }
    assert.equal(
      value(
        `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.whatsapp_byon_verifications'::regclass;`,
      ),
      "t",
    );
  });

  pgTest(
    "the hourly limit: N claims, then NULL; refusals and old rows don't count; organizations are separate",
    () => {
      ok(`DELETE FROM public.whatsapp_byon_verifications;`);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = asRole(
          "service_role",
          `\\pset format unaligned\n\\pset tuples_only on\n${claim(ORG_A, 3)}`,
        );
        assert.equal(r.status, 0, r.stderr);
        ids.push(r.stdout.trim().split("\n").pop()!.trim());
      }
      assert.ok(
        ids.every((id) => /^[0-9a-f-]{36}$/.test(id)),
        ids.join(","),
      );
      assert.equal(value(`SET ROLE service_role; ${claim(ORG_A, 3)}`), "", "limit reached → NULL");
      // A refusal frees its slot.
      ok(
        `UPDATE public.whatsapp_byon_verifications SET state = 'rejected' WHERE id = '${ids[0]}';`,
      );
      assert.match(value(`SET ROLE service_role; ${claim(ORG_A, 3)}`), /^[0-9a-f-]{36}$/);
      // Older than the window: no longer counted.
      ok(
        `UPDATE public.whatsapp_byon_verifications SET created_at = now() - interval '2 hours' WHERE organization_id = '${ORG_A}';`,
      );
      assert.match(value(`SET ROLE service_role; ${claim(ORG_A, 3)}`), /^[0-9a-f-]{36}$/);
      // Another organization has its own allowance.
      assert.match(value(`SET ROLE service_role; ${claim(ORG_B, 3)}`), /^[0-9a-f-]{36}$/);
    },
  );

  pgTest("concurrent sessions can't exceed the limit", async () => {
    ok(`DELETE FROM public.whatsapp_byon_verifications;`);
    const runs = await Promise.all(
      Array.from({ length: 12 }, () =>
        execSqlAsync(
          `BEGIN; SET LOCAL ROLE service_role; SELECT pg_sleep(0.05); ${claim(ORG_A, 5)} COMMIT;`,
        ),
      ),
    );
    for (const r of runs) assert.equal(r.status, 0, r.stderr);
    assert.equal(
      value(
        `SELECT count(*) FROM public.whatsapp_byon_verifications WHERE organization_id = '${ORG_A}';`,
      ),
      "5",
    );
  });

  pgTest("states, methods and numbers are constrained; nothing secret has a column", () => {
    refused(
      `INSERT INTO public.whatsapp_byon_verifications (organization_id, phone_number, method, state) VALUES ('${ORG_A}', '+919876543210', 'sms', 'delivered');`,
      /check/i,
      "there is no 'delivered' state",
    );
    refused(
      `INSERT INTO public.whatsapp_byon_verifications (organization_id, phone_number, method) VALUES ('${ORG_A}', '919876543210', 'sms');`,
      /check/i,
    );
    refused(
      `INSERT INTO public.whatsapp_byon_verifications (organization_id, phone_number, method) VALUES ('${ORG_A}', '+919876543210', 'email');`,
      /check/i,
    );
    const columns = value(
      `SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_byon_verifications';`,
    );
    assert.doesNotMatch(columns, /otp|code|token|secret/);
  });
});

describe("20261029090000: production order", () => {
  pgTest("applies on a database where 20261028090000 has not been applied", () => {
    ok(`CREATE DATABASE without_inventory;`);
    const setup = sql(`\\c without_inventory\n${STANDIN_SECOND_DB}`);
    assert.equal(setup.status, 0, setup.stderr);
    for (const file of MIGRATIONS) {
      if (file === NOT_IN_PRODUCTION) continue;
      const applied = sql(
        `\\c without_inventory\nBEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`,
      );
      assert.equal(applied.status, 0, `${file}: ${applied.stderr}`);
    }
    const r = sql(
      `\\c without_inventory\n\\pset format unaligned\n\\pset tuples_only on\nSELECT to_regclass('public.whatsapp_byon_verifications') IS NOT NULL;`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").pop(), "t");
  });
});
