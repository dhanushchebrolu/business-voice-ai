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
 * REAL-PostgreSQL coverage for 20261121090000_campaign_context_engine.sql:
 * admit_campaign_outbound_call admits a campaign call only for a running,
 * reviewed campaign and a contact claimed for exactly that call, on the
 * customer's own outbound number and confirmed agent, within the in-flight
 * limit, the wallet's worst case over every open call and the campaign budget,
 * including under genuinely concurrent requests; single admission now reserves
 * for open campaign calls too; the migration is re-runnable with a rollback.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261121090000_campaign_context_engine.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(migrationsDir, "../../docs/production-rollback-20261121090000-campaign-context-engine.sql"),
  "utf8",
);

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
const RATE = 400; // the platform's outbound_minute rule
const PER_CALL = RATE * 5; // 300 s confirmed maximum -> 5 billed minutes at most
const CONTEXT = `'{"version":1,"objective":"Invite for a check-up"}'::jsonb`;

/** Admission's clock for every test unless a test sets its own: midday India time. */
const MIDDAY = "SET clickai.admission_now = '2026-11-20 12:00:00+05:30';";
function run(sql: string): RunResult {
  return execSql!(
    `\\pset format unaligned\n\\pset tuples_only on\nSET ROLE service_role;\n${MIDDAY}\n${sql}`,
  );
}
function rows(sql: string): string[] {
  const r = run(sql);
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr}\n${sql}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only") && l !== "SET",
    );
}
function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

/** A real, independent psql process, so statements genuinely run at the same time. */
function runAsync(sql: string): Promise<RunResult> {
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
      "-qAtX",
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
    child.stdin.write(`SET ROLE service_role;\n${MIDDAY}\n${sql}`);
    child.stdin.end();
  });
}

let seq = 0;
const phone = () => `+9198${String(++seq).padStart(8, "0")}`;

interface Org {
  id: string;
  number: string;
  agent: string;
  campaign: string;
}

/** A customer with a wallet, one outbound-enabled Sarvam number, a confirmed agent and a running, reviewed campaign. */
function newOrg(balance: number, campaign: { budget?: number | null; status?: string } = {}): Org {
  const org = {
    id: randomUUID(),
    number: randomUUID(),
    agent: randomUUID(),
    campaign: randomUUID(),
  };
  rows(`RESET ROLE;
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${org.id}', 'Shop', '${OWNER}');
    INSERT INTO public.businesses (id, organization_id, name) VALUES ('${org.id}', '${org.id}', 'Shop');
    INSERT INTO public.agent_configs (id, organization_id, business_id, sarvam_app_id, sarvam_app_version,
        sarvam_outbound_ready_app_id, sarvam_outbound_ready_version, sarvam_outbound_max_call_seconds)
      VALUES ('${org.agent}', '${org.id}', '${org.id}', 'In-${org.agent}', 5, 'In-${org.agent}', 5, 300);
    INSERT INTO public.phone_numbers (id, organization_id, e164, provider, status, outbound_enabled, agent_config_id)
      VALUES ('${org.number}', '${org.id}', '${phone()}', 'sarvam', 'active', true, '${org.agent}');
    INSERT INTO public.campaigns (id, organization_id, name, status, phone_number_id, agent_config_id,
        context, context_version, context_reviewed_at, budget_limit)
      VALUES ('${org.campaign}', '${org.id}', 'C', '${campaign.status ?? "running"}', '${org.number}', '${org.agent}',
        ${CONTEXT}, 1, now(), ${campaign.budget ?? "NULL"});
    ${balance > 0 ? `INSERT INTO public.wallet_transactions (organization_id, amount, kind, description) VALUES ('${org.id}', ${balance}, 'topup', 'seed');` : ""}`);
  return org;
}

/** A contact of this campaign, claimed by the dispatcher for a fresh call id. */
function claimed(
  org: Org,
  to = phone(),
  campaign = org.campaign,
): { cc: string; call: string; to: string } {
  const contact = randomUUID();
  const cc = randomUUID();
  const call = randomUUID();
  rows(`RESET ROLE;
    INSERT INTO public.contacts (id, organization_id, phone) VALUES ('${contact}', '${org.id}', '${to}');
    INSERT INTO public.campaign_contacts (id, campaign_id, organization_id, contact_id, status, attempts, current_call_id)
      VALUES ('${cc}', '${campaign}', '${org.id}', '${contact}', 'calling', 1, '${call}');`);
  return { cc, call, to };
}

