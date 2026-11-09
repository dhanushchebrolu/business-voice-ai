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
 * 20261109090000_outbound_call_outcome_unknown on a disposable cluster: every
 * migration replayed in order, with rows in EVERY existing call_logs and
 * campaign_contacts status seeded just before it, then the new CHECK lists,
 * the surviving rows and the in-flight index checked against real PostgreSQL.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const FIX = "20261109090000_outbound_call_outcome_unknown.sql";
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

const CALL_STATUSES = [
  "initiated",
  "ringing",
  "answered",
  "in_progress",
  "completed",
  "failed",
  "busy",
  "no_answer",
  "cancelled",
];
const CONTACT_STATUSES = [
  "pending",
  "queued",
  "calling",
  "connected",
  "no_answer",
  "busy",
  "failed",
  "completed",
  "retry_scheduled",
  "opted_out",
  "wrong_number",
  "cancelled",
];

const ORG = randomUUID();
const OWNER = randomUUID();
const CAMPAIGN = randomUUID();

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

const callRow = (status: string, campaignContactId: string | null = null) =>
  `INSERT INTO public.call_logs (organization_id, provider, direction, status, campaign_id, campaign_contact_id)
   VALUES ('${ORG}', 'sarvam', 'outbound', '${status}', ${campaignContactId ? `'${CAMPAIGN}'` : "NULL"}, ${campaignContactId ? `'${campaignContactId}'` : "NULL"});`;

