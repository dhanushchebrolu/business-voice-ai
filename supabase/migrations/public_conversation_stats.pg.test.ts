import { test, describe, before, after, type TestContext } from "node:test";
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
 * public_conversation_stats() (20261130090000): the landing-page total of
 * conversation seconds, replayed against every migration on a real PostgreSQL.
 * Legacy default privileges are ON (the worst case for exposure), so the
 * migration's own REVOKE is what keeps browser roles out.
 */
const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const THIS = "20261130090000_public_conversation_stats.sql";

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
const INTEGRATION_A = randomUUID();
const INTEGRATION_B = randomUUID();

function pgTest(name: string, fn: () => void) {
  test(name, (t: TestContext) => {
    if (setupFailure) assert.fail(setupFailure);
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    fn();
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

/** [completed_seconds, active_calls, active_elapsed_seconds] as the server role reads them. */
function stats(): [number, number, number] {
  const line = rows(
    `SET ROLE service_role;
     SELECT completed_seconds || '|' || active_calls || '|' || active_elapsed_seconds FROM public.public_conversation_stats();`,
  )
    .filter((l) => l.includes("|"))
    .at(-1)!;
  const [c, n, e] = line.split("|").map(Number);
  return [c!, n!, e!];
}

function call(o: {
  org?: string;
  status: string;
  duration?: number;
  answeredAgoSec?: number | null;
  ended?: boolean;
  providerCallId?: string;
}): string {
  const id = randomUUID();
  const answered =
    o.answeredAgoSec == null ? "NULL" : `now() - interval '${o.answeredAgoSec} seconds'`;
  rows(
    `INSERT INTO public.call_logs (id, organization_id, provider, provider_call_id, direction, status, started_at, answered_at, ended_at, duration_seconds)
     VALUES ('${id}', '${o.org ?? ORG_A}', 'sarvam', ${o.providerCallId ? `'${o.providerCallId}'` : "NULL"}, 'inbound', '${o.status}', now(), ${answered}, ${o.ended ? "now()" : "NULL"}, ${o.duration ?? 0});`,
  );
  return id;
}
const clear = () => rows(`DELETE FROM public.call_logs; DELETE FROM public.sarvam_agent_events;`);

/** A request from Sarvam's agent to the agent API (by default the `context` request made when a call starts). */
function agentEvent(o: {
  interaction: string | null;
  agoSec: number;
  kind?: string;
  status?: string;
  integration?: string;
}) {
  const integration = o.integration ?? INTEGRATION_A;
  rows(
    `INSERT INTO public.sarvam_agent_events (integration_id, organization_id, kind, status, interaction_id, created_at)
     VALUES ('${integration}', (SELECT organization_id FROM public.sarvam_agent_integrations WHERE id = '${integration}'),
             '${o.kind ?? "context"}', '${o.status ?? "ok"}', ${o.interaction ? `'${o.interaction}'` : "NULL"}, now() - interval '${o.agoSec} seconds');`,
  );
}

/** The call_logs row Sarvam's result webhook leaves: inbound keyed by interaction id, outbound by attempt id. */
function finishedSarvamCall(o: {
  interaction: string;
  duration: number;
  status?: string;
  outbound?: boolean;
}) {
  const metadata = o.outbound ? JSON.stringify({ interaction_id: o.interaction }) : "{}";
  rows(
    `INSERT INTO public.call_logs (id, organization_id, provider, provider_call_id, provider_metadata, direction, status, started_at, ended_at, duration_seconds)
     VALUES ('${randomUUID()}', '${ORG_A}', 'sarvam', '${o.outbound ? `att_${o.interaction}` : o.interaction}',
             '${metadata}'::jsonb, '${o.outbound ? "outbound" : "inbound"}', '${o.status ?? "completed"}', now(), now(), ${o.duration});`,
  );
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
  const seed = execSql(
    `INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG_A}', 'Clinic A', '${randomUUID()}'), ('${ORG_B}', 'Clinic B', '${randomUUID()}');`,
  );
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }
  const integrations = [
    [ORG_A, INTEGRATION_A],
    [ORG_B, INTEGRATION_B],
  ]
    .map(([org, integration]) => {
      const biz = randomUUID();
      const token = randomUUID().replace(/-/g, "").repeat(2);
      return `INSERT INTO public.businesses (id, organization_id, name, timezone) VALUES ('${biz}', '${org}', 'Clinic', 'Asia/Kolkata');
        INSERT INTO public.agent_configs (organization_id, business_id) VALUES ('${org}', '${biz}') ON CONFLICT (business_id) DO NOTHING;
        INSERT INTO public.sarvam_agent_integrations (id, organization_id, agent_config_id, token_hash, token_prefix)
          SELECT '${integration}', '${org}', id, '${token}', 'cai_sv_' FROM public.agent_configs WHERE business_id = '${biz}';`;
    })
    .join("\n");
  const seeded = execSql(integrations);
  if (seeded.status !== 0) setupFailure = `integration seed failed: ${seeded.stderr}`;
});

after(() => {
  unregister?.();
  if (cluster) teardownCluster(cluster);
});

describe("public_conversation_stats", () => {
  pgTest("zero calls: all zeros", () => {
    clear();
    assert.deepEqual(stats(), [0, 0, 0]);
  });

  pgTest("completed calls from different organizations are summed into one number", () => {
    clear();
    call({ org: ORG_A, status: "completed", duration: 60 });
    call({ org: ORG_B, status: "completed", duration: 30 });
    assert.deepEqual(stats(), [90, 0, 0]);
  });

  pgTest("calls that never connected add nothing, whatever duration they carry", () => {
    clear();
    for (const status of ["failed", "busy", "no_answer", "cancelled", "initiated", "ringing"])
      call({ status, duration: 45 });
    call({ status: "outcome_unknown", duration: 45 });
    call({ status: "completed", duration: 0 });
    assert.deepEqual(stats(), [0, 0, 0]);
  });

  pgTest("connected calls count their seconds so far, overlapping calls each add their own", () => {
    clear();
    call({ status: "answered", answeredAgoSec: 100 });
    call({ org: ORG_B, status: "in_progress", answeredAgoSec: 50 });
    const [completed, active, elapsed] = stats();
    assert.equal(completed, 0);
    assert.equal(active, 2);
    assert.ok(elapsed >= 150 && elapsed <= 153, `elapsed ${elapsed}`);
  });

  pgTest("ended, never-answered and abandoned (over 2 hours) calls are not live", () => {
    clear();
    call({ status: "in_progress", answeredAgoSec: 30, ended: true });
    call({ status: "in_progress", answeredAgoSec: null });
    call({ status: "in_progress", answeredAgoSec: 3 * 3600 });
    assert.deepEqual(stats(), [0, 0, 0]);
  });

  pgTest("a call that ends moves from live to final and is counted once", () => {
    clear();
    const id = call({ status: "in_progress", answeredAgoSec: 100 });
    const [, , liveElapsed] = stats();
    assert.ok(liveElapsed >= 100);
    rows(
      `UPDATE public.call_logs SET status = 'completed', ended_at = now(), duration_seconds = 120 WHERE id = '${id}';`,
    );
    assert.deepEqual(stats(), [120, 0, 0]);
  });

  pgTest("a duplicate webhook cannot create a second row for the same call", () => {
    clear();
    call({ status: "completed", duration: 60, providerCallId: "att_dup" });
    assert.throws(
      () => call({ status: "completed", duration: 60, providerCallId: "att_dup" }),
      /duplicate key|unique/i,
    );
    assert.deepEqual(stats(), [60, 0, 0]);
  });

  pgTest("returns only the four aggregate columns", () => {
    const result = rows(
      `SELECT pg_get_function_result('public.public_conversation_stats()'::regprocedure);`,
    ).at(-1);
    assert.equal(
      result,
      "TABLE(completed_seconds bigint, active_calls integer, active_elapsed_seconds bigint, as_of timestamp with time zone)",
    );
  });

  pgTest("browser roles cannot run it; only the server role can", () => {
    for (const role of ["anon", "authenticated"]) {
      const r = execSql!(`SET ROLE ${role};\nSELECT * FROM public.public_conversation_stats();`);
      assert.notEqual(r.status, 0, role);
      assert.match(r.stderr, /permission denied/i);
    }
    const ok = execSql!(
      `SET ROLE service_role;\nSELECT * FROM public.public_conversation_stats();`,
    );
    assert.equal(ok.status, 0, ok.stderr);
  });

  pgTest(
    "Sarvam: a connected interaction (its context request arrived) counts live from then",
    () => {
      clear();
      agentEvent({ interaction: "20261125/a-1", agoSec: 100 });
      const [completed, active, elapsed] = stats();
      assert.equal(completed, 0);
      assert.equal(active, 1);
      assert.ok(elapsed >= 100 && elapsed <= 103, `elapsed ${elapsed}`);
    },
  );

  pgTest("Sarvam: repeated context requests for one interaction count once, from the first", () => {
    clear();
    agentEvent({ interaction: "20261125/a-2", agoSec: 90 });
    agentEvent({ interaction: "20261125/a-2", agoSec: 60 });
    agentEvent({ interaction: "20261125/a-2", agoSec: 5 });
    const [, active, elapsed] = stats();
    assert.equal(active, 1);
    assert.ok(elapsed >= 90 && elapsed <= 93, `elapsed ${elapsed}`);
  });

  pgTest("Sarvam: overlapping interactions of different organizations each count", () => {
    clear();
    agentEvent({ interaction: "20261125/a-3", agoSec: 40, integration: INTEGRATION_A });
    agentEvent({ interaction: "20261125/b-3", agoSec: 20, integration: INTEGRATION_B });
    const [, active, elapsed] = stats();
    assert.equal(active, 2);
    assert.ok(elapsed >= 60 && elapsed <= 63, `elapsed ${elapsed}`);
  });

  pgTest("Sarvam: requests that don't prove a connected call are ignored", () => {
    clear();
    agentEvent({ interaction: null, agoSec: 10 }); // the admin "Test integration" request
    agentEvent({ interaction: "20261125/a-4", agoSec: 10, status: "rejected" });
    agentEvent({ interaction: "20261125/a-5", agoSec: 10, status: "error" });
    agentEvent({ interaction: "20261125/a-6", agoSec: 10, kind: "get_business_info" });
    agentEvent({ interaction: "20261125/a-7", agoSec: 10, kind: "book_appointment" });
    assert.deepEqual(stats(), [0, 0, 0]);
  });

  pgTest(
    "Sarvam: an interaction whose end signal never arrived stops counting after 30 minutes",
    () => {
      clear();
      agentEvent({ interaction: "20261125/a-8", agoSec: 31 * 60 });
      assert.deepEqual(stats(), [0, 0, 0]);
    },
  );

  pgTest("Sarvam: the agent's end-of-call outcome stops the live count", () => {
    clear();
    agentEvent({ interaction: "20261125/a-9", agoSec: 120 });
    assert.equal(stats()[1], 1);
    agentEvent({ interaction: "20261125/a-9", agoSec: 0, kind: "call_outcome" });
    assert.deepEqual(stats(), [0, 0, 0]);
  });

  pgTest(
    "Sarvam inbound: the result webhook moves the call from live to its final duration, once",
    () => {
      clear();
      agentEvent({ interaction: "20261125/a-10", agoSec: 100 });
      assert.equal(stats()[1], 1);
      finishedSarvamCall({ interaction: "20261125/a-10", duration: 97 });
      assert.deepEqual(stats(), [97, 0, 0]);
    },
  );

  pgTest("Sarvam outbound: a delayed result leaves the call live, then replaces it", () => {
    clear();
    agentEvent({ interaction: "20261125/a-11", agoSec: 50 });
    rows(
      `INSERT INTO public.call_logs (id, organization_id, provider, provider_call_id, direction, status, started_at)
       VALUES ('${randomUUID()}', '${ORG_A}', 'sarvam', 'att_20261125/a-11', 'outbound', 'initiated', now());`,
    );
    assert.equal(stats()[1], 1);
    rows(
      `UPDATE public.call_logs SET status = 'completed', ended_at = now(), duration_seconds = 56,
              provider_metadata = '{"interaction_id":"20261125/a-11"}'::jsonb
        WHERE provider_call_id = 'att_20261125/a-11';`,
    );
    assert.deepEqual(stats(), [56, 0, 0]);
  });

  pgTest("Sarvam: the same result delivered twice leaves one row and one total", () => {
    clear();
    agentEvent({ interaction: "20261125/a-12", agoSec: 30 });
    finishedSarvamCall({ interaction: "20261125/a-12", duration: 40, outbound: true });
    assert.throws(
      () => finishedSarvamCall({ interaction: "20261125/a-12", duration: 40, outbound: true }),
      /duplicate key|unique/i,
    );
    assert.deepEqual(stats(), [40, 0, 0]);
  });

  pgTest("Sarvam: a call that ended as failed adds nothing live or final", () => {
    clear();
    agentEvent({ interaction: "20261125/a-13", agoSec: 20 });
    finishedSarvamCall({ interaction: "20261125/a-13", duration: 0, status: "failed" });
    assert.deepEqual(stats(), [0, 0, 0]);
  });

  pgTest(
    "a call answered in call_logs and seen by the Sarvam agent is one live call, not two",
    () => {
      clear();
      agentEvent({ interaction: "20261125/a-14", agoSec: 60 });
      rows(
        `INSERT INTO public.call_logs (id, organization_id, provider, provider_call_id, direction, status, started_at, answered_at)
       VALUES ('${randomUUID()}', '${ORG_A}', 'sarvam', '20261125/a-14', 'inbound', 'in_progress', now(), now() - interval '60 seconds');`,
      );
      const [, active, elapsed] = stats();
      assert.equal(active, 1);
      assert.ok(elapsed >= 60 && elapsed <= 63, `elapsed ${elapsed}`);
    },
  );

  pgTest("re-applying the migration is harmless", () => {
    const again = execSql!(`BEGIN;\n${readFileSync(join(migrationsDir, THIS), "utf8")}\nCOMMIT;`);
    assert.equal(again.status, 0, again.stderr);
  });
});
