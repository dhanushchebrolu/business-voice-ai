#!/usr/bin/env node
// Builds the production package for ONE of the outbound reliability migrations
// (20261123..20261128), from the repository files, so the executed and recorded
// SQL is byte-identical to them (same pattern as build-gate-c4h1-package.mjs):
//   docs/gate-outbound-execute-<version>.sql   apply  (guard, migration, history, check)
//   docs/gate-outbound-rollback-<version>.sql  undo   (guard, rollback, history, check)
//   docs/gate-outbound-verify-<version>.sql    read-only verification
// Usage: node scripts/build-gate-outbound-package.mjs <version> [--system-id <id>] [--database <name>] [--out <dir>]
// Defaults target production (system identifier 7678069749886157684, database
// "postgres", output docs/). A rehearsal build for another cluster passes its own id.
// Each migration is applied separately, after its own approval.
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

// One entry per migration. `absent`/`present` are SQL booleans for its objects;
// `newColumns` are left out of the data fingerprint (adding a column changes to_jsonb).
// Every outbound reliability migration (20261123-20261128) is described.

// A function by signature: invoker (not SECURITY DEFINER), owned by postgres, empty
// search_path, executable by service_role only. `source` adds a prosrc condition.
const fn = (sig, source = "") => {
  const p = `to_regprocedure('public.${sig}')`;
  return `(SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""']${source ? ` AND ${source}` : ""}
            FROM pg_proc WHERE oid = ${p})
     AND has_function_privilege('service_role', ${p}, 'EXECUTE')
     AND NOT has_function_privilege('anon', ${p}, 'EXECUTE')
     AND NOT has_function_privilege('authenticated', ${p}, 'EXECUTE')`;
};
const cols = (table, names) =>
  `(SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}'
         AND column_name IN (${names.map((n) => `'${n}'`).join(", ")}))`;
const noCols = (table, names) =>
  `NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}'
                  AND column_name IN (${names.map((n) => `'${n}'`).join(", ")}))`;
const conDef = (table, name) =>
  `(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.${table}'::regclass AND conname = '${name}' AND convalidated)`;
const idxDef = (name) =>
  `(SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${name}')`;
const srcHas = (sig, text) =>
  `position('${text}' in (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.${sig}'))) > 0`;
const CLAIM_SIG = "claim_webhook_event(text, text, text, jsonb, integer, integer)";
const FENCED_SIG = "apply_call_event_fenced(text, text, uuid, uuid, jsonb)";
const BILLING_SIG = "apply_call_billing(uuid, uuid, integer, integer, text, integer, text)";
const VERIFY_SIG = "verify_call_duration(uuid, integer)";
const CLAIM_COLS = ["claim_token", "claimed_at", "attempts"];

// The one foreign key from `tbl` to `parent`: named `name`, on `cols` -> `pcols`, ON DELETE
// CASCADE, validated. Exactly one key per pair keeps PostgREST embeds unambiguous (PGRST201).
const fk = (tbl, name, cols, parent, pcols) => {
  const names = (side, rel) =>
    `ARRAY(SELECT a.attname::text FROM unnest(k.${side}) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.${rel} AND a.attnum = u.n ORDER BY u.o)`;
  const list = (xs) => `ARRAY[${xs.map((x) => `'${x}'`).join(", ")}]`;
  return `(SELECT count(*) FROM pg_constraint k WHERE k.conrelid = 'public.${tbl}'::regclass AND k.contype = 'f' AND k.confrelid = 'public.${parent}'::regclass) = 1
     AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = 'public.${tbl}'::regclass AND k.conname = '${name}' AND k.contype = 'f'
           AND k.confrelid = 'public.${parent}'::regclass AND k.confdeltype = 'c' AND k.convalidated
           AND ${names("conkey", "conrelid")} = ${list(cols)} AND ${names("confkey", "confrelid")} = ${list(pcols)})`;
};
const TENANT_FKS = (composite) =>
  [
    ["campaign_contacts", "campaign_contacts_campaign_id_fkey", "campaign_id", "campaigns"],
    ["campaign_contacts", "campaign_contacts_contact_id_fkey", "contact_id", "contacts"],
    ["campaign_uploads", "campaign_uploads_campaign_id_fkey", "campaign_id", "campaigns"],
  ]
    .map(([t, n, c, p]) =>
      composite
        ? fk(t, n, [c, "organization_id"], p, ["id", "organization_id"])
        : fk(t, n, [c], p, ["id"]),
    )
    .join("\n     AND ");

