# GATE R2: production migration preflight (read-only, 2026-11-20)

Migrations: `20261119090000_outbound_call_admission.sql` (M1) and `20261120090000_dual_agent_provisioning.sql` (M2), branch `feature/provisioning-phase1` at `05b727c`. Everything below was read from production inside `begin transaction read only … rollback` (`transaction_read_only = on` confirmed). Nothing was applied, written or deployed.

**Recommendation: NO-GO until blocker B1 is closed** (see §10). Everything else is ready.

## 1. Production PostgreSQL

`PostgreSQL 17.6 on x86_64-pc-linux-gnu` (`server_version_num` 170006). Session defaults for the CLI role: `lock_timeout = 0` (wait forever), `statement_timeout = 2min`.

The migrations' PostgreSQL tests ran on **PostgreSQL 18** only (CI runner image and the local test server, 18.6). See B1.

## 2. Migration history

- 70 versions applied, latest `20261118120000`. Every applied version exists in the repo; no drift.
- Pending in the repo: exactly `20261119090000` and `20261120090000`. Nothing else.

| File                                                                  | SHA-256                                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `supabase/migrations/20261119090000_outbound_call_admission.sql`      | `f7d10f0d1076f7787731ff529b1eee17a767bf707f3937bfb88334dd85ce764e` (matches the runbook) |
| `docs/production-rollback-20261119090000-outbound-call-admission.sql` | `f0b9d90fae2d46aff4148e2a2f52766402e7c7039c20e79c6e8dffa747cb63af` (matches the runbook) |
| `supabase/migrations/20261120090000_dual_agent_provisioning.sql`      | `b32b117e2eb9187273311f10a79eb083768caf6e1f663df70b13d47d6d3e5053`                       |
| `docs/production-rollback-20261120090000-dual-agent-provisioning.sql` | `61c121fbed817717577a6993cf3fc0dafd5a13deee550ec2ff00b3ee18efecd6`                       |

## 3. Review

**M1 (outbound call admission).** Adds `agent_configs.sarvam_outbound_max_call_seconds` (CHECK 60–3600 or NULL); `call_logs.idempotency_key`, `billing_cap_minutes`, `billing_rate_per_minute` (format CHECK; cap/rate set together, cap 1–60, rate ≥ 0); four indexes on `call_logs` (unique per org + idempotency key; two partial indexes for single outbound calls; inbound caller lookup); function `admit_single_outbound_call` (plpgsql, `search_path = public`, EXECUTE revoked from PUBLIC/anon/authenticated, granted to service_role).
Dependencies, all present in production: `call_logs` columns `organization_id, phone_number_id, provider, direction, caller_number, destination_number, status, started_at, campaign_id, resolution_source, finalization_state`; `call_logs` status CHECK includes `initiated` and `outcome_unknown`; `idx_call_logs_sarvam_outbound_number_reservation` (the function relies on its unique violation); `organization_pricing_overrides(organization_id, key, customer_amount)`, `pricing_rules(key, customer_amount)`, `wallet_balances(organization_id, balance)`, `organizations`, `phone_numbers`.

**M2 (dual-agent provisioning).** Adds `agent_configs.sarvam_outbound_app_id/_version/_registered_at/_registered_by` (pair CHECK), unique partial index on the outbound app id, function + trigger `agent_configs_sarvam_role_guard` (fires on `sarvam_app_id`, `sarvam_application_id`, `sarvam_outbound_app_id`); `sarvam_agent_integrations.role` (`NOT NULL DEFAULT 'inbound'`, CHECK inbound/outbound); creates `idx_sarvam_agent_integrations_one_active_per_role (agent_config_id, role) WHERE status = 'active'`, then drops `idx_sarvam_agent_integrations_one_active`.
Dependencies, present: `agent_configs.sarvam_app_id`, `sarvam_application_id`; `sarvam_applications.sarvam_app_id`; existing trigger `trg_agent_configs_sarvam_application_guard`, which sorts before `trg_agent_configs_sarvam_role_guard` and so runs first (BEFORE triggers fire in name order), giving the role guard the resolved app id.

