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
 * 20261110090000_sarvam_outbound_call_finalization on a disposable cluster:
 * every migration replayed in order, existing calls seeded just before it,
 * then the trigger, the lease, each step's exactly-once checkpoint (including
 * a failure injected mid-transaction), concurrency between two real sessions,
 * and permissions — all against real PostgreSQL.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const FIX = "20261110090000_sarvam_outbound_call_finalization.sql";
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

const ORG = randomUUID();
const ORG_2 = randomUUID();
const OWNER = randomUUID();
const CAMPAIGN = randomUUID();
// Seeded before the migration:
const LEGACY_DONE = randomUUID(); // a finished Sarvam outbound call
const LEGACY_EXOTEL = randomUUID(); // another provider's finished call
const INFLIGHT_CC = randomUUID(); // a campaign contact on an in-flight call
const INFLIGHT_CALL = randomUUID();

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;

const sql = (statement: string): RunResult => execSql!(statement);

function rows(statement: string): string[] {
  const r = sql(`\\pset format unaligned\n\\pset tuples_only on\n${statement}`);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
}
const one = (statement: string) => rows(statement)[0];

let n = 0;
const number = () => `+9196${String(++n).padStart(8, "0")}`;

/** A contact enrolled in CAMPAIGN, claimed for a call (current_call_id), plus that call. */
function campaignCall(
  opts: { attempts?: number; callStatus?: string; org?: string; campaign?: string } = {},
) {
  const contact = randomUUID();
  const cc = randomUUID();
  const call = randomUUID();
  const attempts = opts.attempts ?? 1;
  const org = opts.org ?? ORG;
  const campaign = opts.campaign ?? CAMPAIGN;
  const s = `
INSERT INTO public.contacts (id, organization_id, phone, name) VALUES ('${contact}', '${org}', '${number()}', 'Asha');
INSERT INTO public.campaign_contacts (id, campaign_id, organization_id, contact_id, status, attempts, current_call_id)
  VALUES ('${cc}', '${campaign}', '${org}', '${contact}', 'calling', ${attempts}, '${call}');
INSERT INTO public.call_logs (id, organization_id, provider, direction, status, destination_number, campaign_id, campaign_contact_id, contact_id, retry_attempt)
  VALUES ('${call}', '${org}', 'sarvam', 'outbound', '${opts.callStatus ?? "initiated"}', '${number()}', '${campaign}', '${cc}', '${contact}', ${attempts - 1});`;
  return { contact, cc, call, sql: s };
}

/** A single (non-campaign) Sarvam outbound call. */
function singleCall(org = ORG) {
  const call = randomUUID();
  return {
    call,
    sql: `INSERT INTO public.call_logs (id, organization_id, provider, direction, status, destination_number)
      VALUES ('${call}', '${org}', 'sarvam', 'outbound', 'initiated', '${number()}');`,
  };
}

const finish = (call: string, status = "completed", seconds = 61) =>
  `UPDATE public.call_logs SET status = '${status}', duration_seconds = ${seconds}, ended_at = now() WHERE id = '${call}';`;
const claim = (call: string) =>
  one(`SELECT coalesce(public.claim_call_finalization('${call}')::text, 'null');`)!;
const bill = (call: string, token: string, amount = 1000, minutes = 2) =>
  one(
    `SELECT public.apply_call_billing('${call}', '${token}', ${amount}, ${amount / 2}, 'INR', ${minutes}, 'outbound call · ${minutes} min');`,
  )!;
const campaignStep = (call: string, token: string, contactStatus = "completed", lead = true) =>
  JSON.parse(
    one(
      `SELECT public.apply_call_campaign_outcome('${call}', '${token}', '${contactStatus}', NULL, '{"interest_level":"high"}'::jsonb, ${lead}, 'hot', 'notes')::text;`,
    )!,
  ) as {
    result: string;
    contact_updated?: boolean;
    lead_created?: boolean;
    campaign_completed?: boolean;
  };
const complete = (call: string, token: string) =>
  one(`SELECT public.complete_call_finalization('${call}', '${token}')::text;`);
