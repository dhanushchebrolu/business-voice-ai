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
 * REAL-PostgreSQL check of the reviewed one-time cleanup
 * (docs/production-cleanup-20261118-sarvam-provider-metadata.sql) and its
 * rollback, executed exactly as written against every migration: it reduces
 * the raw Sarvam payloads to interaction_id / recording_url / app_id /
 * late_provider_report, touches nothing else, refuses an unexpected row
 * count, keeps a private backup, and Part A of the rollback restores it.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const docs = join(migrationsDir, "..", "..", "docs");
const CLEANUP = readFileSync(
  join(docs, "production-cleanup-20261118-sarvam-provider-metadata.sql"),
  "utf8",
);
const ROLLBACK = readFileSync(
  join(docs, "production-rollback-20261118-sarvam-provider-metadata.sql"),
  "utf8",
);
const TEL_CLEANUP = readFileSync(
  join(docs, "production-cleanup-20261118-exotel-vobiz-provider-metadata.sql"),
  "utf8",
);
const TEL_ROLLBACK = readFileSync(
  join(docs, "production-rollback-20261118-exotel-vobiz-provider-metadata.sql"),
  "utf8",
);
const WE_CLEANUP = readFileSync(
  join(docs, "production-cleanup-20261118-webhook-events-payload.sql"),
  "utf8",
);
const WE_ROLLBACK = readFileSync(
  join(docs, "production-rollback-20261118-webhook-events-payload.sql"),
  "utf8",
);
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
const ORG = randomUUID();
const RAW_IDS = Array.from({ length: 7 }, () => randomUUID());
const OUT_ID = randomUUID();
const CLEAN_ID = randomUUID();
const EXOTEL_ID = randomUUID();
const LATE = { status: "completed", receivedAt: "2026-11-12T11:00:00Z" };

const raw = (i: number) => ({
  app_id: "Conversatio-9c6a04cd-3334",
  app_version: "5",
  deployment_id: "Smile-Denta-be071be0-703e",
  interaction_id: `20261112/int_${i}`,
  user_phone_number: "+919876500099",
  agent_phone_number: "+917900000061",
  final_agent_variables: { customer_name: "Asha", faqs: "Q…" },
  output_agent_variables: { opted_out: "no" },
  interaction_transcript: [{ role: "user", en_text: "Call me on 98765 00099" }],
  recording_url: i === 0 ? "https://recordings.example/0.wav" : null,
  _agent_variables: { final: { customer_name: "Asha" } },
  ...(i === 1 ? { late_provider_report: LATE } : {}),
});
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

