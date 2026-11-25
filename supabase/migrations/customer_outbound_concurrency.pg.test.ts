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
 * Customer-selectable outbound concurrency (20261202090000), replayed against every migration on
 * a real PostgreSQL: each customer's outbound calls are held to their own cap (default 2) inside
 * the same serialized trigger as the platform limit, so slots kept for incoming calls are never
 * taken, campaigns of one customer share the cap, and customers cannot go around the limit.
 */
const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const THIS = "20261202090000_customer_outbound_concurrency.sql";

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

const choose = (org: string, n: number | null) =>
  rows(
    `UPDATE public.organizations SET outbound_concurrency = ${n === null ? "NULL" : n} WHERE id = '${org}';`,
  );
/** selected|cap|limit|global_in_use|active_outbound|remaining|reserved_inbound */
const mine = (org: string): string => {
  const line = rows(
    `SET ROLE service_role;
     SELECT coalesce(selected::text, 'null') || '|' || cap || '|' || slot_limit || '|' || global_in_use || '|' || active_outbound || '|' || remaining || '|' || reserved_inbound FROM public.outbound_org_concurrency('${org}');`,
  )
    .filter((l) => l.includes("|"))
    .at(-1)!;
  return line;
};
const reset = () => {
  clear();
  choose(ORG_A, null);
  choose(ORG_B, null);
};
const inboundOn = (n: number) => {
  for (let i = 0; i < n; i++)
    rows(
      `INSERT INTO public.sarvam_agent_events (integration_id, organization_id, kind, status, interaction_id, created_at)
       VALUES ('${INBOUND_INTEGRATION}', '${ORG_A}', 'context', 'ok', '20261202/in-${i}', now() - interval '20 seconds');`,
    );
};

