import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
 * Shared Sarvam call slots (20261201090000), replayed against every migration on
 * a real PostgreSQL: the limit counts every customer's unfinished calls plus
 * live inbound calls, is enforced where the call row is written, and two
 * sessions racing for the last slot cannot both get it.
 */
const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const THIS = "20261201090000_shared_outbound_concurrency.sql";

const STANDIN = `
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
let unregister: (() => void) | null = null;
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const INBOUND_INTEGRATION = randomUUID();
const OUTBOUND_INTEGRATION = randomUUID();

function pgTest(name: string, fn: () => void | Promise<void>) {
  test(name, async (t: TestContext) => {
    if (setupFailure) assert.fail(setupFailure);
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    await fn();
  });
}

function rows(statement: string): string[] {
  const r = execSql!(`\\pset format unaligned\n\\pset tuples_only on\n${statement}`);
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr}\n${statement}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
}

/** [limit, in_use, free] as the server role reads it. */
function slots(): [number, number, number] {
  const line = rows(
    `SET ROLE service_role;
     SELECT slot_limit || '|' || in_use || '|' || free FROM public.outbound_concurrency();`,
  )
    .filter((l) => l.includes("|"))
    .at(-1)!;
  const [l, u, f] = line.split("|").map(Number);
  return [l!, u!, f!];
}

const insertSql = (o: {
  org?: string;
  provider?: string;
  direction?: string;
  status?: string;
  startedAgoMin?: number;
  id?: string;
}) =>
  `INSERT INTO public.call_logs (id, organization_id, provider, direction, status, started_at, ended_at)
   VALUES ('${o.id ?? randomUUID()}', '${o.org ?? ORG_A}', '${o.provider ?? "sarvam"}', '${o.direction ?? "outbound"}', '${o.status ?? "initiated"}',
           now() - interval '${o.startedAgoMin ?? 0} minutes', ${["completed", "failed", "no_answer", "busy", "cancelled"].includes(o.status ?? "") ? "now()" : "NULL"});`;
const addCall = (o: Parameters<typeof insertSql>[0] = {}) => rows(insertSql(o));
const clear = () =>
  rows(
    `DELETE FROM public.call_logs; DELETE FROM public.sarvam_agent_events; DELETE FROM public.platform_settings WHERE key = 'outbound.max_concurrent_calls';`,
  );
const setLimit = (value: string) =>
  rows(
    `INSERT INTO public.platform_settings (key, value) VALUES ('outbound.max_concurrent_calls', '${value}'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`,
  );

/** A second, independent database session (a real concurrent writer). */
function runAsync(sql: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = [
      "-h",
      cluster!.sockDir,
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-qAtX",
      "-f",
      "-",
    ];
    const child = cluster!.useSu
      ? spawn("su", ["postgres", "-c", [`${cluster!.pgBinDir}psql`, ...args].join(" ")])
      : spawn(`${cluster!.pgBinDir}psql`, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    child.stdin.write(sql);
    child.stdin.end();
  });
}

before(() => {
  const result = bootstrapCluster();
  if (!result.ok) {
    skipReason = result.reason;
    return;
  }
  cluster = result.cluster;
  execSql = makeExecSql(cluster);
  unregister = registerSignalCleanup(() => cluster);
  const standin = execSql(STANDIN);
  if (standin.status !== 0) {
    setupFailure = `stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of MIGRATIONS) {
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const biz = randomUUID();
  const bizB = randomUUID();
  const seed = execSql(`
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG_A}', 'Clinic A', '${randomUUID()}'), ('${ORG_B}', 'Clinic B', '${randomUUID()}');
    UPDATE public.organizations SET outbound_concurrency = 50; -- the per-customer cap is covered in customer_outbound_concurrency.pg.test.ts
    INSERT INTO public.businesses (id, organization_id, name, timezone) VALUES ('${biz}', '${ORG_A}', 'A', 'Asia/Kolkata'), ('${bizB}', '${ORG_B}', 'B', 'Asia/Kolkata');
    INSERT INTO public.agent_configs (organization_id, business_id) VALUES ('${ORG_A}', '${biz}'), ('${ORG_B}', '${bizB}') ON CONFLICT (business_id) DO NOTHING;
    INSERT INTO public.sarvam_agent_integrations (id, organization_id, agent_config_id, token_hash, token_prefix, role)
      SELECT '${INBOUND_INTEGRATION}', '${ORG_A}', id, '${randomUUID().replace(/-/g, "").repeat(2)}', 'cai_sv_', 'inbound' FROM public.agent_configs WHERE business_id = '${biz}';
    INSERT INTO public.sarvam_agent_integrations (id, organization_id, agent_config_id, token_hash, token_prefix, role)
      SELECT '${OUTBOUND_INTEGRATION}', '${ORG_B}', id, '${randomUUID().replace(/-/g, "").repeat(2)}', 'cai_sv_', 'outbound' FROM public.agent_configs WHERE business_id = '${bizB}';`);
  if (seed.status !== 0) setupFailure = `seed failed: ${seed.stderr}`;
});

