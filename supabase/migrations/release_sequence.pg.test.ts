import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * REHEARSAL of the production release on a disposable PostgreSQL cluster: the schema as
 * production has it (history ends at 20261203090000), production-like grants, existing customers,
 * then each gate script in order and each rollback in reverse. At every stage the database is
 * driven the way the LIVE build (b60b77f) drives it, and the way the new build does, so the
 * compatibility claims in docs/production-migration-checklist.md are facts, not expectations.
 * Production is never contacted.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const root = join(migrationsDir, "..", "..");
const APPLIED = "20261203090000";
const PENDING = ["20261204090000", "20261205090000", "20261206090000"] as const;
const [SCOPE, SAVE, GUARD] = PENDING;
const FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();

const STANDIN = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[]);
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

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;
let gates = "";

function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}
const exec = (sql: string) => execSql!(sql);
const must = (sql: string) => {
  const r = exec(sql);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
function value(query: string): string {
  const out = must(`\\pset format unaligned\n\\pset tuples_only on\n${query}`);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(Output format|Tuples only)/.test(l))
    .join("\n");
}
const latest = () => value("SELECT max(version) FROM supabase_migrations.schema_migrations;");

/* ---------------- gate scripts, run as the query channel runs them ---------------- */
type Kind = "execute" | "rollback" | "verify";
const script = (kind: Kind, version: string) =>
  readFileSync(join(gates, `gate-outbound-${kind}-${version}.sql`), "utf8");
const phrase = (kind: Kind, version: string) =>
  kind === "rollback"
    ? `ROLL BACK ${version}`
    : `APPLY ${version}${version === GUARD ? " AFTER THE NEW WORKER SERVES ALL TRAFFIC" : ""}`;
const APPROVAL = "SELECT set_config('gate_outbound.operator_approval', '', true);";
const approved = (kind: "execute" | "rollback", version: string, text = phrase(kind, version)) => {
  const sql = script(kind, version);
  assert.equal(sql.split(APPROVAL).length, 2, "one approval line");
  return sql.replace(APPROVAL, APPROVAL.replace("''", `'${text}'`));
};
const asOne = (sql: string) => exec(`BEGIN;\n${sql}\nCOMMIT;`);
function apply(version: string) {
  const r = asOne(approved("execute", version));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"existing_data_unchanged" : true/);
  assert.equal(latest(), version);
  const v = exec(script("verify", version));
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /"all_pass" : true/);
  assert.match(v.stdout, /"transaction_read_only" : "on"/);
}
function undo(version: string) {
  const r = asOne(approved("rollback", version));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"objects_absent" : true/);
  assert.match(r.stdout, /"existing_data_unchanged" : true/);
}
function refused(sql: string, reason: RegExp, oneTransaction = true) {
  const before = [latest(), schema()];
  const r = oneTransaction ? asOne(sql) : exec(`\\set ON_ERROR_STOP on\n${sql}`);
  assert.notEqual(r.status, 0, "expected a refusal");
  assert.match(r.stderr, reason);
  assert.deepEqual([latest(), schema()], before, "nothing changed");
}
/** Table locks that make other sessions wait, as a script holds them just before it commits. */
const locks = (sql: string) =>
  value(`BEGIN;
\\o /dev/null
${sql}
\\o
SELECT coalesce(string_agg(DISTINCT c.relname || ':' || l.mode, ',' ORDER BY c.relname || ':' || l.mode), '')
  FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
 WHERE l.pid = pg_backend_pid() AND c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
   AND l.mode IN ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock');
ROLLBACK;`)
    .split("\n")
    .filter((line) => !/^(BEGIN|ROLLBACK)$/.test(line))
    .join("");
const source = (path: string) => readFileSync(join(root, path), "utf8");
const migration = (version: string) =>
  source(`supabase/migrations/${FILES.find((f) => f.startsWith(version))!}`);

/** The objects the pending migrations add. */
const schema = () =>
  value(`SELECT concat_ws(',',
    (SELECT string_agg(column_name, '+' ORDER BY column_name) FROM information_schema.columns
      WHERE table_name = 'operator_bridge_tokens' AND column_name IN ('agent_role','organization_id','run_id')),
    to_regprocedure('public.save_business_setup(uuid, jsonb, jsonb)')::text,
    to_regprocedure('public.one_setup_per_customer()')::text,
    (SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%one_per_customer'));`);

