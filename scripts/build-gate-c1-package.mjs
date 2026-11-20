#!/usr/bin/env node
// Builds the GATE C1 production package for migration 20261121090000 from the
// repository files, so the executed and recorded SQL is byte-identical to them:
//   docs/gate-c1-execute-20261121090000.sql   apply (guard, migration, history, stop row, check)
//   docs/gate-c1-rollback-20261121090000.sql  roll back (guard, restore, drop, check)
// Usage: node scripts/build-gate-c1-package.mjs [--system-id <id>] [--out <dir>] [--database <name>]
// Defaults target production (system identifier 7678069749886157684, database
// "postgres", output docs/). A rehearsal build for another cluster passes its own id.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const SYSTEM_ID = arg("--system-id", "7678069749886157684");
const DATABASE = arg("--database", "postgres");
const OUT = arg("--out", join(root, "docs"));

const VERSION = "20261121090000";
const NAME = "campaign_context_engine";
const read = (p) => readFileSync(join(root, p), "utf8");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

const MIGRATION_PATH = `supabase/migrations/${VERSION}_${NAME}.sql`;
const ROLLBACK_PATH = `docs/production-rollback-${VERSION}-campaign-context-engine.sql`;
const ADMISSION_PATH = "supabase/migrations/20261119090000_outbound_call_admission.sql";
const migration = read(MIGRATION_PATH);
const rollback = read(ROLLBACK_PATH);
const admission = read(ADMISSION_PATH);

const TAG = "$gate_c1_mig$";
if (migration.includes(TAG)) throw new Error("dollar tag collides with the migration text");
if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(migration))
  throw new Error("the migration must not control the transaction");

// The single-call admission function as 20261119090000 defines it (body md5 must
// equal production's, checked in the execute guard and restored by rollback).
const fnStart = admission.indexOf("CREATE OR REPLACE FUNCTION public.admit_single_outbound_call(");
const grantLine =
  "GRANT EXECUTE ON FUNCTION public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer) TO service_role;";
const fnEnd = admission.indexOf(grantLine) + grantLine.length;
if (fnStart < 0 || fnEnd < grantLine.length)
  throw new Error("admit_single_outbound_call not found");
const originalSingle = admission.slice(fnStart, fnEnd);
const body = originalSingle.slice(originalSingle.indexOf("$$") + 2);
const ORIGINAL_SINGLE_MD5 = md5(body.slice(0, body.indexOf("$$")));
if (ORIGINAL_SINGLE_MD5 !== "27780f3d2d6f761bb553cc5ea825ee22")
  throw new Error(`unexpected admit_single body md5 ${ORIGINAL_SINGLE_MD5}`);