const debits = (call: string) =>
  one(
    `SELECT count(*) || '|' || coalesce(sum(amount), 0) FROM public.wallet_transactions WHERE kind = 'call_usage' AND reference = '${call}';`,
  );
const usage = (call: string) =>
  one(`SELECT count(*) FROM public.usage_records WHERE call_id = '${call}';`);
const leads = (call: string) => one(`SELECT count(*) FROM public.leads WHERE call_id = '${call}';`);
const state = (call: string) =>
  one(
    `SELECT coalesce(finalization_state, 'null') || '|' || (billing_applied_at IS NOT NULL) || '|' || (campaign_applied_at IS NOT NULL) FROM public.call_logs WHERE id = '${call}';`,
  );

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
  let seeded = false;
  for (const file of MIGRATIONS) {
    if (file === FIX) {
      const contact = randomUUID();
      const seed = sql(`
        INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'Smile Dental', '${OWNER}'), ('${ORG_2}', 'Other Clinic', '${OWNER}');
        INSERT INTO public.campaigns (id, organization_id, name, status, max_attempts) VALUES ('${CAMPAIGN}', '${ORG}', 'Recall', 'running', 3);
        INSERT INTO public.call_logs (id, organization_id, provider, direction, status, destination_number, ended_at)
          VALUES ('${LEGACY_DONE}', '${ORG}', 'sarvam', 'outbound', 'completed', '+919500000001', now()),
                 ('${LEGACY_EXOTEL}', '${ORG}', 'exotel', 'outbound', 'completed', '+919500000002', now());
        INSERT INTO public.contacts (id, organization_id, phone) VALUES ('${contact}', '${ORG}', '+919500000003');
        INSERT INTO public.campaign_contacts (id, campaign_id, organization_id, contact_id, status, attempts)
          VALUES ('${INFLIGHT_CC}', '${CAMPAIGN}', '${ORG}', '${contact}', 'calling', 1);
        INSERT INTO public.call_logs (id, organization_id, provider, direction, status, destination_number, campaign_id, campaign_contact_id, contact_id)
          VALUES ('${INFLIGHT_CALL}', '${ORG}', 'sarvam', 'outbound', 'initiated', '+919500000003', '${CAMPAIGN}', '${INFLIGHT_CC}', '${contact}');`);
      if (seed.status !== 0) {
        setupFailure = `seed failed: ${seed.stderr}`;
        return;
      }
      seeded = true;
    }
    const applied = sql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  if (!seeded) setupFailure = `migration ${FIX} not found`;
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

describe("existing data", () => {
  pgTest(
    "finished Sarvam outbound calls are marked done (never re-billed); other providers untouched",
    () => {
      assert.equal(state(LEGACY_DONE), "done|true|true");
      assert.equal(
        one(`SELECT resolution_source FROM public.call_logs WHERE id = '${LEGACY_DONE}';`),
        "legacy",
      );
      assert.equal(state(LEGACY_EXOTEL), "null|false|false");
      assert.equal(claim(LEGACY_DONE), "null");
    },
  );

  pgTest("a contact in flight points at its single in-flight call", () => {
    assert.equal(
      one(`SELECT current_call_id FROM public.campaign_contacts WHERE id = '${INFLIGHT_CC}';`),
      INFLIGHT_CALL,
    );
  });
});

describe("trigger: no Sarvam outbound final status can skip finalization", () => {
  pgTest("the first final status marks the call pending; earlier statuses don't", () => {
    const c = singleCall();
    assert.equal(sql(c.sql).status, 0);
    assert.equal(state(c.call), "null|false|false");
    assert.equal(
      sql(`UPDATE public.call_logs SET status = 'outcome_unknown' WHERE id = '${c.call}';`).status,
      0,
    );
    assert.equal(state(c.call), "null|false|false");
    assert.equal(sql(finish(c.call, "failed", 0)).status, 0);
    assert.equal(state(c.call), "pending|false|false");
  });

  pgTest("Sarvam inbound, Exotel and Vobiz calls are never marked", () => {
    for (const [provider, direction] of [
      ["sarvam", "inbound"],
      ["exotel", "outbound"],
      ["vobiz", "inbound"],
      ["livekit_sip", "inbound"],
    ]) {
      const id = randomUUID();
      assert.equal(
        sql(`INSERT INTO public.call_logs (id, organization_id, provider, direction, status, destination_number)
             VALUES ('${id}', '${ORG}', '${provider}', '${direction}', 'ringing', '${number()}');
             ${finish(id)}`).status,
        0,
      );
      assert.equal(state(id), "null|false|false", `${provider} ${direction}`);
    }
  });

  pgTest("'done' needs both checkpoints, enforced by the database", () => {
    const c = singleCall();
    sql(c.sql + finish(c.call));
    const r = sql(
      `UPDATE public.call_logs SET finalization_state = 'done' WHERE id = '${c.call}';`,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /call_logs_finalization_done_check/);
  });
});

describe("lease", () => {
  pgTest(
    "one holder at a time; an expired lease can be taken over; a stale holder is refused",
    () => {
      const c = singleCall();
      sql(c.sql + finish(c.call));
      const first = claim(c.call);
      assert.match(first, /^[0-9a-f-]{36}$/);
      assert.equal(claim(c.call), "null", "a live lease can't be claimed again");

      sql(
        `UPDATE public.call_logs SET finalization_lease_expires_at = now() - interval '1 second' WHERE id = '${c.call}';`,
      );
      const second = claim(c.call);
      assert.match(second, /^[0-9a-f-]{36}$/);
      assert.notEqual(second, first);
      assert.equal(bill(c.call, first), "lease_lost", "the stale holder writes nothing");
      assert.equal(debits(c.call), "0|0");
      assert.equal(bill(c.call, second), "applied");
      assert.equal(
        one(`SELECT finalization_attempts FROM public.call_logs WHERE id = '${c.call}';`),
        "2",
      );
    },
  );

  pgTest("a holder whose lease expired is refused even with the right token", () => {
    const c = singleCall();
    sql(c.sql + finish(c.call));
    const token = claim(c.call);
    sql(
      `UPDATE public.call_logs SET finalization_lease_expires_at = now() - interval '1 second' WHERE id = '${c.call}';`,
    );
    assert.equal(bill(c.call, token), "lease_lost");
    assert.equal(campaignStep(c.call, token).result, "lease_lost");
  });
});

describe("billing step: exactly once, effects and checkpoint together", () => {
  pgTest("debit, usage record and charge once; a repeat is 'already'", () => {
    const c = singleCall();
    sql(c.sql + finish(c.call));
    const token = claim(c.call);
    assert.equal(bill(c.call, token), "applied");
    assert.equal(bill(c.call, token), "already");
    assert.equal(debits(c.call), "1|-1000");
    assert.equal(usage(c.call), "1");
    assert.equal(
      one(
        `SELECT customer_charge || '|' || provider_cost || '|' || (billing_applied_at IS NOT NULL) FROM public.call_logs WHERE id = '${c.call}';`,
      ),
      "1000|500|true",
    );
  });

  pgTest("a zero charge writes no debit but still sets the checkpoint", () => {
    const c = singleCall();
    sql(c.sql + finish(c.call, "failed", 0));
    const token = claim(c.call);
    assert.equal(bill(c.call, token, 0, 0), "applied");
    assert.equal(debits(c.call), "0|0");
    assert.equal(usage(c.call), "0");
    assert.equal(bill(c.call, token, 0, 0), "already");
  });

  pgTest("a failure after the debit (in record_call_usage) rolls the debit back too", () => {
    const c = singleCall();
    sql(c.sql + finish(c.call));
    const token = claim(c.call);
    // Injected failure inside the same transaction; ON_ERROR_STOP ends the
    // session at the error, so everything here (the trigger too) rolls back.
    const r = sql(`BEGIN;
CREATE FUNCTION public.fail_usage_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected usage failure'; END $$;
CREATE TRIGGER fail_usage BEFORE INSERT ON public.usage_records FOR EACH ROW EXECUTE FUNCTION public.fail_usage_insert();
SELECT public.apply_call_billing('${c.call}', '${token}', 1000, 500, 'INR', 2, 'x');
COMMIT;`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /injected usage failure/);
    assert.equal(debits(c.call), "0|0", "no debit without its checkpoint");
    assert.equal(state(c.call), "pending|false|false");
    assert.equal(bill(c.call, token), "applied", "the same holder can simply run it again");
    assert.equal(debits(c.call), "1|-1000");
  });
});

describe("campaign step: exactly once, guarded by current_call_id", () => {
  pgTest("updates the contact on this call, creates one lead, and repeats as 'already'", () => {
    const c = campaignCall();
    sql(c.sql + finish(c.call));
    const token = claim(c.call);
    const first = campaignStep(c.call, token);
    assert.equal(first.result, "applied");
    assert.equal(first.contact_updated, true);
    assert.equal(first.lead_created, true);
    assert.equal(campaignStep(c.call, token).result, "already");
    assert.equal(leads(c.call), "1");
    assert.equal(
      one(
        `SELECT status || '|' || outcome || '|' || attempts FROM public.campaign_contacts WHERE id = '${c.cc}';`,
      ),
      "completed|completed|1",
      "finalization never changes attempts",
    );
  });

  pgTest(
    "a contact that has moved on to another call is never touched (but the step is recorded)",
    () => {
      const c = campaignCall();
      sql(c.sql + finish(c.call, "no_answer", 0));
      sql(
        `UPDATE public.campaign_contacts SET current_call_id = '${randomUUID()}', attempts = 2 WHERE id = '${c.cc}';`,
      );
      const token = claim(c.call);
      const result = campaignStep(c.call, token, "retry_scheduled", false);
      assert.equal(result.result, "applied");
      assert.equal(result.contact_updated, false);
      assert.equal(
        one(`SELECT status || '|' || attempts FROM public.campaign_contacts WHERE id = '${c.cc}';`),
        "calling|2",
      );
      assert.equal(state(c.call), "pending|false|true");
    },
  );

  pgTest("an opted-out outcome marks the contact do-not-call", () => {
    const c = campaignCall();
    sql(c.sql + finish(c.call));
    const token = claim(c.call);
    campaignStep(c.call, token, "opted_out", false);
    assert.equal(
      one(`SELECT opted_out::text FROM public.contacts WHERE id = '${c.contact}';`),
      "true",
    );
  });

  pgTest("a second lead for the same call is refused by the database", () => {
    const c = campaignCall();
    sql(c.sql + finish(c.call));
    campaignStep(c.call, claim(c.call));
    const r = sql(
      `INSERT INTO public.leads (organization_id, call_id, source) VALUES ('${ORG}', '${c.call}', 'campaign');`,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /idx_leads_campaign_call/);
  });

  pgTest("a failure after the contact update (lead insert) rolls the contact back too", () => {
    const c = campaignCall();
    sql(c.sql + finish(c.call));
    const token = claim(c.call);
    const r = sql(`BEGIN;
CREATE FUNCTION public.fail_lead_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected lead failure'; END $$;
CREATE TRIGGER fail_lead BEFORE INSERT ON public.leads FOR EACH ROW EXECUTE FUNCTION public.fail_lead_insert();
SELECT public.apply_call_campaign_outcome('${c.call}', '${token}', 'completed', NULL, '{}'::jsonb, true, 'warm', NULL);
COMMIT;`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /injected lead failure/);
    assert.equal(
      one(`SELECT status FROM public.campaign_contacts WHERE id = '${c.cc}';`),
      "calling",
    );
    assert.equal(leads(c.call), "0");
    assert.equal(state(c.call), "pending|false|false");
  });

  pgTest("the last open contact completes a running campaign, once", () => {
    const camp = randomUUID();
    sql(
      `INSERT INTO public.campaigns (id, organization_id, name, status) VALUES ('${camp}', '${ORG}', 'Solo', 'running');`,
    );
    const c = campaignCall({ campaign: camp });
    sql(c.sql + finish(c.call));
    const result = campaignStep(c.call, claim(c.call));
    assert.equal(result.campaign_completed, true);
    assert.equal(one(`SELECT status FROM public.campaigns WHERE id = '${camp}';`), "completed");
  });

  pgTest("a call with no campaign just records the step", () => {
    const c = singleCall();
    sql(c.sql + finish(c.call));
    const token = claim(c.call);
    const r = JSON.parse(
      one(
        `SELECT public.apply_call_campaign_outcome('${c.call}', '${token}', NULL, NULL, '{}'::jsonb, false, 'warm', NULL)::text;`,
      )!,
    );
    assert.equal(r.result, "applied");
    assert.equal(state(c.call), "pending|false|true");
  });
});

describe("complete and fail", () => {
  pgTest("complete needs both checkpoints and the current lease", () => {
    const c = singleCall();
    sql(c.sql + finish(c.call));
    const token = claim(c.call);
    bill(c.call, token);
    assert.equal(complete(c.call, token), "false");
    campaignStep(c.call, token);
    assert.equal(complete(c.call, randomUUID()), "false");
    assert.equal(complete(c.call, token), "true");
    assert.equal(state(c.call), "done|true|true");
    assert.equal(claim(c.call), "null", "nothing left to claim");
  });

  pgTest("fail records the error, schedules a retry time and releases the lease", () => {
    const c = singleCall();
    sql(c.sql + finish(c.call));
    const token = claim(c.call);
    assert.equal(
      one(
        `SELECT public.fail_call_finalization('${c.call}', '${token}', 'billing: db down')::text;`,
      ),
      "true",
    );
    assert.equal(
      one(
        `SELECT finalization_state || '|' || finalization_error || '|' || (finalization_next_at > now()) || '|' || (finalization_lease_token IS NULL) FROM public.call_logs WHERE id = '${c.call}';`,
      ),
      "failed|billing: db down|true|true",
    );
    assert.match(claim(c.call), /^[0-9a-f-]{36}$/, "an admin retry can claim it straight away");
  });
});

describe("concurrency between two real sessions", () => {
  /** Session A runs `first` in an open transaction; session B (dblink) runs `second`, must wait on A's lock; A commits. */
  function race(first: string, second: string, waitMarker: string) {
    assert.deepEqual(
      rows(`SELECT count(*) FROM pg_available_extensions WHERE name = 'dblink';`),
      ["1"],
      "the dblink extension is not installed with this PostgreSQL server; install the server's standard contrib extensions",
    );
    const r = sql(`
CREATE EXTENSION IF NOT EXISTS dblink;
\\pset format unaligned
\\pset tuples_only on
SELECT dblink_connect('race', CASE
  WHEN inet_server_addr() IS NOT NULL
    THEN format('host=%s port=%s dbname=%s user=postgres', host(inet_server_addr()), current_setting('port'), current_database())
  ELSE format('host=%s port=%s dbname=%s user=postgres', split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database())
END);
BEGIN;
${first}
SELECT dblink_send_query('race', ${"$q$"}${second}${"$q$"});
SELECT pg_sleep(0.5);
SELECT 'B waiting on lock: ' || EXISTS (
  SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%${waitMarker}%' AND pid <> pg_backend_pid()
);
COMMIT;
SELECT 'B result: ' || coalesce((SELECT v FROM dblink_get_result('race', false) AS t(v text) LIMIT 1), 'error');
SELECT 'B error: ' || dblink_error_message('race');
SELECT dblink_disconnect('race');
`);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }

  pgTest("two claims at once: the second waits, then gets no lease", () => {
    const c = singleCall();
    sql(c.sql + finish(c.call));
    const out = race(
      `SELECT public.claim_call_finalization('${c.call}');`,
      `SELECT coalesce(public.claim_call_finalization('${c.call}')::text, 'null')`,
      "claim_call_finalization",
    );
    assert.match(out, /B waiting on lock: true/);
    assert.match(out, /B result: null/);
  });

  pgTest("the same billing step twice at once (a webhook and an admin retry): one debit", () => {
    const c = singleCall();
    sql(c.sql + finish(c.call));
    const token = claim(c.call);
    const step = `public.apply_call_billing('${c.call}', '${token}', 1000, 500, 'INR', 2, 'x')`;
    const out = race(`SELECT ${step};`, `SELECT ${step}`, "apply_call_billing");
    assert.match(out, /B waiting on lock: true/);
    assert.match(out, /B result: already/);
    assert.equal(debits(c.call), "1|-1000");
    assert.equal(usage(c.call), "1");
  });

  pgTest("the same campaign step twice at once: one contact update, one lead", () => {
    const c = campaignCall();
    sql(c.sql + finish(c.call));
    const token = claim(c.call);
    const step = `public.apply_call_campaign_outcome('${c.call}', '${token}', 'completed', NULL, '{}'::jsonb, true, 'warm', NULL)`;
    const out = race(
      `SELECT ${step};`,
      `SELECT (${step})->>'result'`,
      "apply_call_campaign_outcome",
    );
    assert.match(out, /B waiting on lock: true/);
    assert.match(out, /B result: already/);
    assert.equal(leads(c.call), "1");
  });

  pgTest("two calls of one organization billed at once: both succeed, no deadlock", () => {
    const a = singleCall();
    const b = singleCall();
    sql(a.sql + b.sql + finish(a.call) + finish(b.call));
    const ta = claim(a.call);
    const tb = claim(b.call);
    const out = race(
      `SELECT public.apply_call_billing('${a.call}', '${ta}', 1000, 500, 'INR', 2, 'x');`,
      `SELECT public.apply_call_billing('${b.call}', '${tb}', 700, 300, 'INR', 1, 'x')`,
      "apply_call_billing",
    );
    assert.match(out, /B waiting on lock: true/, "serialized on the organization's wallet lock");
    assert.match(out, /B result: applied/);
    assert.equal(debits(a.call), "1|-1000");
    assert.equal(debits(b.call), "1|-700");
  });
});

describe("permissions and migration safety", () => {
  pgTest("only service_role may run the finalization functions", () => {
    for (const fn of [
      "public.claim_call_finalization(uuid, integer)",
      "public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text)",
      "public.apply_call_campaign_outcome(uuid, uuid, text, timestamptz, jsonb, boolean, text, text)",
      "public.complete_call_finalization(uuid, uuid)",
      "public.fail_call_finalization(uuid, uuid, text)",
    ]) {
      assert.deepEqual(
        rows(
          `SELECT has_function_privilege('anon', '${fn}', 'EXECUTE') || '|' || has_function_privilege('authenticated', '${fn}', 'EXECUTE') || '|' || has_function_privilege('service_role', '${fn}', 'EXECUTE');`,
        ),
        ["false|false|true"],
        fn,
      );
    }
  });

  pgTest("existing duplicate campaign leads stop the migration, which then changes nothing", () => {
    const c = campaignCall();
    const migration = readFileSync(join(migrationsDir, FIX), "utf8");
    const r = sql(`BEGIN;
DROP INDEX public.idx_leads_campaign_call;
${c.sql}
INSERT INTO public.leads (organization_id, call_id, source) VALUES ('${ORG}', '${c.call}', 'campaign'), ('${ORG}', '${c.call}', 'campaign');
${migration}
COMMIT;`);
    assert.notEqual(r.status, 0);
    assert.match(
      r.stderr,
      /Cannot add idx_leads_campaign_call: 1 call\(s\) already have more than one campaign lead/,
    );
    assert.deepEqual(
      rows(`SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_leads_campaign_call';`),
      ["1"],
    );
    assert.equal(leads(c.call), "0");
  });

  pgTest("the migration runs again cleanly (idempotent)", () => {
    const migration = readFileSync(join(migrationsDir, FIX), "utf8");
    const r = sql(`BEGIN;\n${migration}\nROLLBACK;`);
    assert.equal(r.status, 0, r.stderr);
  });
});