const admitSql = (
  org: Org,
  c: { cc: string; call: string; to: string },
  maxInFlight = 10,
  campaign = org.campaign,
) =>
  `SELECT public.admit_campaign_outbound_call('${campaign}', '${c.cc}', '${c.call}', '${c.to}', 0, ${maxInFlight},
     (SELECT context_reviewed_at FROM public.campaigns WHERE id = '${campaign}'), 'Sent objective', 'Sent instructions');`;
function admit(...args: Parameters<typeof admitSql>): Record<string, unknown> {
  return JSON.parse(rows(admitSql(...args))[0]!) as Record<string, unknown>;
}
function openCall(org: Org, extra: Record<string, string> = {}) {
  const cols = {
    organization_id: `'${org.id}'`,
    provider: "'sarvam'",
    direction: "'outbound'",
    status: "'initiated'",
    destination_number: `'${phone()}'`,
    started_at: "now()",
    billing_cap_minutes: "5",
    billing_rate_per_minute: `${RATE}`,
    ...extra,
  };
  rows(
    `INSERT INTO public.call_logs (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")});`,
  );
}
const callCount = (org: Org) =>
  Number(rows(`SELECT count(*) FROM public.call_logs WHERE organization_id = '${org.id}';`)[0]);

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
  const seed = execSql(`INSERT INTO auth.users (id) VALUES ('${OWNER}');`);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
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
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