// Rollback statements: the reviewed rollback file without its own BEGIN/COMMIT.
const rollbackSql = rollback
  .split("\n")
  .filter((l) => !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
  .join("\n");

const CC_STATUS_BEFORE =
  "CHECK ((status = ANY (ARRAY['pending'::text, 'queued'::text, 'calling'::text, 'connected'::text, 'no_answer'::text, 'busy'::text, 'failed'::text, 'completed'::text, 'retry_scheduled'::text, 'opted_out'::text, 'wrong_number'::text, 'cancelled'::text, 'outcome_unknown'::text])))";
const CC_STATUS_AFTER =
  "CHECK ((status = ANY (ARRAY['pending'::text, 'queued'::text, 'calling'::text, 'connected'::text, 'no_answer'::text, 'busy'::text, 'failed'::text, 'completed'::text, 'retry_scheduled'::text, 'opted_out'::text, 'wrong_number'::text, 'cancelled'::text, 'outcome_unknown'::text, 'excluded'::text])))";
const NEW_CAMPAIGN_COLS = [
  "description",
  "context",
  "context_version",
  "context_reviewed_at",
  "context_reviewed_by",
  "budget_limit",
];
const NEW_FUNCTIONS = [
  "admit_campaign_outbound_call",
  "within_outbound_calling_hours",
  "outbound_admission_now",
  "call_logs_context_snapshot_immutable",
];
const list = (xs) => xs.map((x) => `'${x}'`).join(", ");
/** A SQL string literal (quotes doubled). */
const lit = (x) => `'${x.replace(/'/g, "''")}'`;

// Existing rows of every customer-relevant table, new columns excluded: must be
// identical before and after (the migration changes schema, never data).
const fp = (table, minus = [], where = "") => {
  const row = `(to_jsonb(x)${minus.map((c) => ` - '${c}'`).join("")})::text`;
  return `(SELECT '${table}:' || count(*) || ':' || coalesce(md5(string_agg(${row}, '|' ORDER BY ${row})), '-') FROM public.${table} x${where})`;
};
const FINGERPRINT = [
  fp("organizations"),
  fp("businesses"),
  fp("agent_configs"),
  fp("phone_numbers"),
  fp("sarvam_agent_integrations"),
  fp("telephony_connections"),
  fp("wallet_balances"),
  fp("wallet_transactions"),
  fp("contacts"),
  fp("leads"),
  fp("call_logs", ["campaign_context_snapshot"]),
  fp("campaigns", NEW_CAMPAIGN_COLS),
  fp("campaign_contacts", ["excluded_reason"]),
  fp("platform_settings", [], " WHERE key <> 'outbound.calling_paused'"),
].join(" || ';' || ");
const POLICIES = `(SELECT md5(coalesce(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\\n' ORDER BY tablename, policyname), '')) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('campaigns', 'campaign_contacts', 'contacts', 'call_logs', 'platform_settings', 'leads'))`;
const CAMPAIGNS_ACL =
  "{postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=arwd/postgres}";

const header = (title) => `-- ${title}
-- Target: Supabase project eorazvlmqwunmhwviocn, database "${DATABASE}",
-- PostgreSQL system identifier ${SYSTEM_ID}.
-- Generated by scripts/build-gate-c1-package.mjs from:
--   ${MIGRATION_PATH}  ${sha256(migration)}
--   ${ROLLBACK_PATH}  ${sha256(rollback)}
--   ${ADMISSION_PATH}  ${sha256(admission)}
-- Run ONCE, as ONE request (the query channel runs it as ONE transaction; any
-- error, including every guard and check below, rolls back EVERYTHING):
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
-- No BEGIN/COMMIT on purpose.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
`;

const identityGuard = `  IF (SELECT system_identifier::text FROM pg_control_system()) IS DISTINCT FROM '${SYSTEM_ID}' THEN
    RAISE EXCEPTION 'GATE_C1_WRONG_DATABASE: system identifier %', (SELECT system_identifier::text FROM pg_control_system());
  END IF;
  IF current_database() IS DISTINCT FROM '${DATABASE}' THEN
    RAISE EXCEPTION 'GATE_C1_WRONG_DATABASE: database %', current_database();
  END IF;`;

const execute = `${header("GATE C1 execution script: migration " + VERSION + " (campaign context engine).")}
-- ===== Guard: abort before any change unless this is the expected database in the expected state =====
DO $guard$
BEGIN
${identityGuard}
  IF (SELECT max(version) FROM supabase_migrations.schema_migrations) IS DISTINCT FROM '20261120090000' THEN
    RAISE EXCEPTION 'GATE_C1_UNEXPECTED_HISTORY: latest is %', (SELECT max(version) FROM supabase_migrations.schema_migrations);
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '${VERSION}') THEN
    RAISE EXCEPTION 'GATE_C1_ALREADY_APPLIED';
  END IF;
  -- Nothing the migration creates may exist yet (IF NOT EXISTS / OR REPLACE would keep or replace it silently).
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
        AND ((table_name = 'campaigns' AND column_name IN (${list(NEW_CAMPAIGN_COLS)}))
          OR (table_name = 'campaign_contacts' AND column_name = 'excluded_reason')
          OR (table_name = 'call_logs' AND column_name = 'campaign_context_snapshot'))) <> 0
     OR (SELECT count(*) FROM pg_constraint WHERE conname IN ('campaigns_description_length', 'campaigns_budget_limit_positive', 'campaigns_context_reviewed')) <> 0
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${list(NEW_FUNCTIONS)})) <> 0
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_call_logs_context_snapshot_immutable')
     OR EXISTS (SELECT 1 FROM public.platform_settings WHERE key = 'outbound.calling_paused') THEN
    RAISE EXCEPTION 'GATE_C1_OBJECTS_ALREADY_EXIST';
  END IF;
  -- The function the migration replaces is exactly 20261119090000's.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admit_single_outbound_call'
        AND pg_get_function_identity_arguments(oid) = '_org uuid, _phone_number_id uuid, _destination text, _caller_number text, _idempotency_key text, _max_in_flight integer, _max_per_hour integer, _max_per_day integer, _max_per_destination_day integer')
     IS DISTINCT FROM '${ORIGINAL_SINGLE_MD5}' THEN
    RAISE EXCEPTION 'GATE_C1_PRECONDITION: admit_single_outbound_call differs from 20261119090000';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.campaign_contacts'::regclass AND conname = 'campaign_contacts_status_check')
     IS DISTINCT FROM ${lit(CC_STATUS_BEFORE)} THEN
    RAISE EXCEPTION 'GATE_C1_PRECONDITION: campaign_contacts_status_check differs';
  END IF;
  IF (SELECT relacl::text FROM pg_class WHERE oid = 'public.campaigns'::regclass) IS DISTINCT FROM '${CAMPAIGNS_ACL}' THEN
    RAISE EXCEPTION 'GATE_C1_PRECONDITION: campaigns table privileges differ';
  END IF;
  -- Production fingerprint (2026-11-20, after R7-B).
  IF NOT EXISTS (SELECT 1 FROM public.agent_configs WHERE id = 'b2972814-d9a1-432a-b5bc-820c4282c34d'
                  AND sarvam_app_id = 'Conversatio-9c6a04cd-3334' AND sarvam_app_version = 5
                  AND sarvam_outbound_app_id = 'Smile-Denta-a17cec18-1c23' AND sarvam_outbound_app_version = 2
                  AND sarvam_outbound_ready_app_id = 'Smile-Denta-a17cec18-1c23' AND sarvam_outbound_ready_version = 2
                  AND sarvam_outbound_max_call_seconds = 300) THEN
    RAISE EXCEPTION 'GATE_C1_FINGERPRINT: Smile Dental agent mapping differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.phone_numbers WHERE right(e164, 4) = '0061' AND status = 'active'
                  AND provider_deployment_id = 'Smile-Denta-be071be0-703e' AND inbound_enabled AND NOT outbound_enabled) THEN
    RAISE EXCEPTION 'GATE_C1_FINGERPRINT: 0061 mapping differs';
  END IF;
  IF (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) <> 0 THEN
    RAISE EXCEPTION 'GATE_C1_PRECONDITION: a number has outbound enabled';
  END IF;
  IF (SELECT count(*) FROM public.campaigns) <> 0 OR (SELECT count(*) FROM public.campaign_contacts) <> 0 THEN
    RAISE EXCEPTION 'GATE_C1_PRECONDITION: campaigns exist';
  END IF;
  IF (SELECT count(*) FROM public.call_logs WHERE direction = 'outbound'
        AND (status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown')
             OR (billing_applied_at IS NULL AND finalization_state IN ('pending', 'failed')))) <> 0 THEN
    RAISE EXCEPTION 'GATE_C1_PRECONDITION: an outbound call is open or unbilled';
  END IF;
  IF (SELECT count(*) FROM public.sarvam_agent_integrations WHERE status = 'active' AND role = 'inbound') <> 1
     OR (SELECT count(*) FROM public.sarvam_agent_integrations WHERE status = 'active' AND role = 'outbound') <> 1 THEN
    RAISE EXCEPTION 'GATE_C1_PRECONDITION: expected exactly one active inbound and one active outbound credential';
  END IF;
  IF (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'GATE_C1_PRECONDITION: Payment Enforcement is not explicitly disabled';
  END IF;
  -- Fingerprints kept in transaction-local settings (no table is written).
  PERFORM set_config('gate_c1.data_before', md5(${FINGERPRINT}), true);
  PERFORM set_config('gate_c1.policies_before', ${POLICIES}, true);
END $guard$;

-- ===== Migration ${VERSION} (exact file content) =====
${migration}
-- ===== Migration history (same format as every recent row: the whole file as one element) =====
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('${VERSION}', '${NAME}', ARRAY[${TAG}${migration}${TAG}]);

-- ===== Emergency stop setting: exists, private, off =====
INSERT INTO public.platform_settings (key, value, description, is_public)
VALUES ('outbound.calling_paused', '{"enabled": false}'::jsonb,
        'Emergency stop: while enabled, no new outbound call (single or campaign) is admitted.', false);

-- ===== In-transaction check: anything unexpected raises and rolls back everything =====
DO $check$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
        AND ((table_name = 'campaigns' AND column_name IN (${list(NEW_CAMPAIGN_COLS)}))
          OR (table_name = 'campaign_contacts' AND column_name = 'excluded_reason')
          OR (table_name = 'call_logs' AND column_name = 'campaign_context_snapshot'))) <> 8 THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: expected 8 new columns';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.campaigns'::regclass
        AND conname IN ('campaigns_description_length', 'campaigns_budget_limit_positive', 'campaigns_context_reviewed')) <> 3 THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: expected 3 new campaigns constraints';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.campaign_contacts'::regclass AND conname = 'campaign_contacts_status_check')
     IS DISTINCT FROM ${lit(CC_STATUS_AFTER)} THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: campaign_contacts_status_check';
  END IF;
  IF to_regprocedure('public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer, timestamptz, text, text)') IS NULL
     OR to_regprocedure('public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer)') IS NOT NULL
     OR to_regprocedure('public.within_outbound_calling_hours(timestamptz)') IS NULL
     OR to_regprocedure('public.outbound_admission_now()') IS NULL
     OR to_regprocedure('public.call_logs_context_snapshot_immutable()') IS NULL THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: functions and signatures';
  END IF;
  IF has_function_privilege('anon', 'public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer, timestamptz, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer, timestamptz, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer, timestamptz, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.outbound_admission_now()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.outbound_admission_now()', 'EXECUTE') THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: function privileges';
  END IF;
  IF (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.call_logs'::regclass AND tgname = 'trg_call_logs_context_snapshot_immutable')
     IS DISTINCT FROM 'CREATE TRIGGER trg_call_logs_context_snapshot_immutable BEFORE UPDATE OF campaign_context_snapshot ON public.call_logs FOR EACH ROW EXECUTE FUNCTION call_logs_context_snapshot_immutable()' THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: snapshot trigger: %', (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_call_logs_context_snapshot_immutable');
  END IF;
  IF public.within_outbound_calling_hours('2026-11-20 03:29:59+00') OR NOT public.within_outbound_calling_hours('2026-11-20 03:30:00+00')
     OR NOT public.within_outbound_calling_hours('2026-11-20 15:29:59+00') OR public.within_outbound_calling_hours('2026-11-20 15:30:00+00') THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: calling hours (09:00-21:00 IST)';
  END IF;
  IF (SELECT bool_and(prosrc LIKE '%outbound.calling_paused%'
                      AND prosrc LIKE '%within_outbound_calling_hours(public.outbound_admission_now())%'
                      AND prosrc LIKE '%started_at > now() - interval ''15 minutes''%'
                      AND prosrc LIKE '%billing_applied_at IS NULL AND finalization_state IN (''pending'', ''failed'')%')
        FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('admit_campaign_outbound_call', 'admit_single_outbound_call'))
     IS NOT TRUE
     OR (SELECT prosrc NOT LIKE '%FOR SHARE%' FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admit_campaign_outbound_call') THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: admission logic (stop, hours, 15-minute in-flight, unbilled reservation, campaign lock)';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.campaigns', 'description', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.campaigns', 'budget_limit', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.campaigns', 'context', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.campaigns', 'context_reviewed_at', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.campaigns', 'status', 'UPDATE')
     OR (SELECT relacl::text FROM pg_class WHERE oid = 'public.campaigns'::regclass) IS DISTINCT FROM '${CAMPAIGNS_ACL}' THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: campaigns grants';
  END IF;
  IF ${POLICIES} IS DISTINCT FROM current_setting('gate_c1.policies_before', true) THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: RLS policies changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_settings WHERE key = 'outbound.calling_paused'
                  AND value = '{"enabled": false}'::jsonb AND is_public = false) THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: emergency stop setting';
  END IF;
  IF (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '${VERSION}') IS DISTINCT FROM '${md5(migration)}' THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: history';
  END IF;
  IF md5(${FINGERPRINT}) IS DISTINCT FROM current_setting('gate_c1.data_before', true) THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: existing data changed';
  END IF;
  IF (SELECT count(*) FROM public.call_logs WHERE campaign_context_snapshot IS NOT NULL) <> 0
     OR (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) <> 0
     OR (SELECT count(*) FROM public.campaigns) <> 0 THEN
    RAISE EXCEPTION 'GATE_C1_CHECK: no data may be created besides the stop setting';
  END IF;
END $check$;

-- ===== Result (only if everything above passed) =====
SELECT json_build_object(
  'applied', '${VERSION}',
  'system_identifier', (SELECT system_identifier::text FROM pg_control_system()),
  'database', current_database(),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'emergency_stop', (SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused'),
  'existing_data_unchanged', true,
  'policies_unchanged', true,
  'lock_timeout', current_setting('lock_timeout'),
  'statement_timeout', current_setting('statement_timeout')
) AS gate_c1_result;
`;

const rollbackScript = `${header("GATE C1 rollback script: migration " + VERSION + " (campaign context engine).")}
-- DATA LOSS: campaign descriptions, reviewed contexts, budgets, excluded reasons
-- and every per-call context snapshot are deleted. Calls themselves survive.
-- If any such data exists the guard aborts unless this line is uncommented:
-- SET LOCAL gate_c1.accept_data_loss = 'yes';

-- ===== Guard =====
DO $guard$
BEGIN
${identityGuard}
  IF (SELECT max(version) FROM supabase_migrations.schema_migrations) IS DISTINCT FROM '${VERSION}' THEN
    RAISE EXCEPTION 'GATE_C1_ROLLBACK_UNEXPECTED_HISTORY: latest is %', (SELECT max(version) FROM supabase_migrations.schema_migrations);
  END IF;
  IF (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'paused', 'scheduled', 'queued')) <> 0 THEN
    RAISE EXCEPTION 'GATE_C1_ROLLBACK_PRECONDITION: cancel or complete every campaign first';
  END IF;
  IF (SELECT count(*) FROM public.call_logs WHERE direction = 'outbound'
        AND status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown')) <> 0 THEN
    RAISE EXCEPTION 'GATE_C1_ROLLBACK_PRECONDITION: an outbound call is open; wait for it or resolve it';
  END IF;
  IF ((SELECT count(*) FROM public.campaigns WHERE description IS NOT NULL OR context IS NOT NULL OR budget_limit IS NOT NULL)
      + (SELECT count(*) FROM public.campaign_contacts WHERE excluded_reason IS NOT NULL OR status = 'excluded')
      + (SELECT count(*) FROM public.call_logs WHERE campaign_context_snapshot IS NOT NULL)) <> 0
     AND coalesce(current_setting('gate_c1.accept_data_loss', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'GATE_C1_ROLLBACK_DATA_LOSS: % campaigns, % contacts, % calls hold data this rollback deletes',
      (SELECT count(*) FROM public.campaigns WHERE description IS NOT NULL OR context IS NOT NULL OR budget_limit IS NOT NULL),
      (SELECT count(*) FROM public.campaign_contacts WHERE excluded_reason IS NOT NULL OR status = 'excluded'),
      (SELECT count(*) FROM public.call_logs WHERE campaign_context_snapshot IS NOT NULL);
  END IF;
  PERFORM set_config('gate_c1.calls_before', (SELECT count(*)::text FROM public.call_logs), true);
END $guard$;

-- ===== 1. Restore admit_single_outbound_call exactly as 20261119090000 defines it =====
${originalSingle}

-- ===== 2. Reviewed rollback statements (${ROLLBACK_PATH}, without BEGIN/COMMIT) =====
${rollbackSql}

-- ===== 3. Calling-hours helpers, emergency stop setting, history row =====
DROP FUNCTION IF EXISTS public.within_outbound_calling_hours(timestamptz);
DROP FUNCTION IF EXISTS public.outbound_admission_now();
DELETE FROM public.platform_settings WHERE key = 'outbound.calling_paused';
DELETE FROM supabase_migrations.schema_migrations WHERE version = '${VERSION}';

-- ===== Check =====
DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admit_single_outbound_call')
     IS DISTINCT FROM '${ORIGINAL_SINGLE_MD5}'
     OR has_function_privilege('authenticated', 'public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'GATE_C1_ROLLBACK_CHECK: admit_single_outbound_call not restored';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${list(NEW_FUNCTIONS)})) <> 0
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_call_logs_context_snapshot_immutable')
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
           AND ((table_name = 'campaigns' AND column_name IN (${list(NEW_CAMPAIGN_COLS)}))
             OR (table_name = 'campaign_contacts' AND column_name = 'excluded_reason')
             OR (table_name = 'call_logs' AND column_name = 'campaign_context_snapshot'))) <> 0
     OR (SELECT count(*) FROM pg_constraint WHERE conname IN ('campaigns_description_length', 'campaigns_budget_limit_positive', 'campaigns_context_reviewed')) <> 0 THEN
    RAISE EXCEPTION 'GATE_C1_ROLLBACK_CHECK: migration objects remain';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.campaign_contacts'::regclass AND conname = 'campaign_contacts_status_check')
     IS DISTINCT FROM ${lit(CC_STATUS_BEFORE)} THEN
    RAISE EXCEPTION 'GATE_C1_ROLLBACK_CHECK: campaign_contacts_status_check';
  END IF;
  IF (SELECT max(version) FROM supabase_migrations.schema_migrations) IS DISTINCT FROM '20261120090000'
     OR EXISTS (SELECT 1 FROM public.platform_settings WHERE key = 'outbound.calling_paused') THEN
    RAISE EXCEPTION 'GATE_C1_ROLLBACK_CHECK: history or stop setting';
  END IF;
  IF (SELECT count(*)::text FROM public.call_logs) IS DISTINCT FROM current_setting('gate_c1.calls_before', true) THEN
    RAISE EXCEPTION 'GATE_C1_ROLLBACK_CHECK: calls changed';
  END IF;
END $check$;

SELECT json_build_object(
  'rolled_back', '${VERSION}',
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'admit_single_restored', true,
  'calls', (SELECT count(*) FROM public.call_logs)
) AS gate_c1_rollback_result;
`;

writeFileSync(join(OUT, `gate-c1-execute-${VERSION}.sql`), execute);
writeFileSync(join(OUT, `gate-c1-rollback-${VERSION}.sql`), rollbackScript);
console.log(
  JSON.stringify(
    {
      systemId: SYSTEM_ID,
      database: DATABASE,
      out: OUT,
      execute: sha256(execute),
      rollback: sha256(rollbackScript),
      migration: sha256(migration),
      migrationMd5: md5(migration),
    },
    null,
    1,
  ),
);