/* ---------------- how the application drives the database ---------------- */
interface Customer {
  org: string;
  user: string;
}
function customer(): Customer {
  const c = { org: randomUUID(), user: randomUUID() };
  must(`INSERT INTO auth.users (id) VALUES ('${c.user}');
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${c.org}', 'C', '${c.user}');
    INSERT INTO public.organization_members (organization_id, user_id, role)
      VALUES ('${c.org}', '${c.user}', 'owner') ON CONFLICT DO NOTHING;`);
  return c;
}
/** One browser request: its own transaction, as the signed-in member. */
const request = (c: Customer, sql: string) =>
  exec(
    `SET ROLE authenticated;\nSELECT set_config('request.jwt.claim.sub', '${c.user}', false);\n${sql}`,
  );

/**
 * The LIVE wizard (b60b77f app.onboarding.tsx finish()): separate requests; it stops on a failed
 * business or hours insert and ignores the result of every later one.
 */
function liveWizard(c: Customer, options: { hoursFail?: boolean } = {}) {
  const business = randomUUID();
  const first = request(
    c,
    `INSERT INTO public.businesses (id, organization_id, name, business_type) VALUES ('${business}', '${c.org}', 'Live', 'dental_clinic');`,
  );
  if (first.status !== 0) return { ok: false, failed: "businesses", error: first.stderr };
  const interval = options.hoursFail
    ? '{"start":"19:00","end":"09:00"}'
    : '{"start":"09:00","end":"19:00"}';
  const hours = request(
    c,
    `INSERT INTO public.business_hours (organization_id, business_id, day_of_week, is_closed, intervals)
     SELECT '${c.org}', '${business}', d, false, '[${interval}]' FROM generate_series(0, 6) d;`,
  );
  if (hours.status !== 0) return { ok: false, failed: "business_hours", error: hours.stderr };
  request(
    c,
    `INSERT INTO public.services (organization_id, business_id, name) VALUES ('${c.org}', '${business}', 'Cleaning');`,
  );
  const agent = request(
    c,
    `INSERT INTO public.agent_configs (organization_id, business_id, agent_name, primary_language, voice_id, greetings, capabilities, objectives)
     VALUES ('${c.org}', '${business}', 'Aria', 'en-IN', 'simran', '{}', '{"capture_lead": true}', ARRAY['answer_questions']);`,
  );
  request(c, `UPDATE public.organizations SET onboarding_completed = true WHERE id = '${c.org}';`);
  return { ok: true, failed: null, error: agent.stderr, agentSaved: agent.status === 0 };
}
/** The NEW wizard: one call. */
const newWizard = (c: Customer) =>
  request(
    c,
    `SELECT public.save_business_setup('${c.org}',
      '{"business":{"name":"New","business_type":"dental_clinic"},"hours":[],"agent":{}}', '{}');`,
  );
const rows = (c: Customer) =>
  value(
    `SELECT (SELECT count(*) FROM public.businesses WHERE organization_id = '${c.org}') || '/' ||
            (SELECT count(*) FROM public.agent_configs WHERE organization_id = '${c.org}');`,
  );
/** The LIVE build's operator-bridge token insert (b60b77f issueBridgeToken). */
const liveToken = () =>
  exec(`SET ROLE service_role;
    INSERT INTO public.operator_bridge_tokens (token_hash, token_prefix, created_by, expires_at)
    VALUES ('${randomUUID()}', 'cbr_live', '${randomUUID()}', now() + interval '8 hours');`);

/** Every row of the customers that existed before the release. */
const existing: Customer[] = [];
const fingerprint = () => {
  const ids = existing.map((c) => `'${c.org}'`).join(",");
  return value(
    `SELECT md5(concat_ws('|', ${[
      "organizations",
      "businesses",
      "business_hours",
      "services",
      "faqs",
      "business_rules",
      "agent_configs",
      "phone_numbers",
      "provisioning_runs",
    ]
      .map(
        (t) =>
          `(SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY x.id) FROM public.${t} x WHERE ${t === "organizations" ? "x.id" : "x.organization_id"} IN (${ids}))`,
      )
      .join(", ")}));`,
  );
};
const checks = () => {
  const r = exec(
    `\\pset format unaligned\n\\pset tuples_only on\n${readFileSync(join(root, "docs", "production-readonly-checks.sql"), "utf8")}`,
  );
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n");
  const start = lines.findIndex((l) => l.startsWith("{"));
  const end = lines.findIndex((l) => l.trim() === "ROLLBACK");
  return {
    text: r.stdout,
    report: JSON.parse(lines.slice(start, end < 0 ? undefined : end).join("\n")),
  };
};