describe("admit_campaign_outbound_call", () => {
  test("admits and writes the call row with the campaign, contact, caller number, cap and price", (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    const c = claimed(org);
    const r = admit(org, c);
    assert.equal(r["result"], "admitted");
    assert.equal(r["call_id"], c.call);
    assert.equal(r["cap_minutes"], 5);
    assert.equal(r["rate_per_minute"], RATE);
    assert.deepEqual(
      rows(`SELECT status || '|' || campaign_id || '|' || campaign_contact_id || '|' || destination_number || '|' ||
              billing_cap_minutes || '|' || billing_rate_per_minute || '|' || (caller_number = (SELECT e164 FROM public.phone_numbers WHERE id = '${org.number}'))
            FROM public.call_logs WHERE id = '${c.call}';`),
      [`initiated|${org.campaign}|${c.cc}|${c.to}|5|${RATE}|true`],
    );
  });

  test("a paused campaign, or one without a reviewed context, dials nothing", (t) => {
    if (!ready(t)) return;
    const paused = newOrg(100_000, { status: "paused" });
    assert.equal(admit(paused, claimed(paused))["reason"], "campaign_not_running");
    const unreviewed = newOrg(100_000);
    rows(
      `UPDATE public.campaigns SET context_reviewed_at = NULL WHERE id = '${unreviewed.campaign}';`,
    );
    assert.equal(admit(unreviewed, claimed(unreviewed))["reason"], "context_not_reviewed");
    assert.equal(callCount(paused) + callCount(unreviewed), 0);
  });

  test("only a contact claimed for exactly this call, in this campaign", (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    const c = claimed(org);
    assert.equal(admit(org, { ...c, call: randomUUID() })["reason"], "contact_not_claimed");
    rows(`UPDATE public.campaign_contacts SET status = 'pending' WHERE id = '${c.cc}';`);
    assert.equal(admit(org, c)["reason"], "contact_not_claimed");
    const other = newOrg(100_000);
    const theirs = claimed(other);
    assert.equal(admit(org, theirs)["reason"], "contact_not_claimed", "another customer's contact");
    assert.equal(callCount(org) + callCount(other), 0);
  });

  test("the caller number must be this customer's, active and outbound-enabled", (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    rows(`UPDATE public.phone_numbers SET outbound_enabled = false WHERE id = '${org.number}';`);
    assert.equal(admit(org, claimed(org))["reason"], "number_not_owned");
    const other = newOrg(100_000);
    rows(
      `RESET ROLE; UPDATE public.campaigns SET phone_number_id = '${other.number}' WHERE id = '${org.campaign}';`,
    );
    assert.equal(
      admit(org, claimed(org))["reason"],
      "number_not_owned",
      "another customer's number",
    );
  });

  test("the agent's confirmed maximum must be 60-300 seconds", (t) => {
    if (!ready(t)) return;
    // Below 60 is already refused by the column's own CHECK.
    for (const max of ["NULL", "301", "900"]) {
      const org = newOrg(100_000);
      rows(
        `RESET ROLE; UPDATE public.agent_configs SET sarvam_outbound_max_call_seconds = ${max} WHERE id = '${org.agent}';`,
      );
      assert.equal(admit(org, claimed(org))["reason"], "max_call_length_not_set", max);
    }
  });

  test("in-flight limit counts every open outbound call, single or campaign", (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    openCall(org); // a single call
    openCall(org, { status: "'outcome_unknown'" });
    openCall(org, { status: "'completed'" }); // finished: not counted
    assert.equal(admit(org, claimed(org), 3)["result"], "admitted");
    assert.equal(admit(org, claimed(org), 3)["reason"], "in_flight_limit");
  });

  test("the wallet must cover this call's worst case plus every open call's, single or campaign", (t) => {
    if (!ready(t)) return;
    const org = newOrg(2 * PER_CALL);
    openCall(org); // reserves PER_CALL
    assert.equal(admit(org, claimed(org))["result"], "admitted"); // needs 2 * PER_CALL
    const refused = admit(org, claimed(org));
    assert.equal(refused["reason"], "insufficient_balance");
    assert.equal(refused["required"], 3 * PER_CALL);
  });

  test("the campaign budget counts billed charges, unbilled worst cases, never failed starts", (t) => {
    if (!ready(t)) return;
    const org = newOrg(1_000_000, { budget: 2 * PER_CALL + 800 });
    openCall(org, {
      campaign_id: `'${org.campaign}'`,
      status: "'completed'",
      customer_charge: "800",
      billing_applied_at: "now()",
    });
    openCall(org, {
      campaign_id: `'${org.campaign}'`,
      status: "'failed'",
      resolution_source: "'start_failure'",
    });
    assert.equal(admit(org, claimed(org))["result"], "admitted"); // 800 + 2000 <= 4800
    assert.equal(admit(org, claimed(org))["result"], "admitted"); // 800 + 4000 <= 4800
    const refused = admit(org, claimed(org));
    assert.equal(refused["reason"], "budget_exhausted");
    assert.equal(refused["committed"], 800 + 2 * PER_CALL);
    // Another campaign's spend does not count against this one.
    const second = randomUUID();
    rows(`RESET ROLE; INSERT INTO public.campaigns (id, organization_id, name, status, phone_number_id, agent_config_id, context, context_version, context_reviewed_at, budget_limit)
            VALUES ('${second}', '${org.id}', 'C2', 'running', '${org.number}', '${org.agent}', ${CONTEXT}, 1, now(), ${PER_CALL});`);
    assert.equal(admit(org, claimed(org, phone(), second), 10, second)["result"], "admitted");
  });

  test("an unresolved call to the same number elsewhere refuses as destination_busy, nothing written", (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    const to = phone();
    openCall(org, { destination_number: `'${to}'` });
    const before = callCount(org);
    assert.equal(admit(org, claimed(org, to))["reason"], "destination_busy");
    assert.equal(callCount(org), before);
  });

  test("concurrent admissions never exceed the campaign budget", async (t) => {
    if (!ready(t)) return;
    const org = newOrg(1_000_000, { budget: 3 * PER_CALL });
    const contacts = Array.from({ length: 10 }, () => claimed(org));
    const results = await Promise.all(contacts.map((c) => runAsync(admitSql(org, c, 100))));
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const answers = results.map(
      (r) => JSON.parse(r.stdout.trim().split("\n").pop()!) as Record<string, unknown>,
    );
    assert.equal(answers.filter((a) => a["result"] === "admitted").length, 3);
    assert.equal(answers.filter((a) => a["reason"] === "budget_exhausted").length, 7);
    assert.equal(callCount(org), 3);
  });

  test("concurrent admissions never exceed the in-flight limit", async (t) => {
    if (!ready(t)) return;
    const org = newOrg(1_000_000);
    const contacts = Array.from({ length: 8 }, () => claimed(org));
    const results = await Promise.all(contacts.map((c) => runAsync(admitSql(org, c, 3))));
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    assert.equal(callCount(org), 3);
  });

  test("not callable by customers (authenticated) directly", (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    const c = claimed(org);
    const r = execSql!(`SET ROLE authenticated;\n${admitSql(org, c)}`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /permission denied/);
  });
});