M2 does not depend on M1 objects; M1 does not depend on M2. Order by version: M1 then M2.

**Name collisions:** none. The only existing object either migration names is `idx_sarvam_agent_integrations_one_active`, which M2 intends to replace.

**Data writes at apply time:** none. The only `INSERT` is inside `admit_single_outbound_call` and runs only when called (by the new Worker). Neither file touches `phone_numbers`, `campaigns`, `platform_settings`, pricing, wallets or any agent/number mapping.

**Re-runnable:** every statement is `IF NOT EXISTS`, `DROP … IF EXISTS` then create, or `CREATE OR REPLACE`. A partial apply can be completed by running the file again.

## 4. Locks, scans, transactions, downtime

Table sizes: `call_logs` 207 rows / 656 kB; `agent_configs` 2 rows / 72 kB; `sarvam_agent_integrations` 1 row / 80 kB.

| Statement                                      | Lock                  | Work                                     |
| ---------------------------------------------- | --------------------- | ---------------------------------------- |
| `ADD COLUMN` (nullable, no default)            | ACCESS EXCLUSIVE      | catalog only                             |
| `ADD COLUMN role … NOT NULL DEFAULT 'inbound'` | ACCESS EXCLUSIVE      | catalog only (constant default, PG ≥ 11) |
| `ADD CONSTRAINT … CHECK`                       | ACCESS EXCLUSIVE      | full scan to validate: 207 / 2 / 1 rows  |
| `CREATE [UNIQUE] INDEX` (not CONCURRENTLY)     | SHARE (blocks writes) | builds over 207 / 2 / 1 rows             |
| `CREATE TRIGGER`                               | SHARE ROW EXCLUSIVE   | catalog only                             |
| `DROP INDEX`                                   | ACCESS EXCLUSIVE      | catalog only                             |
| `CREATE OR REPLACE FUNCTION`, GRANT/REVOKE     | none on tables        | catalog only                             |

Expected lock hold time: milliseconds. If the runner wraps each file in one transaction, the ACCESS EXCLUSIVE locks are held until that file commits (still milliseconds). If it does not, each statement commits alone and a failure leaves earlier statements applied (harmless and re-runnable, see §3).

**Real risk: lock queueing.** With `lock_timeout = 0`, an `ALTER TABLE` waiting behind a long transaction on `call_logs`, `agent_configs` or `sarvam_agent_integrations` would queue every later query on that table. `agent_configs` and `sarvam_agent_integrations` are read on every Sarvam tool call (live Smile Dental inbound calls), `call_logs` by every call webhook. At preflight: no transaction older than 30 s, no locks held on the three tables. Mitigation in §8: set `lock_timeout = '5s'` for the session, check activity immediately before, apply outside clinic hours.

Downtime: none expected beyond millisecond write pauses on the three tables.

## 5. Rollback review

Run in reverse order: M2 rollback, then M1 rollback, each only after the Worker is back on a version that does not use the objects (`e48ff18`, the live version, uses neither).

**M2 rollback:** disables every active `role = 'outbound'` credential, recreates `idx_sarvam_agent_integrations_one_active`, drops the per-role index, the role CHECK and column, the trigger, function, outbound index, pair CHECK and the four outbound columns, and deletes the history row. Safe because at most one active credential per agent and role exists, so after disabling outbound ones at most one active credential per agent remains and the old index can be built. Data lost: outbound agent registrations (re-registrable from the audit log), and outbound credentials become unusable (intended). `sarvam_outbound_ready_*` (from 20261117180000) is left as is. If it points at an outbound agent, the old code compares it with the inbound mapping, finds no match and refuses outbound (fails closed).
**Unsafe if** the new Worker is still deployed: it selects `role` on every tool call, so tool authentication would fail and live inbound calls would get no business data. Revert the Worker first.

**M1 rollback:** drops the function, four indexes, two CHECKs and three `call_logs` columns, the agent CHECK and column, and the history row. Data lost: request ids and locked billing terms on calls made after M1, and agents' recorded max call length. Safe while no outbound call has been made under M1 (production has made **0 outbound calls ever**). After any call, run the pre-check in the file: an open call losing its cap would be billed uncapped at finalization. `DROP COLUMN` takes ACCESS EXCLUSIVE briefly (catalog only).