function contactRow(status: string): { sql: string; id: string } {
  const contact = randomUUID();
  const id = randomUUID();
  return {
    id,
    sql: `INSERT INTO public.contacts (id, organization_id, phone) VALUES ('${contact}', '${ORG}', '+91${Math.floor(Math.random() * 1e10)}');
          INSERT INTO public.campaign_contacts (id, campaign_id, organization_id, contact_id, status)
          VALUES ('${id}', '${CAMPAIGN}', '${ORG}', '${contact}', '${status}');`,
  };
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
  const standin = sql(STANDIN);
  if (standin.status !== 0) {
    setupFailure = `stand-in failed: ${standin.stderr}`;
    return;
  }
  let seeded = false;
  for (const file of MIGRATIONS) {
    if (file === FIX) {
      // Existing data in every status the old CHECK lists allowed.
      const seed = sql(`
        INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'Smile Dental', '${OWNER}');
        INSERT INTO public.campaigns (id, organization_id, name) VALUES ('${CAMPAIGN}', '${ORG}', 'Recall');
        ${CALL_STATUSES.map((s) => callRow(s)).join("\n")}
        ${CONTACT_STATUSES.map((s) => contactRow(s).sql).join("\n")}`);
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

describe("existing data survives the migration", () => {
  pgTest("every pre-existing call_logs status row is still present and valid", () => {
    assert.deepEqual(
      rows(`SELECT status FROM public.call_logs WHERE organization_id = '${ORG}' ORDER BY status;`),
      [...CALL_STATUSES].sort(),
    );
  });

  pgTest("every pre-existing campaign_contacts status row is still present and valid", () => {
    assert.deepEqual(
      rows(
        `SELECT status FROM public.campaign_contacts WHERE campaign_id = '${CAMPAIGN}' ORDER BY status;`,
      ),
      [...CONTACT_STATUSES].sort(),
    );
  });

  pgTest("both constraints are validated (not left NOT VALID)", () => {
    assert.deepEqual(
      rows(
        `SELECT conname || '|' || convalidated FROM pg_constraint
         WHERE conname IN ('call_logs_status_check', 'campaign_contacts_status_check') ORDER BY conname;`,
      ),
      // boolean || text renders as "true", not psql's "t".
      ["call_logs_status_check|true", "campaign_contacts_status_check|true"],
    );
  });
});

describe("new and existing values after the migration", () => {
  pgTest("every existing call status is still accepted, plus outcome_unknown", () => {
    for (const s of [...CALL_STATUSES, "outcome_unknown"]) {
      const r = sql(callRow(s));
      assert.equal(r.status, 0, `${s}: ${r.stderr}`);
    }
  });

  pgTest("every existing contact status is still accepted, plus outcome_unknown", () => {
    for (const s of [...CONTACT_STATUSES, "outcome_unknown"]) {
      const r = sql(contactRow(s).sql);
      assert.equal(r.status, 0, `${s}: ${r.stderr}`);
    }
  });

  pgTest("an unknown status is still rejected on both tables", () => {
    const call = sql(callRow("maybe"));
    assert.notEqual(call.status, 0);
    assert.match(call.stderr, /call_logs_status_check/);
    const contact = sql(contactRow("maybe").sql);
    assert.notEqual(contact.status, 0);
    assert.match(contact.stderr, /campaign_contacts_status_check/);
  });

  pgTest("a conditional update from initiated to outcome_unknown works and matches once", () => {
    const id = rows(
      `INSERT INTO public.call_logs (organization_id, provider, direction, status)
       VALUES ('${ORG}', 'sarvam', 'outbound', 'initiated') RETURNING id;`,
    )[0]!;
    assert.deepEqual(
      rows(
        `UPDATE public.call_logs SET status = 'outcome_unknown' WHERE id = '${id}' AND status = 'initiated' RETURNING status;`,
      ),
      ["outcome_unknown"],
    );
    assert.deepEqual(
      rows(
        `UPDATE public.call_logs SET status = 'failed' WHERE id = '${id}' AND status = 'initiated' RETURNING status;`,
      ),
      [],
    );
  });
});

describe("in-flight protection for a campaign contact", () => {
  pgTest("an outcome_unknown call blocks a second call row for the same campaign contact", () => {
    const cc = contactRow("outcome_unknown");
    assert.equal(sql(cc.sql).status, 0);
    assert.equal(sql(callRow("outcome_unknown", cc.id)).status, 0);
    const second = sql(callRow("initiated", cc.id));
    assert.notEqual(second.status, 0, "a second in-flight call row must be refused");
    assert.match(second.stderr, /idx_call_logs_campaign_contact_inflight/);
  });

  pgTest(
    "once the unknown call is resolved to a final status, a new attempt row is allowed",
    () => {
      const cc = contactRow("calling");
      assert.equal(sql(cc.sql).status, 0);
      assert.equal(sql(callRow("outcome_unknown", cc.id)).status, 0);
      assert.equal(
        sql(`UPDATE public.call_logs SET status = 'failed' WHERE campaign_contact_id = '${cc.id}';`)
          .status,
        0,
      );
      assert.equal(sql(callRow("initiated", cc.id)).status, 0);
    },
  );

  pgTest("the dispatcher's due-contact index never covers outcome_unknown", () => {
    const [def] = rows(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_campaign_contacts_due';`,
    );
    assert.match(def!, /'pending'::text, 'retry_scheduled'::text/);
    assert.doesNotMatch(def!, /outcome_unknown/);
  });
});

describe("outbound number reservation (idx_call_logs_sarvam_outbound_number_reservation)", () => {
  let n = 0;
  const number = () => `+9198${String(++n).padStart(8, "0")}`;
  const single = (to: string, status = "initiated", org = ORG, extra = "") =>
    `INSERT INTO public.call_logs (organization_id, provider, direction, status, destination_number${extra ? ", " + extra.split("=")[0] : ""})
     VALUES ('${org}', 'sarvam', 'outbound', '${status}', '${to}'${extra ? ", " + extra.split("=")[1] : ""});`;
  const refused = (r: RunResult) => {
    assert.notEqual(r.status, 0, "the second unresolved call must be refused");
    assert.match(r.stderr, /idx_call_logs_sarvam_outbound_number_reservation/);
  };

  pgTest(
    "a second unresolved single call to the same number is refused, with or without an attempt id",
    () => {
      const to = number();
      assert.equal(sql(single(to)).status, 0);
      refused(sql(single(to)));
      refused(sql(single(to, "initiated", ORG, "provider_call_id='att_2'")));
    },
  );

  pgTest("an outcome_unknown call also holds the reservation", () => {
    const to = number();
    assert.equal(sql(single(to, "outcome_unknown")).status, 0);
    refused(sql(single(to)));
  });

  pgTest(
    "the conditional initiated → outcome_unknown transition keeps (doesn't fight) its own reservation",
    () => {
      const to = number();
      const [id] = rows(`${single(to).replace(/;\s*$/, "")} RETURNING id;`);
      assert.deepEqual(
        rows(
          `UPDATE public.call_logs SET status = 'outcome_unknown' WHERE id = '${id}' AND status = 'initiated' RETURNING status;`,
        ),
        ["outcome_unknown"],
      );
      refused(sql(single(to)));
    },
  );

  pgTest("once the call is final (resolved), the number can be called again", () => {
    const to = number();
    const [id] = rows(`${single(to, "outcome_unknown").replace(/;\s*$/, "")} RETURNING id;`);
    assert.equal(
      sql(`UPDATE public.call_logs SET status = 'failed' WHERE id = '${id}';`).status,
      0,
    );
    assert.equal(sql(single(to)).status, 0);
  });

  pgTest(
    "other numbers, other organizations, inbound calls and other providers are not affected; campaign calls are",
    () => {
      const to = number();
      const otherOrg = randomUUID();
      assert.equal(
        sql(
          `INSERT INTO public.organizations (id, name, owner_id) VALUES ('${otherOrg}', 'Other Clinic', '${randomUUID()}');`,
        ).status,
        0,
      );
      assert.equal(sql(single(to)).status, 0);
      assert.equal(sql(single(number())).status, 0, "another number");
      assert.equal(sql(single(to, "initiated", otherOrg)).status, 0, "another organization");
      assert.equal(
        sql(
          `INSERT INTO public.call_logs (organization_id, provider, direction, status, destination_number)
         VALUES ('${ORG}', 'sarvam', 'inbound', 'initiated', '${to}');`,
        ).status,
        0,
        "inbound",
      );
      assert.equal(
        sql(
          `INSERT INTO public.call_logs (organization_id, provider, direction, status, destination_number)
         VALUES ('${ORG}', 'vobiz', 'outbound', 'initiated', '${to}');`,
        ).status,
        0,
        "another provider",
      );
      // A campaign call to the same number shares the reservation.
      const cc = contactRow("calling");
      assert.equal(sql(cc.sql).status, 0);
      refused(
        sql(
          single(to, "initiated", ORG, `campaign_id,campaign_contact_id='${CAMPAIGN}','${cc.id}'`),
        ),
      );
    },
  );

  pgTest(
    "two concurrent sessions: the second insert waits on the first, then is refused when it commits",
    () => {
      const to = number();
      // dblink ships with the PostgreSQL server's standard extensions (on
      // Ubuntu, inside postgresql-NN, which CI installs). If it is missing
      // this is a real setup failure, never a skip: the race must run.
      const available = rows(`SELECT count(*) FROM pg_available_extensions WHERE name = 'dblink';`);
      assert.deepEqual(
        available,
        ["1"],
        "the dblink extension is not installed with this PostgreSQL server; install the server's standard contrib extensions",
      );
      // Session A holds its insert uncommitted; session B (a second connection
      // via dblink) tries the same insert and must block on A's unique-index
      // entry — not slip through — then fail once A commits.
      const r = sql(`
CREATE EXTENSION IF NOT EXISTS dblink;
\\pset format unaligned
\\pset tuples_only on
SELECT dblink_connect('b', CASE
  WHEN inet_server_addr() IS NOT NULL
    THEN format('host=%s port=%s dbname=%s user=postgres', host(inet_server_addr()), current_setting('port'), current_database())
  ELSE format('host=%s port=%s dbname=%s user=postgres', split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database())
END);
BEGIN;
${single(to)}
SELECT dblink_send_query('b', ${"$q$"}${single(to)}${"$q$"});
SELECT pg_sleep(0.5);
SELECT 'B waiting on lock: ' || EXISTS (
  SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO public.call_logs%'
);
COMMIT;
SELECT 'B result: ' || coalesce((SELECT status FROM dblink_get_result('b', false) AS t(status text) LIMIT 1), 'error');
SELECT 'B error: ' || dblink_error_message('b');
SELECT dblink_disconnect('b');
SELECT 'rows: ' || count(*) FROM public.call_logs WHERE destination_number = '${to}';
`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /B waiting on lock: true/);
      assert.match(r.stdout, /B error: .*idx_call_logs_sarvam_outbound_number_reservation/);
      assert.match(r.stdout, /rows: 1\b/);
    },
  );
});

describe("reservation edge cases and a safe, clear migration failure", () => {
  const unresolvedSingle = (to: string | null, org = ORG) =>
    `INSERT INTO public.call_logs (organization_id, provider, direction, status, destination_number)
     VALUES ('${org}', 'sarvam', 'outbound', 'initiated', ${to === null ? "NULL" : `'${to}'`});`;

  pgTest("a call without a destination number never reserves anything", () => {
    assert.equal(sql(unresolvedSingle(null)).status, 0);
    assert.equal(sql(unresolvedSingle(null)).status, 0);
    const [def] = rows(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_call_logs_sarvam_outbound_number_reservation';`,
    );
    assert.match(def!, /destination_number IS NOT NULL/);
  });

  pgTest(
    "existing duplicate unresolved calls: the migration stops with an actionable message and changes nothing",
    () => {
      const to = "+919000000001";
      const migration = readFileSync(join(migrationsDir, FIX), "utf8");
      // Recreate the pre-migration situation inside one transaction: no index,
      // two unresolved single calls to the same number. ON_ERROR_STOP ends the
      // session at the migration's error, so the transaction is rolled back.
      const r = sql(`BEGIN;
DROP INDEX public.idx_call_logs_sarvam_outbound_number_reservation;
${unresolvedSingle(to)}
${unresolvedSingle(to)}
${migration}
COMMIT;`);
      assert.notEqual(r.status, 0, "the migration must not succeed over duplicates");
      assert.match(
        r.stderr,
        /Cannot add idx_call_logs_sarvam_outbound_number_reservation: 1 organization\/number pair\(s\) already have more than one unresolved Sarvam outbound call/,
      );
      assert.match(r.stderr, /Resolve the extra calls first/);

      // Nothing was kept: the index is back as before and the duplicates are gone.
      assert.deepEqual(
        rows(
          `SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_call_logs_sarvam_outbound_number_reservation';`,
        ),
        ["1"],
      );
      assert.deepEqual(
        rows(`SELECT count(*) FROM public.call_logs WHERE destination_number = '${to}';`),
        ["0"],
      );
    },
  );

  pgTest("a reserved number never blocks another organization's call to the same number", () => {
    const to = "+919000000002";
    const otherOrg = randomUUID();
    assert.equal(
      sql(
        `INSERT INTO public.organizations (id, name, owner_id) VALUES ('${otherOrg}', 'Third Clinic', '${randomUUID()}');`,
      ).status,
      0,
    );
    assert.equal(sql(unresolvedSingle(to)).status, 0);
    assert.equal(sql(unresolvedSingle(to, otherOrg)).status, 0);
    // ...and each organization is still limited to one.
    assert.notEqual(sql(unresolvedSingle(to, otherOrg)).status, 0);
  });
});

describe("single calls vs campaign calls share the number reservation", () => {
  let n = 0;
  const number = () => `+9197${String(++n).padStart(8, "0")}`;
  const singleCall = (to: string) =>
    `INSERT INTO public.call_logs (organization_id, provider, direction, status, destination_number)
     VALUES ('${ORG}', 'sarvam', 'outbound', 'initiated', '${to}');`;
  /** A campaign contact plus its call-row insert (the row the dispatcher writes before dialling). */
  function campaignCall(to: string, campaign = CAMPAIGN): { setup: string; insert: string } {
    const cc = contactRow("calling");
    const setup = cc.sql.replaceAll(`'${CAMPAIGN}'`, `'${campaign}'`);
    return {
      setup,
      insert: `INSERT INTO public.call_logs (organization_id, provider, direction, status, destination_number, campaign_id, campaign_contact_id)
     VALUES ('${ORG}', 'sarvam', 'outbound', 'initiated', '${to}', '${campaign}', '${cc.id}');`,
    };
  }
  const refused = (r: RunResult) => {
    assert.notEqual(r.status, 0, "the second unresolved call to this number must be refused");
    assert.match(r.stderr, /idx_call_logs_sarvam_outbound_number_reservation/);
  };

  pgTest("an open single call refuses a campaign call to the same number", () => {
    const to = number();
    const c = campaignCall(to);
    assert.equal(sql(c.setup).status, 0);
    assert.equal(sql(singleCall(to)).status, 0);
    refused(sql(c.insert));
  });

  pgTest("an open campaign call refuses a single call to the same number", () => {
    const to = number();
    const c = campaignCall(to);
    assert.equal(sql(c.setup).status, 0);
    assert.equal(sql(c.insert).status, 0);
    refused(sql(singleCall(to)));
  });

  pgTest("two campaigns can't call the same number at once (same contact enrolled twice)", () => {
    const to = number();
    const otherCampaign = randomUUID();
    assert.equal(
      sql(
        `INSERT INTO public.campaigns (id, organization_id, name) VALUES ('${otherCampaign}', '${ORG}', 'Second campaign');`,
      ).status,
      0,
    );
    const a = campaignCall(to);
    const b = campaignCall(to, otherCampaign);
    assert.equal(sql(a.setup + b.setup).status, 0);
    assert.equal(sql(a.insert).status, 0);
    refused(sql(b.insert));
  });

  pgTest("the per-contact in-flight rule still applies on its own", () => {
    // Same contact, different destination numbers: the number reservation
    // doesn't apply, but idx_call_logs_campaign_contact_inflight still does.
    const cc = contactRow("calling");
    assert.equal(sql(cc.sql).status, 0);
    const row = (to: string) =>
      `INSERT INTO public.call_logs (organization_id, provider, direction, status, destination_number, campaign_id, campaign_contact_id)
       VALUES ('${ORG}', 'sarvam', 'outbound', 'initiated', '${to}', '${CAMPAIGN}', '${cc.id}');`;
    assert.equal(sql(row(number())).status, 0);
    const second = sql(row(number()));
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /idx_call_logs_campaign_contact_inflight/);
  });

  pgTest("once the open call is final, the other kind can call the number", () => {
    const to = number();
    const c = campaignCall(to);
    assert.equal(sql(c.setup).status, 0);
    assert.equal(sql(singleCall(to)).status, 0);
    assert.equal(
      sql(
        `UPDATE public.call_logs SET status = 'no_answer' WHERE destination_number = '${to}' AND campaign_contact_id IS NULL;`,
      ).status,
      0,
    );
    assert.equal(sql(c.insert).status, 0);
  });

  pgTest(
    "duplicate unresolved campaign calls also stop the migration, which then changes nothing",
    () => {
      const to = number();
      const a = campaignCall(to);
      const b = campaignCall(to);
      const migration = readFileSync(join(migrationsDir, FIX), "utf8");
      const r = sql(`BEGIN;
DROP INDEX public.idx_call_logs_sarvam_outbound_number_reservation;
${a.setup}
${b.setup}
${a.insert}
${b.insert}
${migration}
COMMIT;`);
      assert.notEqual(r.status, 0);
      assert.match(
        r.stderr,
        /Cannot add idx_call_logs_sarvam_outbound_number_reservation: 1 organization\/number pair/,
      );
      assert.deepEqual(
        rows(
          `SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_call_logs_sarvam_outbound_number_reservation';`,
        ),
        ["1"],
      );
      assert.deepEqual(
        rows(`SELECT count(*) FROM public.call_logs WHERE destination_number = '${to}';`),
        ["0"],
      );
    },
  );

  /**
   * True two-connection race: session A inserts and holds its transaction
   * open; session B (a second connection via dblink) inserts the other kind of
   * call to the same number, must wait on A's lock, then is refused when A
   * commits.
   */
  function race(first: string, second: string): string {
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
  SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO public.call_logs%'
);
COMMIT;
SELECT 'B result: ' || coalesce((SELECT status FROM dblink_get_result('race', false) AS t(status text) LIMIT 1), 'error');
SELECT 'B error: ' || dblink_error_message('race');
SELECT dblink_disconnect('race');
`);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }

  pgTest(
    "concurrent race: single call first, campaign call second — the campaign insert waits, then is refused",
    () => {
      const to = number();
      const c = campaignCall(to);
      assert.equal(sql(c.setup).status, 0);
      const out = race(singleCall(to), c.insert);
      assert.match(out, /B waiting on lock: true/);
      assert.match(out, /B error: .*idx_call_logs_sarvam_outbound_number_reservation/);
      assert.deepEqual(
        rows(`SELECT count(*) FROM public.call_logs WHERE destination_number = '${to}';`),
        ["1"],
      );
    },
  );

  pgTest(
    "concurrent race: campaign call first, single call second — the single-call insert waits, then is refused",
    () => {
      const to = number();
      const c = campaignCall(to);
      assert.equal(sql(c.setup).status, 0);
      const out = race(c.insert, singleCall(to));
      assert.match(out, /B waiting on lock: true/);
      assert.match(out, /B error: .*idx_call_logs_sarvam_outbound_number_reservation/);
      assert.deepEqual(
        rows(
          `SELECT count(*) || '|' || count(campaign_contact_id) FROM public.call_logs WHERE destination_number = '${to}';`,
        ),
        ["1|1"],
        "only the campaign call exists",
      );
    },
  );
});

describe("non-canonical stored contact numbers", () => {
  pgTest("the migration reports them in a NOTICE and leaves them unchanged", () => {
    const contact = randomUUID();
    const migration = readFileSync(join(migrationsDir, FIX), "utf8");
    // "+910987654321" passes the contacts CHECK but is not a valid Indian number.
    const r = sql(`BEGIN;
INSERT INTO public.contacts (id, organization_id, phone) VALUES ('${contact}', '${ORG}', '+910987654321');
${migration}
\\pset format unaligned
\\pset tuples_only on
SELECT 'phone=' || phone FROM public.contacts WHERE id = '${contact}';
ROLLBACK;`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stderr,
      /NOTICE: {2}Found [1-9]\d* contact phone number\(s\) that are not canonical Indian E\.164/,
    );
    assert.match(
      r.stderr,
      /SELECT id, organization_id, phone FROM public\.contacts WHERE phone LIKE '\+91%'/,
    );
    assert.match(r.stdout, /phone=\+910987654321/);
  });
});