before(() => {
  const boot = bootstrapCluster();
  if (!boot.ok) {
    skipReason = boot.reason;
    return;
  }
  cluster = boot.cluster;
  execSql = makeExecSql(cluster);
  unregister = registerSignalCleanup(() => cluster);
  let r = execSql(STANDIN);
  for (const file of FILES.filter((f) => f.slice(0, 14) <= APPLIED)) {
    if (r.status !== 0) break;
    r = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\n
      INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('${file.slice(0, 14)}');\nCOMMIT;`);
    if (r.status !== 0) r.stderr = `${file}: ${r.stderr}`;
  }
  if (r.status !== 0) {
    setupFailure = r.stderr;
    return;
  }
  const system = value("SELECT system_identifier::text FROM pg_control_system();");
  gates = mkdtempSync(join(tmpdir(), "release-gates-"));
  for (const version of PENDING) {
    const built = spawnSync(
      process.execPath,
      [
        join(root, "scripts", "build-gate-outbound-package.mjs"),
        version,
        "--system-id",
        system,
        "--database",
        value("SELECT current_database();"),
        "--out",
        gates,
      ],
      { encoding: "utf8" },
    );
    if (built.status !== 0) {
      setupFailure = `gate build ${version}: ${built.stderr}`;
      return;
    }
  }
  // Existing customers: a live one, one with duplicate businesses, one half set up.
  const [liveOne, duplicates, half] = [customer(), customer(), customer()];
  existing.push(liveOne, duplicates, half);
  liveWizard(liveOne);
  liveWizard(duplicates, { hoursFail: true });
  liveWizard(duplicates);
  liveWizard(half, { hoursFail: true });
  must(`INSERT INTO public.phone_numbers (organization_id, agent_config_id, e164, provider, status, inbound_enabled, provider_deployment_id)
      SELECT organization_id, id, '+917900001234', 'sarvam', 'active', true, 'dep-live' FROM public.agent_configs
       WHERE organization_id = '${liveOne.org}';
    UPDATE public.agent_configs SET sarvam_app_id = 'Live-app-1', sarvam_app_version = 3 WHERE organization_id = '${liveOne.org}';
    INSERT INTO public.provisioning_runs (organization_id, trigger, status, finished_at)
      VALUES ('${liveOne.org}', 'setup_fee', 'failed', now());`);
});
after(() => {
  unregister?.();
  if (cluster) teardownCluster(cluster);
});

describe("release rehearsal", () => {
  let baseline = "";

  test("before: production's state, and the read-only checks describe it without private data", (t) => {
    if (!ready(t)) return;
    baseline = fingerprint();
    assert.equal(latest(), APPLIED);
    assert.equal(rows(existing[1]!), "2/1", "the live wizard's own retry duplicates the business");
    assert.equal(liveToken().status, 0);
    const { report, text } = checks();
    assert.equal(report.identity.latest_migration, APPLIED);
    assert.equal(report.identity.transaction_read_only, "on");
    assert.equal(report.multiple_businesses.length, 1);
    assert.deepEqual(report.business_without_receptionist, [existing[2]!.org]);
    assert.equal(report.numbers[0].number_ending, "....1234");
    assert.equal(report.live_mapping_differences.length, 1);
    assert.equal(report.bridge_tokens.live_without_scope, 1);
    assert.doesNotMatch(text, /\+91\d{10}|cbr_/);
    assert.equal(report.campaigns.dialled_when_switch_on, 0);
    // What the release must see before dispatch is switched off.
    const [running, paused] = [customer(), customer()];
    must(`INSERT INTO public.campaigns (organization_id, name, status) VALUES
        ('${running.org}', 'r', 'running'), ('${paused.org}', 'p', 'paused');`);
    const after = checks().report;
    assert.equal(after.campaigns.dialled_when_switch_on, 1);
    assert.equal(after.campaigns.can_be_launched_by_customer, 1);
    assert.deepEqual(
      after.campaigns_by_status.map((c: { status: string; n: number }) => [c.status, c.n]),
      [
        ["paused", 1],
        ["running", 1],
      ],
    );
    assert.equal(after.contacts_waiting_in_running_campaigns, 0);
    assert.equal(after.outbound_calls_unfinished, 0);
    assert.deepEqual(after.outbound_enabled_numbers, []);
  });

  test("every apply script refuses: no approval, wrong phrase, wrong database, wrong order, not one transaction", (t) => {
    if (!ready(t)) return;
    refused(script("execute", SCOPE), /NOT_APPROVED/);
    refused(approved("execute", SCOPE, "yes"), /NOT_APPROVED/);
    refused(approved("execute", SCOPE, `APPLY ${SAVE}`), /NOT_APPROVED/);
    refused(
      approved("execute", SCOPE).replace(
        /IS DISTINCT FROM '\d+' THEN/,
        "IS DISTINCT FROM '1' THEN",
      ),
      /WRONG_DATABASE/,
    );
    refused(approved("execute", SAVE), /UNEXPECTED_HISTORY/);
    refused(approved("execute", GUARD), /UNEXPECTED_HISTORY/);
    // Statement by statement, as a careless client would send it.
    refused(approved("execute", SCOPE), /NOT_ONE_TRANSACTION/, false);
  });

  test("an unexpected schema is refused", (t) => {
    if (!ready(t)) return;
    must("ALTER TABLE public.operator_bridge_tokens ADD COLUMN agent_role text;");
    refused(approved("execute", SCOPE), /OBJECTS_ALREADY_EXIST/);
    must("ALTER TABLE public.operator_bridge_tokens DROP COLUMN agent_role;");
  });

  test("step 1, token scope: customers unaffected; the live build can no longer issue tokens", (t) => {
    if (!ready(t)) return;
    assert.equal(
      locks(migration(SCOPE)),
      "operator_bridge_tokens:AccessExclusiveLock,operator_bridge_tokens:ShareLock,operator_bridge_tokens:ShareRowExclusiveLock,organizations:ShareRowExclusiveLock,provisioning_runs:ShareLock,provisioning_runs:ShareRowExclusiveLock",
    );
    apply(SCOPE);
    refused(approved("execute", SCOPE), /UNEXPECTED_HISTORY/);
    assert.match(liveToken().stderr, /operator_bridge_tokens_scoped/);
    assert.equal(
      value("SELECT count(*) FROM public.operator_bridge_tokens WHERE revoked_at IS NULL;"),
      "0",
    );
    const c = customer();
    liveWizard(c, { hoursFail: true });
    assert.equal(liveWizard(c).ok, true);
    assert.equal(fingerprint(), baseline);
  });

  test("step 2, save function: the live wizard behaves exactly as before, retry included", (t) => {
    if (!ready(t)) return;
    assert.equal(locks(migration(SAVE)), "");
    apply(SAVE);
    const c = customer();
    assert.equal(liveWizard(c, { hoursFail: true }).failed, "business_hours");
    const retry = liveWizard(c);
    assert.deepEqual([retry.ok, retry.agentSaved, rows(c)], [true, true, "2/1"]);
    const fresh = customer();
    assert.equal(newWizard(fresh).status, 0);
    assert.equal(rows(fresh), "1/1");
    assert.equal(fingerprint(), baseline);
  });

  test("why the guard is a separate, later step: applied early it strands a live-wizard retry", (t) => {
    if (!ready(t)) return;
    assert.equal(
      locks(migration(GUARD)),
      "agent_configs:ShareRowExclusiveLock,businesses:ShareRowExclusiveLock",
    );
    apply(GUARD);
    const c = customer();
    assert.equal(liveWizard(c).ok, true, "a first save that works is unaffected");
    const stuck = customer();
    liveWizard(stuck, { hoursFail: true });
    const retry = liveWizard(stuck);
    assert.equal(retry.failed, "businesses");
    assert.match(retry.error, /BUSINESS_SETUP_EXISTS/);
    assert.equal(rows(stuck), "1/0");
    // The new build completes that same customer.
    const done = newWizard(stuck);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(rows(stuck), "1/1");
    assert.equal(fingerprint(), baseline);
  });

  test("rollback runs newest first only, with approval", (t) => {
    if (!ready(t)) return;
    refused(approved("rollback", SAVE), /UNEXPECTED_HISTORY/);
    refused(approved("rollback", SCOPE), /UNEXPECTED_HISTORY/);
    refused(script("rollback", GUARD), /NOT_APPROVED/);
    refused(approved("rollback", GUARD, `APPLY ${GUARD}`), /NOT_APPROVED/);
  });

  test("removing the guard restores the live wizard's behaviour; the new one is unaffected", (t) => {
    if (!ready(t)) return;
    assert.equal(
      locks(source("docs/production-rollback-20261206090000-business-setup-guard.sql")),
      "agent_configs:AccessExclusiveLock,businesses:AccessExclusiveLock",
    );
    undo(GUARD);
    const c = customer();
    liveWizard(c, { hoursFail: true });
    assert.equal(liveWizard(c).ok, true);
    assert.equal(newWizard(customer()).status, 0);
    assert.equal(fingerprint(), baseline);
  });

  test("removing the function leaves the live wizard working and breaks only the new one", (t) => {
    if (!ready(t)) return;
    assert.equal(
      locks(source("docs/production-rollback-20261205090000-business-setup-save.sql")),
      "",
    );
    undo(SAVE);
    assert.equal(liveWizard(customer()).agentSaved, true);
    assert.match(newWizard(customer()).stderr, /does not exist/);
    assert.equal(fingerprint(), baseline);
  });

  test("with the new build's tokens live, the scope rollback revokes them before dropping the scope", (t) => {
    if (!ready(t)) return;
    const c = existing[2]!;
    must(`WITH job AS (INSERT INTO public.provisioning_runs (organization_id, trigger, status)
        VALUES ('${c.org}', 'customer_activate', 'waiting') RETURNING id)
      INSERT INTO public.operator_bridge_tokens (token_hash, token_prefix, created_by, expires_at, organization_id, run_id, agent_role)
      SELECT 'new-build', 'cbr_new', '${c.user}', now() + interval '1 hour', '${c.org}', id, 'inbound' FROM job;`);
    assert.equal(
      locks(source("docs/production-rollback-20261204090000-operator-bridge-token-scope.sql")),
      "operator_bridge_tokens:AccessExclusiveLock,organizations:AccessExclusiveLock,provisioning_runs:AccessExclusiveLock",
    );
    undo(SCOPE);
    assert.equal(latest(), APPLIED);
    assert.equal(
      value("SELECT count(*) FROM public.operator_bridge_tokens WHERE revoked_at IS NULL;"),
      "0",
      "nothing the older build would accept for every customer",
    );
    assert.equal(liveToken().status, 0);
  });

  test("the whole sequence applies again after a full rollback", (t) => {
    if (!ready(t)) return;
    must("UPDATE public.operator_bridge_tokens SET revoked_at = now() WHERE revoked_at IS NULL;");
    for (const version of PENDING) apply(version);
    assert.equal(latest(), GUARD);
    assert.equal(checks().report.bridge_tokens.live_without_scope, 0);
  });
});

describe("the committed production scripts", () => {
  for (const version of PENDING)
    test(`${version}: generated from the current files, unapproved, and pinned to production`, () => {
      const dir = mkdtempSync(join(tmpdir(), "release-check-"));
      const built = spawnSync(
        process.execPath,
        [join(root, "scripts", "build-gate-outbound-package.mjs"), version, "--out", dir],
        { encoding: "utf8" },
      );
      assert.equal(built.status, 0, built.stderr);
      for (const kind of ["execute", "rollback", "verify"]) {
        const name = `gate-outbound-${kind}-${version}.sql`;
        const committed = readFileSync(join(root, "docs", name), "utf8");
        assert.equal(committed, readFileSync(join(dir, name), "utf8"), name);
        assert.match(committed, /7678069749886157684/);
        assert.doesNotMatch(
          committed,
          /service_role_key|SUPABASE_ACCESS_TOKEN|password|postgres:\/\//i,
        );
        if (kind !== "verify") {
          assert.ok(committed.includes(APPROVAL), "committed unapproved");
          assert.match(committed, /SET LOCAL lock_timeout = '5s'/);
        }
      }
    });
});