const GATES = {
  20261123090000: {
    name: "campaign_creation_idempotency",
    previous: "20261122090000",
    rollback: "docs/production-rollback-20261123090000-campaign-creation-idempotency.sql",
    absent: `NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaigns' AND column_name = 'idempotency_key')
     AND to_regclass('public.idx_campaigns_org_idempotency_key') IS NULL`,
    present: `(SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaigns' AND column_name = 'idempotency_key') = 'text'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_campaigns_org_idempotency_key')
         = 'CREATE UNIQUE INDEX idx_campaigns_org_idempotency_key ON public.campaigns USING btree (organization_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)'`,
    newColumns: { campaigns: ["idempotency_key"] },
  },
  20261124090000: {
    name: "campaign_contact_import_atomic",
    previous: "20261123090000",
    rollback: "docs/production-rollback-20261124090000-campaign-contact-import-atomic.sql",
    absent: `NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaign_uploads'
                  AND column_name IN ('enrolled_rows', 'already_in_campaign_rows', 'opted_out_rows', 'idempotency_key'))
     AND to_regclass('public.idx_campaign_uploads_org_idempotency_key') IS NULL
     AND to_regprocedure('public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)') IS NULL`,
    present: `(SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY column_name) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'campaign_uploads'
          AND column_name IN ('enrolled_rows', 'already_in_campaign_rows', 'opted_out_rows', 'idempotency_key'))
         = 'already_in_campaign_rows:integer,enrolled_rows:integer,idempotency_key:text,opted_out_rows:integer'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_campaign_uploads_org_idempotency_key')
         = 'CREATE UNIQUE INDEX idx_campaign_uploads_org_idempotency_key ON public.campaign_uploads USING btree (organization_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)'
     AND (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""']
            FROM pg_proc WHERE oid = to_regprocedure('public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)'))
     AND has_function_privilege('service_role', 'public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)', 'EXECUTE')`,
    newColumns: {
      campaign_uploads: [
        "enrolled_rows",
        "already_in_campaign_rows",
        "opted_out_rows",
        "idempotency_key",
      ],
    },
  },
  20261125090000: {
    name: "campaign_tenant_integrity",
    previous: "20261124090000",
    rollback: "docs/production-rollback-20261125090000-campaign-tenant-integrity.sql",
    absent: `${TENANT_FKS(false)}
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('campaigns_id_organization_id_key', 'contacts_id_organization_id_key',
           'campaign_contacts_campaign_same_org_fkey', 'campaign_contacts_contact_same_org_fkey', 'campaign_uploads_campaign_same_org_fkey'))`,
    present: `${TENANT_FKS(true)}
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.campaigns'::regclass AND conname = 'campaigns_id_organization_id_key') = 'UNIQUE (id, organization_id)'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.contacts'::regclass AND conname = 'contacts_id_organization_id_key') = 'UNIQUE (id, organization_id)'`,
    newColumns: {},
  },
  20261126090000: {
    name: "webhook_event_claim_lease",
    previous: "20261125090000",
    rollback: "docs/production-rollback-20261126090000-webhook-event-claim-lease.sql",
    absent: `${noCols("webhook_events", CLAIM_COLS)}
     AND to_regprocedure('public.${CLAIM_SIG}') IS NULL
     AND to_regprocedure('public.${FENCED_SIG}') IS NULL`,
    present: `${cols("webhook_events", CLAIM_COLS)}
         = 'attempts:integer:NO:0,claim_token:uuid:YES:-,claimed_at:timestamp with time zone:YES:-'
     AND ${fn(CLAIM_SIG)}
     AND ${fn(FENCED_SIG, `NOT ${srcHas(FENCED_SIG, "billing_hold")}`)}`,
    newColumns: { webhook_events: CLAIM_COLS },
  },
  20261127090000: {
    name: "wallet_ledger_integrity",
    previous: "20261126090000",
    rollback: "docs/production-rollback-20261127090000-wallet-ledger-integrity.sql",
    absent: `${noCols("wallet_transactions", ["idempotency_key"])}
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.wallet_transactions'::regclass
                       AND conname IN ('wallet_tx_idempotency_key_format', 'wallet_tx_call_usage_has_reference'))
     AND to_regclass('public.idx_wallet_tx_idempotency_key') IS NULL
     AND ${idxDef("idx_wallet_tx_call_usage_ref")} = 'CREATE UNIQUE INDEX idx_wallet_tx_call_usage_ref ON public.wallet_transactions USING btree (organization_id, reference) WHERE (kind = ''call_usage''::text)'`,
    present: `${cols("wallet_transactions", ["idempotency_key"])} = 'idempotency_key:text:YES:-'
     AND ${conDef("wallet_transactions", "wallet_tx_idempotency_key_format")}
         = 'CHECK (((idempotency_key IS NULL) OR (idempotency_key ~ ''^[A-Za-z0-9_-]{16,100}$''::text)))'
     AND ${conDef("wallet_transactions", "wallet_tx_call_usage_has_reference")}
         = 'CHECK (((kind <> ''call_usage''::text) OR (reference IS NOT NULL)))'
     AND ${idxDef("idx_wallet_tx_idempotency_key")}
         = 'CREATE UNIQUE INDEX idx_wallet_tx_idempotency_key ON public.wallet_transactions USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)'
     AND ${idxDef("idx_wallet_tx_call_usage_ref")} = 'CREATE UNIQUE INDEX idx_wallet_tx_call_usage_ref ON public.wallet_transactions USING btree (organization_id, reference) WHERE (kind = ''call_usage''::text)'`,
    newColumns: { wallet_transactions: ["idempotency_key"] },
  },
  20261128090000: {
    name: "call_billing_hold",
    previous: "20261127090000",
    rollback: "docs/production-rollback-20261128090000-call-billing-hold.sql",
    // Before (and after rollback): neither function mentions billing_hold, verify_call_duration is absent.
    absent: `${noCols("call_logs", ["billing_hold"])}
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.call_logs'::regclass AND conname = 'call_logs_billing_hold_check')
     AND to_regclass('public.idx_call_logs_billing_hold') IS NULL
     AND to_regprocedure('public.${VERIFY_SIG}') IS NULL
     AND ${fn(BILLING_SIG, `NOT ${srcHas(BILLING_SIG, "billing_hold")}`)}
     AND ${fn(FENCED_SIG, `NOT ${srcHas(FENCED_SIG, "billing_hold")}`)}`,
    present: `${cols("call_logs", ["billing_hold"])} = 'billing_hold:text:YES:-'
     AND ${conDef("call_logs", "call_logs_billing_hold_check")}
         = 'CHECK (((billing_hold IS NULL) OR (billing_hold = ''duration_unknown''::text)))'
     AND ${idxDef("idx_call_logs_billing_hold")}
         = 'CREATE INDEX idx_call_logs_billing_hold ON public.call_logs USING btree (started_at) WHERE (billing_hold IS NOT NULL)'
     AND has_column_privilege('authenticated', 'public.call_logs', 'billing_hold', 'SELECT')
     AND ${fn(VERIFY_SIG)}
     AND ${fn(BILLING_SIG, srcHas(BILLING_SIG, "BILLING_ON_HOLD"))}
     AND ${fn(FENCED_SIG, srcHas(FENCED_SIG, "billing_hold"))}`,
    newColumns: { call_logs: ["billing_hold"] },
  },
};