function rows(sql: string): string[] {
  const r = execSql!(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`);
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr}\n${sql}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
}
function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}
const metaOf = (id: string) =>
  JSON.parse(
    rows(`SELECT provider_metadata::text FROM public.call_logs WHERE id = '${id}';`)[0]!,
  ) as Record<string, unknown>;

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
  for (const file of MIGRATION_FILES) {
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const inserts = [
    ...RAW_IDS.map(
      (id, i) =>
        `INSERT INTO public.call_logs (id, organization_id, provider, direction, status, provider_call_id, caller_number, transcript, provider_metadata)
           VALUES ('${id}', '${ORG}', 'sarvam', 'inbound', 'completed', '20261112/int_${i}', '+919876500099',
                   '[{"role":"user","text":"hello"}]'::jsonb, ${lit(raw(i))});`,
    ),
    `INSERT INTO public.call_logs (id, organization_id, provider, direction, status, provider_metadata)
       VALUES ('${CLEAN_ID}', '${ORG}', 'sarvam', 'inbound', 'completed', ${lit({ interaction_id: "i-clean" })});`,
    `INSERT INTO public.call_logs (id, organization_id, provider, direction, status, provider_metadata)
       VALUES ('${EXOTEL_ID}', '${ORG}', 'exotel', 'inbound', 'completed', ${lit({ From: "+919876500097", CallSid: "CA1" })});`,
  ].join("\n");
  const seed = execSql(`
    INSERT INTO auth.users (id) VALUES ('${OWNER}');
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'Clinic', '${OWNER}');
    ${inserts}
  `);
  if (seed.status !== 0) setupFailure = `seed failed: ${seed.stderr}`;
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

describe("one-time provider_metadata cleanup (reviewed SQL, run as written)", () => {
  test("an unexpected row count aborts and changes nothing", (t) => {
    if (!ready(t)) return;
    // An eighth raw row makes the guard (exactly 7) refuse.
    rows(
      `INSERT INTO public.call_logs (id, organization_id, provider, direction, status, provider_metadata)
         VALUES ('${OUT_ID}', '${ORG}', 'sarvam', 'outbound', 'completed',
                 ${lit({ interaction_id: "i-out", webhook_config: { url: "https://x?verify_token=SECRET" } })});`,
    );
    const r = execSql!(CLEANUP);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /expected exactly 7/);
    assert.deepEqual(
      rows(`SELECT to_regclass('public.call_logs_provider_metadata_backup_20261118') IS NULL;`),
      ["t"],
      "the backup table was rolled back too",
    );
    assert.equal(metaOf(RAW_IDS[0]!)["user_phone_number"], "+919876500099", "nothing changed");
    rows(`DELETE FROM public.call_logs WHERE id = '${OUT_ID}';`);
  });

  test("the seven raw rows keep only their identifiers; nothing else changes", (t) => {
    if (!ready(t)) return;
    const before = rows(
      `SELECT id || '|' || status || '|' || coalesce(caller_number, '-') || '|' || coalesce(transcript::text, '-')
         FROM public.call_logs ORDER BY id;`,
    );
    const r = execSql!(CLEANUP);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(metaOf(RAW_IDS[0]!), {
      interaction_id: "20261112/int_0",
      app_id: "Conversatio-9c6a04cd-3334",
      recording_url: "https://recordings.example/0.wav",
    });
    assert.deepEqual(metaOf(RAW_IDS[1]!), {
      interaction_id: "20261112/int_1",
      app_id: "Conversatio-9c6a04cd-3334",
      late_provider_report: LATE,
    });
    for (const id of RAW_IDS) {
      const text = JSON.stringify(metaOf(id));
      for (const leak of [
        "+919876500099",
        "+917900000061",
        "Asha",
        "98765",
        "faqs",
        "opted_out",
        "deployment_id",
      ])
        assert.ok(!text.includes(leak), `${id}: ${leak}`);
    }
    assert.deepEqual(metaOf(CLEAN_ID), { interaction_id: "i-clean" });
    assert.deepEqual(
      metaOf(EXOTEL_ID),
      { From: "+919876500097", CallSid: "CA1" },
      "other providers untouched",
    );
    const after = rows(
      `SELECT id || '|' || status || '|' || coalesce(caller_number, '-') || '|' || coalesce(transcript::text, '-')
         FROM public.call_logs ORDER BY id;`,
    );
    assert.deepEqual(after, before, "no call log deleted; other columns unchanged");
    // The backup is private: no API role can read it.
    assert.deepEqual(
      rows(`SELECT count(*) FROM public.call_logs_provider_metadata_backup_20261118;`),
      ["7"],
    );
    const anon = execSql!(
      `SET ROLE authenticated;\nSELECT count(*) FROM public.call_logs_provider_metadata_backup_20261118;`,
    );
    assert.notEqual(anon.status, 0);
    assert.match(anon.stderr, /permission denied/);
  });

  test("Part A of the rollback restores the original payloads and keeps newer keys", (t) => {
    if (!ready(t)) return;
    // A late report written after the cleanup must survive the rollback.
    rows(
      `UPDATE public.call_logs SET provider_metadata = provider_metadata || ${lit({ late_provider_report: { status: "failed" } })}
         WHERE id = '${RAW_IDS[2]}';`,
    );
    const partA = ROLLBACK.split("-- Part B")[0]!;
    const r = execSql!(partA);
    assert.equal(r.status, 0, r.stderr);
    const restored = metaOf(RAW_IDS[0]!);
    assert.equal(restored["user_phone_number"], "+919876500099");
    assert.deepEqual(restored["final_agent_variables"], { customer_name: "Asha", faqs: "Q…" });
    assert.deepEqual(metaOf(RAW_IDS[2]!)["late_provider_report"], { status: "failed" });
    // Part B (commented in the document) drops the backup.
    rows(`DROP TABLE IF EXISTS public.call_logs_provider_metadata_backup_20261118;`);
    assert.deepEqual(
      rows(`SELECT to_regclass('public.call_logs_provider_metadata_backup_20261118') IS NULL;`),
      ["t"],
    );
  });
});

describe("one-time Exotel/Vobiz provider_metadata cleanup (reviewed SQL, run as written)", () => {
  const BACKUP = "public.call_logs_provider_metadata_backup_20261118_telephony";
  const REC_ID = randomUUID();
  const VOBIZ_ID = randomUUID();
  const telRows = () =>
    rows(`SELECT id::text || '|' || provider_metadata::text FROM public.call_logs
           WHERE provider IN ('exotel', 'vobiz') ORDER BY id;`);

  test("an unexpected row count aborts and changes nothing", (t) => {
    if (!ready(t)) return;
    const before = telRows();
    const r = execSql!(TEL_CLEANUP);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /expected exactly 198/);
    assert.deepEqual(rows(`SELECT to_regclass('${BACKUP}') IS NULL;`), ["t"]);
    assert.deepEqual(telRows(), before, "nothing changed");
  });

  test("the 198 raw rows keep only allowlisted keys; RecordingUrl becomes recording_url", (t) => {
    if (!ready(t)) return;
    // Production shape: 23 Exotel rows (EXOTEL_ID + 22) and 175 Vobiz rows.
    rows(`
      INSERT INTO public.call_logs (id, organization_id, provider, direction, status, provider_metadata)
        VALUES ('${REC_ID}', '${ORG}', 'exotel', 'inbound', 'completed',
                ${lit({ From: "+919876500096", To: "+917900000001", CallSid: "CA2", verify_token: "SYNTHETIC-EXO", RecordingUrl: "https://recordings.example/exo.mp3" })}),
               ('${VOBIZ_ID}', '${ORG}', 'vobiz', 'inbound', 'completed',
                ${lit({ From: "+919876500095", To: "+917900000002", CallerName: "Ravi", ParentAuthID: "MA_SYNTH", verify_token: "SYNTHETIC-VBZ", CallUUID: "u-1" })});
      INSERT INTO public.call_logs (id, organization_id, provider, direction, status, provider_metadata)
        SELECT gen_random_uuid(), '${ORG}', 'exotel', 'inbound', 'completed',
               jsonb_build_object('From', '+91987650' || g, 'verify_token', 'SYNTHETIC-EXO')
          FROM generate_series(1, 21) g;
      INSERT INTO public.call_logs (id, organization_id, provider, direction, status, provider_metadata)
        SELECT gen_random_uuid(), '${ORG}', 'vobiz', 'inbound', 'completed',
               jsonb_build_object('To', '+91987651' || g, 'ParentAuthID', 'MA_SYNTH', 'verify_token', 'SYNTHETIC-VBZ')
          FROM generate_series(1, 174) g;
    `);
    const sarvamBefore = rows(
      `SELECT id::text || '|' || provider_metadata::text FROM public.call_logs WHERE provider = 'sarvam' ORDER BY id;`,
    );
    const r = execSql!(TEL_CLEANUP);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(metaOf(REC_ID), { recording_url: "https://recordings.example/exo.mp3" });
    assert.deepEqual(metaOf(VOBIZ_ID), {});
    assert.deepEqual(metaOf(EXOTEL_ID), {});
    const text = telRows().join(" ");
    for (const leak of ["+91", "SYNTHETIC", "MA_SYNTH", "Ravi", "CallSid", "CallUUID"])
      assert.ok(!text.includes(leak), leak);
    assert.deepEqual(
      rows(
        `SELECT id::text || '|' || provider_metadata::text FROM public.call_logs WHERE provider = 'sarvam' ORDER BY id;`,
      ),
      sarvamBefore,
      "Sarvam rows untouched",
    );
    assert.deepEqual(rows(`SELECT count(*) FROM ${BACKUP};`), ["198"]);
    const api = execSql!(`SET ROLE authenticated;
SELECT count(*) FROM ${BACKUP};`);
    assert.notEqual(api.status, 0);
    assert.match(api.stderr, /permission denied/);
  });

  test("Part A of the rollback restores the original payloads; Part B drops the backup", (t) => {
    if (!ready(t)) return;
    const r = execSql!(TEL_ROLLBACK.split("-- Part B")[0]!);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(metaOf(VOBIZ_ID)["verify_token"], "SYNTHETIC-VBZ");
    assert.equal(metaOf(REC_ID)["From"], "+919876500096");
    assert.deepEqual(metaOf(EXOTEL_ID), { From: "+919876500097", CallSid: "CA1" });
    rows(`DROP TABLE IF EXISTS ${BACKUP};`);
    assert.deepEqual(rows(`SELECT to_regclass('${BACKUP}') IS NULL;`), ["t"]);
  });
});

describe("one-time webhook_events payload cleanup (reviewed SQL, run as written)", () => {
  const BACKUP = "public.webhook_events_payload_backup_20261118";
  const exotelRaw = (i: number) => ({
    CallSid: `CA-${i}`,
    From: "+919876500093",
    To: "+917900000003",
    CallFrom: "09876500093",
    DialWhomNumber: "+917900000003",
    verify_token: "SYNTHETIC-EXO",
    flow_id: "flow-synth",
  });
  const sarvamRaw = (i: number) => ({
    interaction_id: `20261112/we_${i}`,
    user_phone_number: "+919876500094",
    agent_phone_number: "+917900000004",
    interaction_transcript: [{ role: "user", en_text: "I am Meena" }],
    final_agent_variables: { customer_name: "Meena" },
  });
  const state = () =>
    rows(`SELECT provider || '|' || event_id || '|' || coalesce(event_type, '-') || '|' ||
                 coalesce(processed_at::text, '-') || '|' || coalesce(error, '-') || '|' || created_at::text
            FROM public.webhook_events ORDER BY provider, event_id;`);
  const payloadOf = (provider: string, eventId: string) =>
    rows(
      `SELECT payload::text FROM public.webhook_events WHERE provider = '${provider}' AND event_id = '${eventId}';`,
    )[0];

  test("seed: production-shaped rows, plus rows the cleanup must not touch", (t) => {
    if (!ready(t)) return;
    rows(`
      INSERT INTO public.webhook_events (provider, event_id, event_type, payload, processed_at)
        SELECT 'exotel', 'CA-' || g || ':completed:2026-09-16', 'completed',
               ${lit(exotelRaw(0))} || jsonb_build_object('CallSid', 'CA-' || g), now()
          FROM generate_series(1, 26) g;
      INSERT INTO public.webhook_events (provider, event_id, event_type, payload, processed_at)
        SELECT 'sarvam', '20261112/we_' || g, 'completed',
               ${lit(sarvamRaw(0))} || jsonb_build_object('interaction_id', '20261112/we_' || g), now()
          FROM generate_series(1, 7) g;
      INSERT INTO public.webhook_events (provider, event_id, event_type, payload) VALUES
        ('sarvam', 'op-1', 'completed', ${lit({ source: "operator_resolution", call_id: "c1", outcome: "completed" })}),
        ('sarvam', 'new-1', 'completed', '{}'::jsonb),
        ('whatsapp', 'wamid.1', 'message', ${lit({ From: "+919876500095", text: "hi" })}),
        ('razorpay', 'evt_1', 'payment.captured', ${lit({ payload: { id: "pay_1" } })});
    `);
  });

  test("an unexpected row count aborts and changes nothing", (t) => {
    if (!ready(t)) return;
    rows(
      `INSERT INTO public.webhook_events (provider, event_id, event_type, payload)
         VALUES ('vobiz', 'cu-extra:completed:x', 'completed', ${lit({ From: "+919876500096", verify_token: "SYNTHETIC-VBZ" })});`,
    );
    const before = state();
    const r = execSql!(WE_CLEANUP);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /expected exactly 33/);
    assert.deepEqual(rows(`SELECT to_regclass('${BACKUP}') IS NULL;`), ["t"]);
    assert.deepEqual(state(), before);
    rows(`DELETE FROM public.webhook_events WHERE event_id = 'cu-extra:completed:x';`);
  });

  test("the 33 raw rows get an empty payload; keys, processing state and other providers are untouched", (t) => {
    if (!ready(t)) return;
    const before = state();
    const r = execSql!(WE_CLEANUP);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      state(),
      before,
      "event_id, event_type, processed_at, error, created_at unchanged",
    );
    assert.equal(payloadOf("exotel", "CA-1:completed:2026-09-16"), "{}");
    assert.equal(payloadOf("sarvam", "20261112/we_7"), "{}");
    const all = rows(
      `SELECT payload::text FROM public.webhook_events WHERE provider IN ('exotel', 'sarvam');`,
    ).join(" ");
    for (const leak of ["+91", "SYNTHETIC", "Meena", "flow-synth"])
      assert.ok(!all.includes(leak), leak);
    assert.match(payloadOf("sarvam", "op-1")!, /operator_resolution/, "operator rows untouched");
    assert.match(payloadOf("whatsapp", "wamid.1")!, /\+919876500095/, "other providers untouched");
    assert.match(payloadOf("razorpay", "evt_1")!, /pay_1/);
    // Idempotency still holds: a replay of a cleaned event hits the unique key.
    const replay = execSql!(
      `INSERT INTO public.webhook_events (provider, event_id, event_type, payload)
         VALUES ('exotel', 'CA-1:completed:2026-09-16', 'completed', '{}'::jsonb);`,
    );
    assert.notEqual(replay.status, 0);
    assert.match(replay.stderr, /duplicate key|unique/);
    assert.deepEqual(rows(`SELECT count(*) FROM ${BACKUP};`), ["33"]);
    const api = execSql!(`SET ROLE authenticated;
SELECT count(*) FROM ${BACKUP};`);
    assert.notEqual(api.status, 0);
    assert.match(api.stderr, /permission denied/);
  });

  test("Part A of the rollback restores the payloads; Part B drops the backup", (t) => {
    if (!ready(t)) return;
    const r = execSql!(WE_ROLLBACK.split("-- Part B")[0]!);
    assert.equal(r.status, 0, r.stderr);
    assert.match(payloadOf("exotel", "CA-2:completed:2026-09-16")!, /SYNTHETIC-EXO/);
    assert.match(payloadOf("sarvam", "20261112/we_1")!, /\+919876500094/);
    assert.equal(payloadOf("sarvam", "new-1"), "{}");
    rows(`DROP TABLE IF EXISTS ${BACKUP};`);
    assert.deepEqual(rows(`SELECT to_regclass('${BACKUP}') IS NULL;`), ["t"]);
  });
});