Both rollback files are explicit `BEGIN … COMMIT` and were tested forward → rollback → re-apply on PostgreSQL 18 (not 17, see B1).

## 6. Preconditions (all met at 2026-11-20 preflight)

- History ends at `20261118120000`; M1 and M2 not applied.
- No name collisions (§3).
- `sarvam_agent_integrations`: 1 row, active, for agent `b2972814…` (Smile Dental); no agent with two active credentials.
- `agent_configs`: 2 rows; Smile Dental `Conversatio-9c6a04cd-3334` v5, no shared application, `sarvam_outbound_ready_*` NULL; the other agent unmapped.
- Numbers: 0061 Sarvam active, inbound on, outbound **off**, deployment `Smile-Denta-be071be0-703e`; …0870 Vobiz active, inbound on, outbound **off**.
- Campaigns: 0 (0 running/scheduled). Outbound calls: 0 ever, 0 open.
- No long transactions, no locks on the target tables.

## 7. What the migrations cannot do

- **Outbound calling:** neither migration sets `phone_numbers.outbound_enabled`, `sarvam_outbound_ready_*`, `sarvam_outbound_max_call_seconds` or any outbound agent. After M1 the admission function refuses every call (`max_call_length_not_set`) until an admin confirms an agent. After M2 no customer has an outbound agent, so the new Worker's `outboundAgentTarget` dials nothing. The live Worker (`e48ff18`) is unaffected by the new columns.
- **Campaigns:** no campaign table is touched; 0 campaigns exist.
- **Payment enforcement:** no `platform_settings`, pricing, wallet or feature-lock write. M1's function only reads pricing and wallet when called.
- **Live mappings:** no `UPDATE` of `agent_configs`, `phone_numbers` or deployments. The new trigger only fires on future writes. The existing credential gains `role = 'inbound'` by default, which is exactly how both the live and the new Worker treat it.

## 8. Execution order (when approved)

1. Confirm the Worker is still `e48ff18` (both migrations are backward-compatible with it).
2. Run the pre-migration SQL (§9.1); stop if anything differs from §6.
3. In one session: `SET lock_timeout = '5s'; SET statement_timeout = '60s';`, check §9.1 `activity` is empty, apply **M1**, then **M2** (`supabase db push` applies both in version order; confirm the dry list shows exactly these two). If a lock timeout fires, nothing is lost: retry later.
4. Run the post-migration SQL (§9.2).
5. Only after that, deploy the new Worker (GATE R3–R4). **The new Worker must never run before M2**: it reads `sarvam_agent_integrations.role` on every tool call.

## 9. Verification SQL

Checked: §9.1 was run against production (read-only) and returned exactly the expected values below. §9.2 and §9.3 were run on a scratch local database (PostgreSQL 18) after applying all 72 migrations, then both rollbacks (M2 first); both returned the expected shape.

### 9.1 Pre-migration (read-only)

```sql
begin transaction read only;
select json_build_object(
  'pg', current_setting('server_version_num'),
  'latest', (select max(version) from supabase_migrations.schema_migrations),
  'm1_applied', exists(select 1 from supabase_migrations.schema_migrations where version = '20261119090000'),
  'm2_applied', exists(select 1 from supabase_migrations.schema_migrations where version = '20261120090000'),
  'collisions', (select count(*) from pg_indexes where schemaname = 'public' and indexname in
     ('idx_call_logs_org_idempotency_key','idx_call_logs_single_outbound_recent','idx_call_logs_single_outbound_open',
      'idx_call_logs_inbound_caller','idx_agent_configs_sarvam_outbound_app_id','idx_sarvam_agent_integrations_one_active_per_role'))
     + (select count(*) from pg_proc where proname in ('admit_single_outbound_call','agent_configs_sarvam_role_guard')),
  'two_active_credentials', (select count(*) from (select agent_config_id from public.sarvam_agent_integrations
     where status = 'active' group by agent_config_id having count(*) > 1) d),
  'outbound_numbers', (select count(*) from public.phone_numbers where outbound_enabled),
  'ready_agents', (select count(*) from public.agent_configs where sarvam_outbound_ready_app_id is not null),
  'campaigns', (select count(*) from public.campaigns),
  'open_outbound', (select count(*) from public.call_logs where direction = 'outbound'
     and status in ('initiated','ringing','answered','in_progress','outcome_unknown')),
  'activity', (select json_agg(json_build_object('pid', pid, 'age_s', extract(epoch from now() - xact_start)::int, 'state', state))
     from pg_stat_activity where xact_start is not null and now() - xact_start > interval '10 seconds' and pid <> pg_backend_pid())
) r;
rollback;
```