const VERSION = process.argv[2];
const gate = GATES[VERSION];
if (!gate) throw new Error(`no gate described for ${VERSION}`);
const MIGRATION_PATH = `supabase/migrations/${VERSION}_${gate.name}.sql`;
const read = (p) => readFileSync(join(root, p), "utf8");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const migration = read(MIGRATION_PATH);
const rollback = read(gate.rollback);

const TAG = "$gate_outbound_mig$";
const P = `GATE_${VERSION}`;
if (migration.includes(TAG)) throw new Error("dollar tag collides with the migration text");
if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(migration))
  throw new Error("the migration must not control the transaction");
const rollbackSql = rollback
  .split("\n")
  .filter((l) => !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
  .join("\n");

// Rows the migration must not change. Columns it adds are left out of the fingerprint.
const TABLES = [
  "campaigns",
  "campaign_contacts",
  "campaign_uploads",
  "contacts",
  "phone_numbers",
  "agent_configs",
  "platform_settings",
  "call_logs",
  "wallet_transactions",
  "webhook_events",
];
const fp = (t) => {
  const drop = (gate.newColumns[t] ?? []).map((c) => ` - '${c}'`).join("");
  return `(SELECT '${t}:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x)${drop})::text, '|' ORDER BY (to_jsonb(x)${drop})::text)), '-') FROM public.${t} x)`;
};
const FINGERPRINT = TABLES.map(fp).join(" || ';' || ");

const header = (title) => `-- ${title}
-- Target: Supabase project eorazvlmqwunmhwviocn, database "${DATABASE}",
-- PostgreSQL system identifier ${SYSTEM_ID}.
-- Generated by scripts/build-gate-outbound-package.mjs from:
--   ${MIGRATION_PATH}  ${sha256(migration)}
--   ${gate.rollback}  ${sha256(rollback)}
-- Run ONCE, as ONE request (the query channel runs it as ONE transaction; any
-- error, including every guard and check below, rolls back EVERYTHING):
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
-- No BEGIN/COMMIT on purpose.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
`;

const identityGuard = `  IF (SELECT system_identifier::text FROM pg_control_system()) IS DISTINCT FROM '${SYSTEM_ID}' THEN
    RAISE EXCEPTION '${P}_WRONG_DATABASE: system identifier %', (SELECT system_identifier::text FROM pg_control_system());
  END IF;
  IF current_database() IS DISTINCT FROM '${DATABASE}' THEN
    RAISE EXCEPTION '${P}_WRONG_DATABASE: database %', current_database();
  END IF;`;

// Unchanged by every outbound gate: these must hold before and after.
const SAFETY = `(SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb`;

const execute = `${header(`Outbound gate: execution script for migration ${VERSION} (${gate.name}).`)}
-- ===== Guard: abort before any change unless this is the expected database in the expected state =====
DO $guard$
BEGIN
${identityGuard}
  IF (SELECT max(version) FROM supabase_migrations.schema_migrations) IS DISTINCT FROM '${gate.previous}' THEN
    RAISE EXCEPTION '${P}_UNEXPECTED_HISTORY: latest is %', (SELECT max(version) FROM supabase_migrations.schema_migrations);
  END IF;
  IF NOT (${gate.absent}) THEN
    RAISE EXCEPTION '${P}_OBJECTS_ALREADY_EXIST';
  END IF;
  IF NOT (${SAFETY}) THEN
    RAISE EXCEPTION '${P}_PRECONDITION: outbound safety state differs from the audit (stop, number, campaign or payment setting)';
  END IF;
  PERFORM set_config('gate_outbound.data_before', md5(${FINGERPRINT}), true);
END
$guard$;

-- ===== The migration, byte for byte (${MIGRATION_PATH}) =====
${migration}
-- ===== History =====
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('${VERSION}', '${gate.name}', ARRAY[${TAG}${migration}${TAG}]);

-- ===== Check, inside the same transaction: any failure rolls everything back =====
DO $check$
BEGIN
  IF NOT (${gate.present}) THEN
    RAISE EXCEPTION '${P}_CHECK: the migration objects are not as expected';
  END IF;
  IF (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '${VERSION}') IS DISTINCT FROM '${md5(migration)}' THEN
    RAISE EXCEPTION '${P}_CHECK: recorded migration text differs';
  END IF;
  IF md5(${FINGERPRINT}) IS DISTINCT FROM current_setting('gate_outbound.data_before', true) THEN
    RAISE EXCEPTION '${P}_CHECK: existing data changed';
  END IF;
  IF NOT (${SAFETY}) THEN
    RAISE EXCEPTION '${P}_CHECK: outbound safety state changed';
  END IF;
END
$check$;

SELECT json_build_object(
  'applied', '${VERSION}',
  'system_identifier', (SELECT system_identifier::text FROM pg_control_system()),
  'database', current_database(),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', (${gate.present}),
  'existing_data_unchanged', md5(${FINGERPRINT}) = current_setting('gate_outbound.data_before', true),
  'lock_timeout', current_setting('lock_timeout'),
  'statement_timeout', current_setting('statement_timeout')
) AS gate_outbound_result;
`;

const rollbackScript = `${header(`Outbound gate: rollback script for migration ${VERSION} (${gate.name}).`)}
-- Runs the reviewed rollback and removes the history row. Roll back in
-- reverse order only (the latest applied migration first).
DO $guard$
BEGIN
${identityGuard}
  IF (SELECT max(version) FROM supabase_migrations.schema_migrations) IS DISTINCT FROM '${VERSION}' THEN
    RAISE EXCEPTION '${P}_ROLLBACK_UNEXPECTED_HISTORY: latest is %', (SELECT max(version) FROM supabase_migrations.schema_migrations);
  END IF;
  PERFORM set_config('gate_outbound.data_before', md5(${FINGERPRINT}), true);
END
$guard$;

-- ===== The reviewed rollback statements (${gate.rollback}, without BEGIN/COMMIT) =====
${rollbackSql}
DELETE FROM supabase_migrations.schema_migrations WHERE version = '${VERSION}';

DO $check$
BEGIN
  IF NOT (${gate.absent}) THEN
    RAISE EXCEPTION '${P}_ROLLBACK_CHECK: an object remains';
  END IF;
  IF (SELECT max(version) FROM supabase_migrations.schema_migrations) IS DISTINCT FROM '${gate.previous}' THEN
    RAISE EXCEPTION '${P}_ROLLBACK_CHECK: history is not back to ${gate.previous}';
  END IF;
  IF md5(${FINGERPRINT}) IS DISTINCT FROM current_setting('gate_outbound.data_before', true) THEN
    RAISE EXCEPTION '${P}_ROLLBACK_CHECK: existing data changed';
  END IF;
END
$check$;

SELECT json_build_object(
  'rolled_back', '${VERSION}',
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_absent', (${gate.absent}),
  'existing_data_unchanged', md5(${FINGERPRINT}) = current_setting('gate_outbound.data_before', true)
) AS gate_outbound_rollback_result;
`;

const verify = `-- Outbound gate: post-migration verification for ${VERSION} (${gate.name}).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '${SYSTEM_ID}'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '${VERSION}'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '${VERSION}') = '${md5(migration)}'
    AND (${gate.present})
    AND (${SAFETY}),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', (${gate.present}),
  'outbound_safety_unchanged', (${SAFETY}),
  'transaction_read_only', current_setting('transaction_read_only')
) AS gate_outbound_verify;
rollback;
`;

writeFileSync(join(OUT, `gate-outbound-execute-${VERSION}.sql`), execute);
writeFileSync(join(OUT, `gate-outbound-rollback-${VERSION}.sql`), rollbackScript);
writeFileSync(join(OUT, `gate-outbound-verify-${VERSION}.sql`), verify);
console.log(
  JSON.stringify({
    version: VERSION,
    systemId: SYSTEM_ID,
    migrationSha256: sha256(migration),
    rollbackSha256: sha256(rollback),
    recordedMd5: md5(migration),
  }),
);