describe("customer outbound concurrency", () => {
  pgTest("a customer who has not chosen is held to 2, with 2 kept for incoming calls", () => {
    reset();
    assert.equal(mine(ORG_A), "null|2|4|0|0|2|2");
    addCall({ org: ORG_A });
    addCall({ org: ORG_A });
    assert.throws(() => addCall({ org: ORG_A }), /ORG_CONCURRENCY_LIMIT: 2 of 2 outbound calls/);
    assert.equal(mine(ORG_A), "null|2|4|2|2|0|2");
  });

  for (const n of [1, 2, 3, 4]) {
    pgTest(`choosing ${n}: ${n} outbound calls run, ${4 - n} slots stay for incoming calls`, () => {
      reset();
      choose(ORG_A, n);
      assert.equal(mine(ORG_A), `${n}|${n}|4|0|0|${n}|${4 - n}`);
      for (let i = 0; i < n; i++) addCall({ org: ORG_A });
      // at 4 the platform limit is the one that is full
      assert.throws(
        () => addCall({ org: ORG_A }),
        n === 4 ? /PROVIDER_CONCURRENCY_LIMIT/ : /ORG_CONCURRENCY_LIMIT/,
      );
      assert.equal(slots()[2], 4 - n, "what is left is what incoming calls may use");
    });
  }

  pgTest("outbound cannot take the slots held for incoming calls, and incoming still can", () => {
    reset();
    choose(ORG_A, 2);
    addCall({ org: ORG_A });
    addCall({ org: ORG_A });
    assert.throws(() => addCall({ org: ORG_A }), /ORG_CONCURRENCY_LIMIT/);
    inboundOn(2); // two incoming calls use exactly the room kept for them
    assert.deepEqual(slots(), [4, 4, 0]);
  });

  pgTest(
    "live incoming calls count toward the platform limit and shrink what outbound can start",
    () => {
      reset();
      choose(ORG_A, 4);
      inboundOn(2);
      addCall({ org: ORG_A });
      addCall({ org: ORG_A });
      assert.throws(() => addCall({ org: ORG_A }), /PROVIDER_CONCURRENCY_LIMIT: 4 of 4/);
      assert.equal(mine(ORG_A), "4|4|4|4|2|0|0");
    },
  );

  pgTest("every campaign and single call of one customer shares the cap", () => {
    reset();
    choose(ORG_A, 3);
    addCall({ org: ORG_A });
    addCall({ org: ORG_A });
    addCall({ org: ORG_A });
    assert.throws(() => addCall({ org: ORG_A }), /ORG_CONCURRENCY_LIMIT: 3 of 3/);
  });

  pgTest("two customers cannot go around the platform limit", () => {
    reset();
    choose(ORG_A, 4);
    choose(ORG_B, 4);
    addCall({ org: ORG_A });
    addCall({ org: ORG_A });
    addCall({ org: ORG_B });
    addCall({ org: ORG_B });
    assert.throws(() => addCall({ org: ORG_A }), /PROVIDER_CONCURRENCY_LIMIT/);
    assert.throws(() => addCall({ org: ORG_B }), /PROVIDER_CONCURRENCY_LIMIT/);
    assert.deepEqual(slots(), [4, 4, 0]);
  });

  pgTest("one customer's calls never count against another's cap", () => {
    reset();
    choose(ORG_A, 1);
    choose(ORG_B, 2);
    addCall({ org: ORG_A });
    addCall({ org: ORG_B });
    addCall({ org: ORG_B });
    assert.throws(() => addCall({ org: ORG_A }), /ORG_CONCURRENCY_LIMIT: 1 of 1/);
    assert.throws(() => addCall({ org: ORG_B }), /ORG_CONCURRENCY_LIMIT: 2 of 2/);
  });

  pgTest("the cap follows the platform limit when it moves", () => {
    reset();
    choose(ORG_A, 4);
    setLimit('{"limit": 2}');
    assert.equal(mine(ORG_A), "4|2|2|0|0|2|0", "a choice above the limit is held to the limit");
    setLimit('{"limit": 6}');
    assert.equal(mine(ORG_A), "4|4|6|0|0|4|2", "inbound reserve is the limit minus the choice");
    choose(ORG_A, null);
    setLimit('{"limit": 1}');
    assert.equal(mine(ORG_A), "null|1|1|0|0|1|0", "the default never exceeds the limit");
  });

  pgTest("lowering the choice with calls running ends none and holds new ones", () => {
    reset();
    setLimit('{"limit": 8}');
    choose(ORG_A, 4);
    for (let i = 0; i < 4; i++) addCall({ org: ORG_A });
    choose(ORG_A, 2);
    assert.equal(
      rows(`SELECT count(*) FROM public.call_logs WHERE status = 'initiated';`).at(-1),
      "4",
    );
    assert.equal(mine(ORG_A), "2|2|8|4|4|0|6");
    assert.throws(() => addCall({ org: ORG_A }), /ORG_CONCURRENCY_LIMIT: 4 of 2/);
    const done = (k: number) =>
      rows(
        `UPDATE public.call_logs SET status = 'completed', ended_at = now() WHERE id IN (SELECT id FROM public.call_logs WHERE status = 'initiated' LIMIT ${k});`,
      );
    done(2);
    assert.throws(() => addCall({ org: ORG_A }), /ORG_CONCURRENCY_LIMIT: 2 of 2/);
    done(1);
    addCall({ org: ORG_A });
    assert.equal(mine(ORG_A).split("|")[4], "2");
  });

  pgTest("a failed start and an old unfinished call free the customer's slot", () => {
    reset();
    choose(ORG_A, 1);
    const id = randomUUID();
    addCall({ org: ORG_A, id });
    assert.throws(() => addCall({ org: ORG_A }), /ORG_CONCURRENCY_LIMIT/);
    rows(`UPDATE public.call_logs SET status = 'failed', ended_at = now() WHERE id = '${id}';`);
    addCall({ org: ORG_A });
    reset();
    choose(ORG_A, 1);
    addCall({ org: ORG_A, startedAgoMin: 16 });
    addCall({ org: ORG_A });
  });

  pgTest("an unknown outcome holds the customer's slot", () => {
    reset();
    choose(ORG_A, 1);
    addCall({ org: ORG_A, status: "outcome_unknown" });
    assert.throws(() => addCall({ org: ORG_A }), /ORG_CONCURRENCY_LIMIT/);
  });

  pgTest("other providers and incoming rows do not count against the cap", () => {
    reset();
    choose(ORG_A, 1);
    addCall({ org: ORG_A, provider: "livekit" });
    addCall({ org: ORG_A, direction: "inbound", status: "in_progress" });
    addCall({ org: ORG_A });
    assert.throws(() => addCall({ org: ORG_A }), /ORG_CONCURRENCY_LIMIT/);
  });

  pgTest("a refused insert rolls back the whole admission transaction", () => {
    reset();
    choose(ORG_A, 1);
    addCall({ org: ORG_A });
    const r = execSql!(
      `BEGIN;\nUPDATE public.organizations SET name = 'changed' WHERE id = '${ORG_A}';\n${insertSql({ org: ORG_A })}\nCOMMIT;`,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ORG_CONCURRENCY_LIMIT/);
    assert.equal(
      rows(`SELECT name FROM public.organizations WHERE id = '${ORG_A}';`).at(-1),
      "Clinic A",
    );
  });

  pgTest("two overlapping sessions for the customer's last slot: exactly one gets it", async () => {
    reset();
    choose(ORG_A, 2);
    addCall({ org: ORG_A });
    const a = runAsync(`BEGIN;\n${insertSql({ org: ORG_A })}\nSELECT pg_sleep(1.5);\nCOMMIT;`);
    await new Promise((r) => setTimeout(r, 500));
    const b = runAsync(`BEGIN;\n${insertSql({ org: ORG_A })}\nCOMMIT;`);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 0, ra.stderr);
    assert.notEqual(rb.status, 0);
    assert.match(rb.stderr, /ORG_CONCURRENCY_LIMIT/);
    assert.equal(mine(ORG_A).split("|")[4], "2");
  });

  pgTest("the choice must be 1 to 50", () => {
    reset();
    for (const bad of [0, -1, 51]) {
      const r = execSql!(
        `UPDATE public.organizations SET outbound_concurrency = ${bad} WHERE id = '${ORG_A}';`,
      );
      assert.notEqual(r.status, 0, String(bad));
      assert.match(r.stderr, /organizations_outbound_concurrency_range/);
    }
  });

  pgTest(
    "the admin overview lists customers with a choice or running calls, and why they wait",
    () => {
      reset();
      choose(ORG_A, 1);
      addCall({ org: ORG_A });
      addCall({ org: ORG_B });
      const lines = rows(
        `SET ROLE service_role;
       SELECT organization_id || '|' || coalesce(selected::text, 'null') || '|' || cap || '|' || active_outbound || '|' || coalesce(limited_by, 'free') FROM public.outbound_concurrency_overview();`,
      ).filter((l) => l.includes("|"));
      const byOrg = new Map(lines.map((l) => [l.split("|")[0], l.split("|").slice(1).join("|")]));
      assert.equal(byOrg.get(ORG_A), "1|1|1|customer_setting");
      assert.equal(byOrg.get(ORG_B), "null|2|1|free");
      addCall({ org: ORG_B });
      const again = rows(
        `SET ROLE service_role;
       SELECT coalesce(limited_by, 'free') FROM public.outbound_concurrency_overview() WHERE organization_id = '${ORG_B}';`,
      ).at(-1);
      assert.equal(again, "customer_setting");
      inboundOn(1); // now the whole platform is full, which is the nearer reason
      assert.equal(
        rows(
          `SET ROLE service_role;
         SELECT limited_by FROM public.outbound_concurrency_overview() WHERE organization_id = '${ORG_B}';`,
        ).at(-1),
        "platform",
      );
    },
  );

  pgTest("browser roles cannot read the allowance functions", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const call of [
        `public.outbound_org_concurrency('${ORG_A}')`,
        "public.outbound_concurrency_overview()",
      ]) {
        const r = execSql!(`SET ROLE ${role};\nSELECT * FROM ${call};`);
        assert.notEqual(r.status, 0, `${role} ${call}`);
        assert.match(r.stderr, /permission denied/i);
      }
    }
  });

  pgTest("re-applying the migration is harmless, keeps the stored choices and one trigger", () => {
    reset();
    choose(ORG_A, 3);
    const again = execSql!(`BEGIN;\n${readFileSync(join(migrationsDir, THIS), "utf8")}\nCOMMIT;`);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(mine(ORG_A).split("|")[0], "3");
    assert.equal(
      rows(
        `SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_call_logs_outbound_concurrency' AND NOT tgisinternal;`,
      ).at(-1),
      "1",
    );
  });
});