describe("customer grants", () => {
  test("customers may set the description and budget, never the reviewed context", (t) => {
    if (!ready(t)) return;
    // Production's table ACL (verified read-only: authenticated=r): the stand-in's
    // default privileges grant everything, so reset to production first, then
    // re-run the migration's own grants.
    const reset = execSql!(`REVOKE ALL ON public.campaigns FROM authenticated;
      GRANT SELECT ON public.campaigns TO authenticated;
      GRANT INSERT (organization_id, business_id, agent_config_id, phone_number_id, name, objective, call_instructions,
        variable_mapping, output_variable_defs, language, voice_id, schedule, max_attempts, retry_after_minutes,
        retry_statuses, created_by) ON public.campaigns TO authenticated;
      GRANT UPDATE (business_id, agent_config_id, phone_number_id, name, objective, call_instructions, variable_mapping,
        output_variable_defs, language, voice_id, schedule, max_attempts, retry_after_minutes, retry_statuses)
        ON public.campaigns TO authenticated;`);
    assert.equal(reset.status, 0, reset.stderr);
    const reapplied = execSql!(`BEGIN;
${readFileSync(join(migrationsDir, MIGRATION), "utf8")}
COMMIT;`);
    assert.equal(reapplied.status, 0, reapplied.stderr);
    const priv = (col: string) =>
      rows(
        `SELECT has_column_privilege('authenticated', 'public.campaigns', '${col}', 'UPDATE');`,
      )[0];
    assert.equal(priv("description"), "t");
    assert.equal(priv("budget_limit"), "t");
    for (const col of [
      "context",
      "context_version",
      "context_reviewed_at",
      "context_reviewed_by",
      "status",
    ])
      assert.equal(priv(col), "f", col);
  });

  test("a reviewed timestamp without a context is rejected; a non-positive budget is rejected", (t) => {
    if (!ready(t)) return;
    const org = newOrg(0);
    const bad = run(
      `RESET ROLE; UPDATE public.campaigns SET context = NULL WHERE id = '${org.campaign}';`,
    );
    assert.notEqual(bad.status, 0);
    const zero = run(
      `RESET ROLE; UPDATE public.campaigns SET budget_limit = 0 WHERE id = '${org.campaign}';`,
    );
    assert.notEqual(zero.status, 0);
  });
});

describe("admit_single_outbound_call now reserves for open campaign calls", () => {
  test("an open campaign call's worst case counts against the wallet for a single call", (t) => {
    if (!ready(t)) return;
    const org = newOrg(PER_CALL + PER_CALL / 2);
    openCall(org, { campaign_id: `'${org.campaign}'` }); // reserves PER_CALL
    const key = `k_${randomUUID().replace(/-/g, "")}`;
    const r = JSON.parse(
      rows(
        `SELECT public.admit_single_outbound_call('${org.id}', '${org.number}', '${phone()}', '+917900000001', '${key}', 3, 30, 100, 2);`,
      )[0]!,
    ) as Record<string, unknown>;
    assert.equal(r["reason"], "insufficient_balance");
    assert.equal(r["required"], 2 * PER_CALL);
  });
});