Expected: `latest = 20261118120000`, both `*_applied` false, `collisions 0`, `two_active_credentials 0`, `outbound_numbers 0`, `ready_agents 0`, `campaigns 0`, `open_outbound 0`, `activity` null.

### 9.2 Post-migration (read-only)

```sql
begin transaction read only;
select json_build_object(
  'history', (select json_agg(version order by version) from supabase_migrations.schema_migrations where version >= '20261119090000'),
  'm1_columns', (select count(*) from information_schema.columns where table_schema = 'public' and
     ((table_name = 'call_logs' and column_name in ('idempotency_key','billing_cap_minutes','billing_rate_per_minute'))
      or (table_name = 'agent_configs' and column_name = 'sarvam_outbound_max_call_seconds'))),
  'm2_columns', (select count(*) from information_schema.columns where table_schema = 'public' and
     ((table_name = 'agent_configs' and column_name in ('sarvam_outbound_app_id','sarvam_outbound_app_version','sarvam_outbound_registered_at','sarvam_outbound_registered_by'))
      or (table_name = 'sarvam_agent_integrations' and column_name = 'role'))),
  'invalid_indexes', (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid
     where c.relname in ('idx_call_logs_org_idempotency_key','idx_call_logs_single_outbound_recent','idx_call_logs_single_outbound_open',
       'idx_call_logs_inbound_caller','idx_agent_configs_sarvam_outbound_app_id','idx_sarvam_agent_integrations_one_active_per_role')
       and not i.indisvalid),
  'new_indexes', (select count(*) from pg_indexes where schemaname = 'public' and indexname in
     ('idx_call_logs_org_idempotency_key','idx_call_logs_single_outbound_recent','idx_call_logs_single_outbound_open',
      'idx_call_logs_inbound_caller','idx_agent_configs_sarvam_outbound_app_id','idx_sarvam_agent_integrations_one_active_per_role')),
  'old_index_gone', not exists(select 1 from pg_indexes where indexname = 'idx_sarvam_agent_integrations_one_active'),
  'trigger', exists(select 1 from pg_trigger where tgname = 'trg_agent_configs_sarvam_role_guard'),
  'admit_grants', json_build_object(
     'service_role', has_function_privilege('service_role', 'public.admit_single_outbound_call(uuid,uuid,text,text,text,integer,integer,integer,integer)', 'execute'),
     'anon', has_function_privilege('anon', 'public.admit_single_outbound_call(uuid,uuid,text,text,text,integer,integer,integer,integer)', 'execute'),
     'authenticated', has_function_privilege('authenticated', 'public.admit_single_outbound_call(uuid,uuid,text,text,text,integer,integer,integer,integer)', 'execute')),
  'credentials', (select json_agg(json_build_object('agent', agent_config_id, 'status', status, 'role', role)) from public.sarvam_agent_integrations),
  'agents', (select json_agg(json_build_object('app', sarvam_app_id, 'v', sarvam_app_version, 'out', sarvam_outbound_app_id,
     'ready', sarvam_outbound_ready_app_id, 'max', sarvam_outbound_max_call_seconds)) from public.agent_configs),
  'numbers', (select json_agg(json_build_object('last4', right(e164, 4), 'status', status, 'in', inbound_enabled, 'out', outbound_enabled,
     'deployment', provider_deployment_id) order by e164) from public.phone_numbers where status <> 'released'),
  'campaigns', (select count(*) from public.campaigns),
  'call_logs_with_new_values', (select count(*) from public.call_logs where idempotency_key is not null or billing_cap_minutes is not null)
) r;
rollback;
```