after(() => {
  unregister?.();
  if (cluster) teardownCluster(cluster);
});

describe("shared Sarvam call slots", () => {
  pgTest("no calls: the default limit of 4, all free", () => {
    clear();
    assert.deepEqual(slots(), [4, 0, 4]);
  });

  pgTest("every customer's unfinished calls use the same slots", () => {
    clear();
    addCall({ org: ORG_A });
    addCall({ org: ORG_B, status: "ringing" });
    addCall({ org: ORG_A, status: "in_progress" });
    assert.deepEqual(slots(), [4, 3, 1]);
  });

  pgTest("0, 1, 2, 3 and 4 active calls leave 4, 3, 2, 1 and 0 free", () => {
    clear();
    for (let active = 0; active <= 4; active++) {
      assert.deepEqual(slots(), [4, active, 4 - active], `${active} active`);
      if (active < 4) addCall({ org: active % 2 ? ORG_A : ORG_B });
    }
  });

  pgTest("the call that would exceed the limit is refused, and nothing is written", () => {
    clear();
    for (let i = 0; i < 4; i++) addCall({ org: i % 2 ? ORG_A : ORG_B });
    const before = rows(`SELECT count(*) FROM public.call_logs;`).at(-1);
    assert.throws(() => addCall(), /PROVIDER_CONCURRENCY_LIMIT: 4 of 4 call slots are in use/);
    assert.equal(rows(`SELECT count(*) FROM public.call_logs;`).at(-1), before);
  });

  pgTest("a refused insert rolls back the whole transaction around it", () => {
    clear();
    for (let i = 0; i < 4; i++) addCall();
    const r = execSql!(
      `BEGIN;\nUPDATE public.organizations SET name = 'changed' WHERE id = '${ORG_A}';\n${insertSql({})}\nCOMMIT;`,
    );
    assert.notEqual(r.status, 0);
    assert.equal(
      rows(`SELECT name FROM public.organizations WHERE id = '${ORG_A}';`).at(-1),
      "Clinic A",
    );
  });

  pgTest("a finished call, and a start that failed, free their slot at once", () => {
    clear();
    const first = randomUUID();
    addCall({ id: first });
    for (let i = 0; i < 3; i++) addCall();
    assert.throws(() => addCall(), /PROVIDER_CONCURRENCY_LIMIT/);
    rows(
      `UPDATE public.call_logs SET status = 'completed', ended_at = now() WHERE id = '${first}';`,
    );
    assert.deepEqual(slots(), [4, 3, 1]);
    addCall(); // takes it
    assert.throws(() => addCall(), /PROVIDER_CONCURRENCY_LIMIT/);
    addCall({ status: "failed" }); // a row recorded as failed is not an unfinished call, so it is never refused
    rows(
      `UPDATE public.call_logs SET status = 'failed', ended_at = now() WHERE id IN (SELECT id FROM public.call_logs WHERE status = 'initiated' LIMIT 1);`,
    );
    assert.deepEqual(slots(), [4, 3, 1]);
  });

  pgTest("an unknown outcome holds its slot, until its window (15 minutes) passes", () => {
    clear();
    addCall({ status: "outcome_unknown" }); // not covered by the trigger, but counted
    assert.deepEqual(slots(), [4, 1, 3]);
    addCall({ status: "outcome_unknown", startedAgoMin: 20 });
    assert.deepEqual(slots(), [4, 1, 3], "a start older than the window no longer holds a slot");
  });

  pgTest("a call lost without a result stops holding its slot after 15 minutes", () => {
    clear();
    for (let i = 0; i < 4; i++) addCall({ startedAgoMin: 16 });
    assert.deepEqual(slots(), [4, 0, 4]);
    addCall();
  });

  pgTest("other providers and inbound rows neither count nor are refused", () => {
    clear();
    for (let i = 0; i < 4; i++) addCall();
    addCall({ provider: "livekit" });
    addCall({ provider: "vobiz", status: "ringing" });
    addCall({ direction: "inbound", status: "in_progress" });
    assert.deepEqual(slots(), [4, 4, 0]);
  });

  pgTest("the limit is configurable (1 to 50), unreadable settings fall back to 4", () => {
    clear();
    setLimit('{"limit": 2}');
    assert.deepEqual(slots(), [2, 0, 2]);
    addCall();
    addCall();
    assert.throws(() => addCall(), /2 of 2 call slots/);
    setLimit('{"limit": 9}');
    assert.deepEqual(slots(), [9, 2, 7]);
    setLimit('{"limit": 0}');
    assert.equal(slots()[0], 1, "never below 1");
    setLimit('{"limit": 500}');
    assert.equal(slots()[0], 50, "never above 50");
    for (const bad of [
      '{"limit": "many"}',
      '{"limit": -3}',
      '{"limit": 2.5}',
      "{}",
      '"x"',
      "null",
    ]) {
      setLimit(bad);
      assert.equal(slots()[0], 4, bad);
    }
  });

  pgTest("a live inbound call holds a slot until the agent reports its outcome", () => {
    clear();
    const event = (kind: string, integration: string, ago = 60) =>
      rows(
        `INSERT INTO public.sarvam_agent_events (integration_id, organization_id, kind, status, interaction_id, created_at)
         VALUES ('${integration}', (SELECT organization_id FROM public.sarvam_agent_integrations WHERE id = '${integration}'),
                 '${kind}', 'ok', '20261201/in-1', now() - interval '${ago} seconds');`,
      );
    event("context", INBOUND_INTEGRATION);
    assert.deepEqual(slots(), [4, 1, 3]);
    event("context", INBOUND_INTEGRATION, 30); // the same interaction asked again: still one
    assert.deepEqual(slots(), [4, 1, 3]);
    event("call_outcome", INBOUND_INTEGRATION, 1);
    assert.deepEqual(slots(), [4, 0, 4]);
  });

  pgTest("an outbound agent's own context request is not counted twice with its call row", () => {
    clear();
    addCall({ org: ORG_B });
    rows(
      `INSERT INTO public.sarvam_agent_events (integration_id, organization_id, kind, status, interaction_id, created_at)
       VALUES ('${OUTBOUND_INTEGRATION}', '${ORG_B}', 'context', 'ok', '20261201/out-1', now() - interval '30 seconds');`,
    );
    assert.deepEqual(slots(), [4, 1, 3]);
  });

  pgTest("an inbound interaction whose result was recorded no longer holds a slot", () => {
    clear();
    rows(
      `INSERT INTO public.sarvam_agent_events (integration_id, organization_id, kind, status, interaction_id, created_at)
       VALUES ('${INBOUND_INTEGRATION}', '${ORG_A}', 'context', 'ok', '20261201/in-2', now() - interval '120 seconds');`,
    );
    assert.equal(slots()[1], 1);
    rows(
      `INSERT INTO public.call_logs (id, organization_id, provider, provider_call_id, direction, status, started_at, ended_at, duration_seconds)
       VALUES ('${randomUUID()}', '${ORG_A}', 'sarvam', '20261201/in-2', 'inbound', 'completed', now() - interval '120 seconds', now(), 90);`,
    );
    assert.equal(slots()[1], 0);
  });

  pgTest("a live inbound call shrinks what outbound may start", () => {
    clear();
    rows(
      `INSERT INTO public.sarvam_agent_events (integration_id, organization_id, kind, status, interaction_id, created_at)
       VALUES ('${INBOUND_INTEGRATION}', '${ORG_A}', 'context', 'ok', '20261201/in-3', now() - interval '20 seconds');`,
    );
    for (let i = 0; i < 3; i++) addCall();
    assert.throws(() => addCall(), /PROVIDER_CONCURRENCY_LIMIT: 4 of 4/);
  });

  pgTest("two sessions racing for the last slot: exactly one gets it", async () => {
    clear();
    for (let i = 0; i < 3; i++) addCall();
    const a = runAsync(`BEGIN;\n${insertSql({ org: ORG_A })}\nSELECT pg_sleep(1.5);\nCOMMIT;`);
    await new Promise((r) => setTimeout(r, 500));
    const b = runAsync(`BEGIN;\n${insertSql({ org: ORG_B })}\nCOMMIT;`);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 0, ra.stderr);
    assert.notEqual(rb.status, 0, "the second session must be refused after waiting for the first");
    assert.match(rb.stderr, /PROVIDER_CONCURRENCY_LIMIT/);
    assert.deepEqual(slots(), [4, 4, 0]);
  });

  pgTest("browser roles cannot read the slots; the server role can", () => {
    for (const role of ["anon", "authenticated"]) {
      const r = execSql!(`SET ROLE ${role};\nSELECT * FROM public.outbound_concurrency();`);
      assert.notEqual(r.status, 0, role);
      assert.match(r.stderr, /permission denied/i);
    }
    assert.equal(
      execSql!(`SET ROLE service_role;\nSELECT * FROM public.outbound_concurrency();`).status,
      0,
    );
  });

  pgTest("re-applying the migration is harmless and leaves one trigger", () => {
    const again = execSql!(`BEGIN;\n${readFileSync(join(migrationsDir, THIS), "utf8")}\nCOMMIT;`);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(
      rows(
        `SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_call_logs_outbound_concurrency' AND NOT tgisinternal;`,
      ).at(-1),
      "1",
    );
  });
});