describe("audit fixes: emergency stop, in-flight window, unbilled reservations, campaign lock", () => {
  const singleSql = (org: Org, to = phone()) =>
    `SELECT public.admit_single_outbound_call('${org.id}', '${org.number}', '${to}', '+917900000001', 'k_${randomUUID().replace(/-/g, "")}', 3, 30, 100, 2);`;
  const single = (org: Org) => JSON.parse(rows(singleSql(org))[0]!) as Record<string, unknown>;

  test("the database stop flag refuses every new admission, single and campaign, until it is cleared", (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    rows(`RESET ROLE; INSERT INTO public.platform_settings (key, value) VALUES ('outbound.calling_paused', '{"enabled": true}')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);
    try {
      assert.equal(admit(org, claimed(org))["reason"], "outbound_paused");
      assert.equal(single(org)["reason"], "outbound_paused");
      assert.equal(callCount(org), 0);
    } finally {
      rows(
        `RESET ROLE; UPDATE public.platform_settings SET value = '{"enabled": false}' WHERE key = 'outbound.calling_paused';`,
      );
    }
    assert.equal(admit(org, claimed(org))["result"], "admitted");
    assert.equal(single(org)["result"], "admitted");
  });

  test("a call started over 15 minutes ago no longer holds an in-flight slot, but still reserves the wallet", (t) => {
    if (!ready(t)) return;
    const org = newOrg(2 * PER_CALL);
    for (let i = 0; i < 3; i++) openCall(org, { started_at: "now() - interval '20 minutes'" });
    // In-flight: not counted. Wallet: 3 x PER_CALL reserved > balance.
    assert.equal(admit(org, claimed(org), 1)["reason"], "insufficient_balance");
    rows(
      `RESET ROLE; INSERT INTO public.wallet_transactions (organization_id, amount, kind, description) VALUES ('${org.id}', ${2 * PER_CALL}, 'topup', 'more');`,
    );
    assert.equal(
      admit(org, claimed(org), 1)["result"],
      "admitted",
      "old stuck calls do not block in-flight",
    );
  });

  test("a call that ended but is not billed yet still reserves the wallet; once billed it does not", (t) => {
    if (!ready(t)) return;
    const org = newOrg(PER_CALL + PER_CALL / 2);
    // Inserted final: the finalization trigger marks it pending (not billed).
    openCall(org, { status: "'completed'" });
    assert.deepEqual(
      rows(`SELECT finalization_state FROM public.call_logs WHERE organization_id = '${org.id}';`),
      ["pending"],
    );
    assert.equal(admit(org, claimed(org))["reason"], "insufficient_balance");
    assert.equal(single(org)["reason"], "insufficient_balance");
    rows(`RESET ROLE; UPDATE public.call_logs SET billing_applied_at = now(), campaign_applied_at = now(), customer_charge = 0, finalization_state = 'done'
            WHERE organization_id = '${org.id}';`);
    assert.equal(admit(org, claimed(org))["result"], "admitted");
  });

  test("single-call in-flight counts open campaign calls too: one limit per customer", (t) => {
    if (!ready(t)) return;
    const org = newOrg(1_000_000);
    for (let i = 0; i < 3; i++) openCall(org, { campaign_id: `'${org.campaign}'` });
    assert.equal(single(org)["reason"], "in_flight_limit");
  });

  test("campaign admission share-locks the campaign row: a cancel waits for it to commit", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      rows(`SELECT count(*) FROM pg_proc WHERE proname = 'admit_campaign_outbound_call'
              AND prosrc LIKE '%FROM public.campaigns WHERE id = _campaign FOR SHARE%';`),
      ["1"],
    );
  });
});

describe("M5: calling hours inside both admissions (09:00-21:00 Asia/Kolkata)", () => {
  const at = (ist: string) => `SET clickai.admission_now = '2026-11-20 ${ist}+05:30';`;
  const singleAt = (org: Org, ist: string) =>
    JSON.parse(
      rows(
        `${at(ist)} SELECT public.admit_single_outbound_call('${org.id}', '${org.number}', '${phone()}', '+917900000001', 'k_${randomUUID().replace(/-/g, "")}', 3, 30, 100, 2);`,
      )[0]!,
    ) as Record<string, unknown>;
  const campaignAt = (org: Org, ist: string) =>
    JSON.parse(rows(`${at(ist)} ${admitSql(org, claimed(org))}`)[0]!) as Record<string, unknown>;

  test("the boundary: 08:59 and 21:00 are refused, 09:00 and 20:59 admitted, for single and campaign calls", (t) => {
    if (!ready(t)) return;
    for (const [ist, ok] of [
      ["08:59:59", false],
      ["09:00:00", true],
      ["20:59:59", true],
      ["21:00:00", false],
      ["23:30:00", false],
    ] as const) {
      const org = newOrg(1_000_000);
      const expect = ok ? "admitted" : "outside_calling_hours";
      const c = campaignAt(org, ist);
      assert.equal(
        c["result"] === "admitted" ? "admitted" : c["reason"],
        expect,
        `campaign ${ist}`,
      );
      const s1 = singleAt(org, ist);
      assert.equal(
        s1["result"] === "admitted" ? "admitted" : s1["reason"],
        expect,
        `single ${ist}`,
      );
    }
  });

  test("the hours are India time whatever the session time zone", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      rows(`SET TIME ZONE 'America/New_York';
            SELECT public.within_outbound_calling_hours('2026-11-20 03:30:00+00'),
                   public.within_outbound_calling_hours('2026-11-20 03:29:59+00'),
                   public.within_outbound_calling_hours('2026-11-20 15:29:59+00'),
                   public.within_outbound_calling_hours('2026-11-20 15:30:00+00');`),
      ["t|f|t|f"],
    );
  });

  test("dispatched before the cutoff, admitted after it: refused, nothing written", (t) => {
    if (!ready(t)) return;
    const org = newOrg(1_000_000);
    // The dispatcher passed its own check at 20:59:59; admission runs a moment later.
    const r = campaignAt(org, "21:00:00.001");
    assert.equal(r["reason"], "outside_calling_hours");
    assert.equal(callCount(org), 0);
  });

  test("a repeated single-call request after the cutoff still returns its own earlier call", (t) => {
    if (!ready(t)) return;
    const org = newOrg(1_000_000);
    const key = `k_${randomUUID().replace(/-/g, "")}`;
    const to = phone();
    const sql = (ist: string) =>
      `${at(ist)} SELECT public.admit_single_outbound_call('${org.id}', '${org.number}', '${to}', '+917900000001', '${key}', 3, 30, 100, 2);`;
    const first = JSON.parse(rows(sql("20:59:00"))[0]!) as Record<string, unknown>;
    const again = JSON.parse(rows(sql("21:05:00"))[0]!) as Record<string, unknown>;
    assert.equal(first["result"], "admitted");
    assert.equal(again["result"], "duplicate");
    assert.equal(again["call_id"], first["call_id"]);
  });
});

describe("M4: each campaign call keeps the exact reviewed context it was admitted with", () => {
  const snapshot = (call: string) =>
    JSON.parse(
      rows(`SELECT campaign_context_snapshot FROM public.call_logs WHERE id = '${call}';`)[0]!,
    ) as Record<string, unknown>;

  test("the snapshot holds the version, review time, structured context and the text sent", (t) => {
    if (!ready(t)) return;
    const org = newOrg(1_000_000);
    const c = claimed(org);
    assert.equal(admit(org, c)["result"], "admitted");
    const snap = snapshot(c.call);
    assert.equal(snap["version"], 1);
    assert.equal(
      snap["reviewed_at"],
      JSON.parse(
        rows(
          `SELECT to_jsonb(context_reviewed_at) FROM public.campaigns WHERE id = '${org.campaign}';`,
        )[0]!,
      ),
    );
    assert.deepEqual(snap["context"], { version: 1, objective: "Invite for a check-up" });
    assert.deepEqual(snap["sent"], {
      campaign_objective: "Sent objective",
      campaign_instructions: "Sent instructions",
    });
  });

  test("a context compiled from another reviewed version is refused, nothing written", (t) => {
    if (!ready(t)) return;
    const org = newOrg(1_000_000);
    const c = claimed(org);
    const stale = `SELECT public.admit_campaign_outbound_call('${org.campaign}', '${c.cc}', '${c.call}', '${c.to}', 0, 10,
      '2020-01-01T00:00:00Z', 'old', 'old');`;
    assert.equal(
      (JSON.parse(rows(stale)[0]!) as Record<string, unknown>)["reason"],
      "context_changed",
    );
    assert.equal(callCount(org), 0);
  });

  test("later edits never change a past call; a retry records the new version; the snapshot cannot be rewritten", (t) => {
    if (!ready(t)) return;
    const org = newOrg(1_000_000);
    const first = claimed(org);
    assert.equal(admit(org, first)["result"], "admitted");
    const before = snapshot(first.call);
    // The call ends; the customer pauses, edits and re-reviews, resumes; the contact is retried.
    rows(`RESET ROLE;
      UPDATE public.call_logs SET status = 'no_answer' WHERE id = '${first.call}';
      UPDATE public.campaigns SET context = '{"version":1,"objective":"Second version"}'::jsonb,
             context_reviewed_at = now() + interval '1 minute' WHERE id = '${org.campaign}';`);
    const retryCall = randomUUID();
    rows(`RESET ROLE; UPDATE public.campaign_contacts SET status = 'calling', attempts = 2, current_call_id = '${retryCall}'
            WHERE id = '${first.cc}';`);
    const retry = { cc: first.cc, call: retryCall, to: first.to };
    assert.equal(admit(org, retry)["result"], "admitted");
    assert.deepEqual(snapshot(first.call), before, "the first call keeps its own version");
    assert.deepEqual(
      (snapshot(retryCall)["context"] as Record<string, unknown>)["objective"],
      "Second version",
    );
    const rewrite = run(
      `UPDATE public.call_logs SET campaign_context_snapshot = '{}'::jsonb WHERE id = '${first.call}';`,
    );
    assert.notEqual(rewrite.status, 0);
    assert.match(rewrite.stderr, /keeps the campaign context it was admitted with/);
    // Other columns still update normally (finalization, reconciliation).
    rows(`UPDATE public.call_logs SET status = 'outcome_unknown' WHERE id = '${retryCall}';`);
  });
});

describe("rollback", () => {
  test("removes the function and columns; excluded contacts become cancelled; calls survive", (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    const c = claimed(org);
    assert.equal(admit(org, c)["result"], "admitted");
    rows(
      `RESET ROLE; INSERT INTO public.contacts (id, organization_id, phone) VALUES ('${randomUUID()}', '${org.id}', '${phone()}');`,
    );
    const ex = randomUUID();
    const exContact = randomUUID();
    rows(`RESET ROLE;
      INSERT INTO public.contacts (id, organization_id, phone) VALUES ('${exContact}', '${org.id}', '${phone()}');
      INSERT INTO public.campaign_contacts (id, campaign_id, organization_id, contact_id, status, excluded_reason)
        VALUES ('${ex}', '${org.campaign}', '${org.id}', '${exContact}', 'excluded', 'country_not_allowed');`);
    const r = execSql!(ROLLBACK);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      rows(
        `SELECT count(*) FROM pg_proc WHERE proname IN ('admit_campaign_outbound_call', 'call_logs_context_snapshot_immutable');`,
      ),
      ["0"],
    );
    assert.deepEqual(
      rows(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'call_logs' AND column_name = 'campaign_context_snapshot';`),
      ["0"],
    );
    assert.deepEqual(
      rows(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
              AND ((table_name = 'campaigns' AND column_name IN ('description','context','context_version','context_reviewed_at','context_reviewed_by','budget_limit'))
                OR (table_name = 'campaign_contacts' AND column_name = 'excluded_reason'));`),
      ["0"],
    );
    assert.deepEqual(rows(`SELECT status FROM public.campaign_contacts WHERE id = '${ex}';`), [
      "cancelled",
    ]);
    assert.deepEqual(rows(`SELECT status FROM public.call_logs WHERE id = '${c.call}';`), [
      "initiated",
    ]);
    const reapplied = execSql!(
      `BEGIN;\n${readFileSync(join(migrationsDir, MIGRATION), "utf8")}\nCOMMIT;`,
    );
    assert.equal(reapplied.status, 0, reapplied.stderr);
  });
});