Expected: history `["20261119090000","20261120090000"]`; `m1_columns 4`, `m2_columns 5`; `new_indexes 6`, `invalid_indexes 0`; `old_index_gone` true; `trigger` true; grants service_role true, anon false, authenticated false; the one credential `role = inbound`, still active; agents and numbers **identical to §6** (Smile Dental `Conversatio-9c6a04cd-3334` v5, `out`/`ready`/`max` null; 0061 and …0870 outbound off, deployment unchanged); `campaigns 0`; `call_logs_with_new_values 0`. Then one inbound check: the live Smile Dental agent's context call still succeeds (`sarvam_agent_events` gets a `context` row with `status = ok` on the next real call).

### 9.3 After a rollback (read-only)

```sql
begin transaction read only;
select json_build_object(
  'history', (select json_agg(version order by version) from supabase_migrations.schema_migrations where version >= '20261119090000'),
  'leftover_columns', (select json_agg(table_name || '.' || column_name) from information_schema.columns where table_schema = 'public' and
     ((table_name = 'call_logs' and column_name in ('idempotency_key','billing_cap_minutes','billing_rate_per_minute'))
      or (table_name = 'agent_configs' and column_name in ('sarvam_outbound_max_call_seconds','sarvam_outbound_app_id','sarvam_outbound_app_version','sarvam_outbound_registered_at','sarvam_outbound_registered_by'))
      or (table_name = 'sarvam_agent_integrations' and column_name = 'role'))),
  'leftover_objects', (select count(*) from pg_proc where proname in ('admit_single_outbound_call','agent_configs_sarvam_role_guard'))
     + (select count(*) from pg_trigger where tgname = 'trg_agent_configs_sarvam_role_guard'),
  'old_index_back', exists(select 1 from pg_indexes where indexname = 'idx_sarvam_agent_integrations_one_active'),
  'active_credentials', (select count(*) from public.sarvam_agent_integrations where status = 'active'),
  'numbers', (select json_agg(json_build_object('last4', right(e164, 4), 'in', inbound_enabled, 'out', outbound_enabled, 'deployment', provider_deployment_id)) from public.phone_numbers where status <> 'released'),
  'agents', (select json_agg(json_build_object('app', sarvam_app_id, 'v', sarvam_app_version, 'ready', sarvam_outbound_ready_app_id)) from public.agent_configs)
) r;
rollback;
```

Expected: `history` null, `leftover_columns` null, `leftover_objects 0`, `old_index_back` true, `active_credentials 1` (the inbound one), numbers and agents as in §6.

## 10. Blockers

- **B1, PostgreSQL 17 not tested (blocker).** Production runs 17.6; both migrations and both rollbacks were only exercised on 18 (CI and local). Nothing in them is 18-specific to my reading (partial and unique indexes, plpgsql, `ADD COLUMN … DEFAULT`, `pg_advisory_xact_lock`, `hashtext` all exist in 17), but that is a judgement, not a test. To close: run `dual_agent_provisioning.pg.test.ts` and `outbound_call_admission.pg.test.ts` against a PostgreSQL 17 server (local embedded PostgreSQL 17, or a CI job with a `postgres:17` service). Needs your approval because it downloads PostgreSQL 17 binaries or changes CI.
- **Conditions for the execution step (not blockers, they are steps in §8):** set `lock_timeout` (production default is 0); check activity right before applying; confirm the push lists exactly the two migrations; apply before any Worker deploy; post-migration checks before GATE R3.
- **Not verifiable read-only:** whether the migration runner wraps each file in a transaction. The SQL is re-runnable, so either behaviour is recoverable.

**GO/NO-GO: NO-GO for now.** The only open item is B1, a test-coverage gap on the exact production PostgreSQL major version. Once both migration tests pass on PostgreSQL 17, the evidence above supports **GO**, with the §8 procedure.
