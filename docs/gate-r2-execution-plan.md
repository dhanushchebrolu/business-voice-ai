# GATE R2: production migration execution plan (prepared, NOT executed)

Prepared 2026-11-20 for review. Nothing in this plan has been run against production. The only production access while preparing it was read-only (identity, permissions, migration-history format and transaction behaviour of the query channel).

**Scope:** migrations `20261119090000` and `20261120090000`, nothing else. No deploy, no Sarvam change, no agent/number/credential/campaign change.

## 1. Database / project identity

| Check                          | Value (read-only, 2026-11-20)                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase project ref           | `eorazvlmqwunmhwviocn`, name "Klyro Ai", organization `mbgwettsmhjcdsifyczr` (CLI link: `supabase/.temp/linked-project.json`; `supabase/config.toml` `project_id`)                                |
| Database                       | `postgres`                                                                                                                                                                                        |
| PostgreSQL                     | 17.6                                                                                                                                                                                              |
| **System identifier**          | **`7678069749886157684`** (unique to this cluster; the script aborts on any other)                                                                                                                |
| Role used by the query channel | `postgres`, owner of `call_logs`, `agent_configs`, `sarvam_agent_integrations` and `supabase_migrations.schema_migrations`                                                                        |
| Fingerprint                    | latest migration `20261118120000`; Smile Dental agent `b2972814-d9a1-432a-b5bc-820c4282c34d` → `Conversatio-9c6a04cd-3334` v5; 0061 → deployment `Smile-Denta-be071be0-703e`; 1 active credential |

The command names the project explicitly as well as using the link: `--linked --project-ref eorazvlmqwunmhwviocn`.

## 2 + 3. Exact SQL for both migrations

One file, executed as one request: **[`docs/gate-r2-execute-20261119090000-20261120090000.sql`](gate-r2-execute-20261119090000-20261120090000.sql)**, SHA-256 `4c7bfe3a2d1c3a05d832003b895877b5e07ec461720cd5a76f1a2fa7768e336d`, 54,766 bytes (hardened after the final review, 2026-11-20). Contents, in order:

1. `SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s';`
2. **Guard** (`DO $guard$`, every comparison `IS DISTINCT FROM` so NULL cannot pass), aborting before any change unless: system identifier `7678069749886157684`; database `postgres`; latest migration `20261118120000`; neither target version recorded; **none of the 9 columns, 6 indexes, 5 constraints, 2 functions or the trigger exist yet**; the old credential index exists; Smile Dental is `Conversatio-9c6a04cd-3334` v5; 0061 is active, inbound on, outbound off, on `Smile-Denta-be071be0-703e`; 0 numbers with outbound on; 0 campaigns; exactly 1 active credential; Payment Enforcement explicitly `{"enabled": false}`. It then stores a fingerprint of every existing row of 13 customer-relevant tables in a transaction-local setting (no table written).
3. **Migration 20261119090000**: the exact content of `supabase/migrations/20261119090000_outbound_call_admission.sql` (SHA-256 `f7d10f0d1076f7787731ff529b1eee17a767bf707f3937bfb88334dd85ce764e`), then its history row `('20261119090000', 'outbound_call_admission', ARRAY[<file text>])`.
4. **Migration 20261120090000**: the exact content of `supabase/migrations/20261120090000_dual_agent_provisioning.sql` (SHA-256 `b32b117e2eb9187273311f10a79eb083768caf6e1f663df70b13d47d6d3e5053`), then its history row `('20261120090000', 'dual_agent_provisioning', ARRAY[<file text>])`.
5. **In-transaction check** (`DO $check$`), raising (and so undoing both migrations) unless: 9 columns, 6 valid indexes and the 5 constraints exist in `public` on their own tables; 2 functions; the trigger definition is exactly `… BEFORE INSERT OR UPDATE OF sarvam_app_id, sarvam_application_id, sarvam_outbound_app_id ON public.agent_configs …`; the old credential index is gone; the admission function is executable by `service_role` only; both history rows exist; **the 13-table fingerprint is identical** (every existing row unchanged, new columns excluded); every new column is empty on existing rows; every credential is `inbound`.
6. A one-row result, returned only if everything passed: applied versions, system identifier, database, the object counts, the trigger definition, `old_credential_index_present false`, `admission_executable_by_anon false`, `existing_data_unchanged true`, and the timeouts in force.

History rows are written the same way the Supabase CLI wrote all 70 existing ones: `statements[1]` of `20261118120000` is byte-identical to its file (MD5 `117765f6b801f5a7a398ba4ea2f63b72`, 6,507 chars).

The script is generated from the migration files by a script that asserts each file appears byte-identical twice (executed and recorded). Regenerating it from the same commit yields the same SHA-256.

## 4. Timeouts

| Setting             | Value | Scope                              |
| ------------------- | ----- | ---------------------------------- |
| `lock_timeout`      | `5s`  | `SET LOCAL`: this transaction only |
| `statement_timeout` | `60s` | `SET LOCAL`: this transaction only |

Production defaults for this role are `lock_timeout = 0` and `statement_timeout = 2min`. Verified read-only on 2026-11-20 that `SET LOCAL` takes effect in this channel and does not leak into the next request.

## 5. Stop-on-error

- The query channel (`supabase db query --linked`, Supabase Management API) runs a multi-statement request as **one transaction**. Verified 2026-11-20 against production with session-only probes: `now()` was identical across statements separated by `pg_sleep(0.3)`, and `SET LOCAL` took effect without `BEGIN`.
- An error in any statement rejects the request. Verified: a session setting made before a `1/0` error was not present afterwards. Because the script has no explicit `BEGIN`/`COMMIT`, nothing can leave an aborted transaction open: **any error, including either guard, rolls back both migrations and both history rows**.
- Rehearsed locally on PostgreSQL 17.6 with production-shaped data:
  - the production script on another cluster → `GATE_R2_WRONG_DATABASE`, nothing changed;
  - the same script built for the local cluster → both applied, timeouts 5 s / 1 min, recorded history identical to the files, Smile Dental mapping and outbound flags unchanged;
  - a second run → `GATE_R2_UNEXPECTED_HISTORY`, nothing changed;
  - a transaction holding a lock on `call_logs` → `canceling statement due to lock timeout` after about 6 s, everything rolled back.
- After any failure: run §7.1 to confirm nothing changed, fix the cause, and run the same file again.

## 5a. Final review (2026-11-20) and rehearsal of the hardened script

The first version (`a2c7ea6a…`) was reviewed statement by statement and hardened. Five issues: NULL could pass the guard (`<>`); objects created with `IF NOT EXISTS`/`OR REPLACE` were not checked absent; catalog checks were not schema-scoped; "nothing else changed" covered only a few rows; the success row did not itself show the evidence. Verified on production (read-only): an 85 KB request is still one transaction; `SET LOCAL statement_timeout` cancels a later statement; the last 13 history rows (since `20261110100000`) store the whole file as one element, the format used here.

Rehearsal on PostgreSQL 17.6, production-shaped data, fresh database per case:

| #   | Case                                 | Outcome                                                                                                    | State after                 |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | Production script on another cluster | `GATE_R2_WRONG_DATABASE`                                                                                   | unchanged                   |
| 2   | Correct run                          | applied; 9 / 6 / 5 / 2, trigger incl. `sarvam_application_id`, `existing_data_unchanged true`, 5 s / 1 min | both applied                |
| 3   | Second run                           | `GATE_R2_UNEXPECTED_HISTORY`                                                                               | unchanged                   |
| 4   | Lock held on `call_logs`             | lock timeout after 6.5 s                                                                                   | unchanged                   |
| 5   | Same-named index already exists      | `GATE_R2_OBJECTS_ALREADY_EXIST`                                                                            | unchanged                   |
| 6   | Payment Enforcement enabled          | `GATE_R2_PRECONDITION: Payment Enforcement…`                                                               | unchanged                   |
| 7   | Empty history (NULL latest)          | `GATE_R2_UNEXPECTED_HISTORY: latest is <NULL>`                                                             | unchanged                   |
| 8   | A row changed before the check       | `GATE_R2_CHECK: existing data changed`                                                                     | both migrations rolled back |
| 9   | Second migration removed             | `GATE_R2_CHECK: expected 9 new columns`                                                                    | first migration rolled back |
| 10  | 65 s statement                       | statement timeout after 61 s                                                                               | unchanged                   |

## 5b. Execution-path review (2026-11-20, read-only)

Script SHA-256 `4c7bfe3a2d1c3a05d832003b895877b5e07ec461720cd5a76f1a2fa7768e336d` on disk, in commit `bea754f` and at the remote branch head.

- **Client (`supabase@2.120.0`):** the npm launcher runs `@supabase/cli-windows-x64@2.120.0` `supabase.exe`, a Bun build of `apps/cli` (TypeScript). `db query` (`apps/cli/src/commands/db/query/query.handler.ts` at tag v2.120.0) reads the file whole (`fs.readFileString`), then sends **one** `POST /v1/projects/{ref}/database/query` with body `{"query": <file text>}`. No splitting. The HTTP client is the plain fetch client with a debug logger (`auth/http-debug.layer.ts`): **no retry and no client timeout** on that POST. A non-201 status fails the command (exit 1).
- **Preflight (before the file is read):** `--linked` mints a temporary login role through the Management API (`POST /v1/projects/{ref}/cli/login-role`) and verify-connects through the pooler, retrying up to 9 times (clearing network bans from the 3rd attempt). This is standard CLI behaviour on every `--linked` call (it also ran for every read-only check in this review). It never executes the script; a preflight failure means no POST is sent.
- **Bytes received:** a read-only probe embedding the whole script as a string literal returned the same MD5 (`2fac02372cf3891358d2bef0439d516e`) and length (54,766) on the server as the local file. The API adds nothing before the query and appends only three SQL comment lines (`-- source: …`, `-- user: …`, `-- date: …`).
- **One transaction, rollback on error:** verified on production: `now()` constant across statements (also for an 85 KB request); `SET LOCAL lock_timeout`/`statement_timeout` effective for later statements (a 1 s timeout cancelled a later `pg_sleep(3)`); an error rejects the whole request with nothing kept. The guard's fingerprint is stored with `set_config(…, true)` (transaction-local) and read by `$check$`; were they ever in different transactions, the value would be NULL and `IS DISTINCT FROM` would raise.
- **Ambiguous outcome:** if the response is lost after the server commits, the CLI does not retry. Re-running the same file is harmless: the guard refuses (`GATE_R2_UNEXPECTED_HISTORY` / `GATE_R2_OBJECTS_ALREADY_EXIST`; rehearsal case 3). A duplicate execution racing the first would wait on the first's ACCESS EXCLUSIVE locks (5 s lock timeout) or fail on the `schema_migrations` primary key, and roll back either way. After any ambiguous result, run §7.1 / §6 (read-only) before anything else.

## 6. Exact post-migration verification query

Run read-only immediately after. It is §9.2 of [`gate-r2-migration-preflight.md`](gate-r2-migration-preflight.md):

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

Expected: `history ["20261119090000","20261120090000"]`; `m1_columns 4`; `m2_columns 5`; `new_indexes 6`; `invalid_indexes 0`; `old_index_gone true`; `trigger true`; grants `service_role true`, `anon false`, `authenticated false`; credentials `[{agent b2972814…, status active, role inbound}]`; agents: `Conversatio-9c6a04cd-3334` v5 and the unmapped agent, every `out`/`ready`/`max` null; numbers: 0061 active, in true, out false, `Smile-Denta-be071be0-703e`; …0870 active, in true, out false, no deployment; `campaigns 0`; `call_logs_with_new_values 0`. Then the full GATE R3 check.

## 7. Run sheet (when approved)

1. **Identity and pre-check (read-only):** run the identity query below and §9.1 of the preflight; every value must match §1 and the preflight's expected results. Abort otherwise.
   ```sql
   begin transaction read only;
   select json_build_object('system_identifier', (select system_identifier::text from pg_control_system()),
     'database', current_database(), 'latest', (select max(version) from supabase_migrations.schema_migrations)) r;
   rollback;
   ```
2. **Verify the file:** `sha256sum docs/gate-r2-execute-20261119090000-20261120090000.sql` must print `4c7bfe3a2d1c3a05d832003b895877b5e07ec461720cd5a76f1a2fa7768e336d`.
3. **Execute once:** `npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-r2-execute-20261119090000-20261120090000.sql`. Expected output: one row `gate_r2_result` with `applied ["20261119090000","20261120090000"]`, `system_identifier 7678069749886157684`, `database postgres`, `new_columns 9`, `new_valid_indexes 6`, `new_constraints 5`, `new_functions 2`, the trigger definition above, `old_credential_index_present false`, `admission_executable_by_anon false`, `existing_data_unchanged true`, `lock_timeout 5s`, `statement_timeout 1min`. Any error: nothing was applied; go to step 1.
4. **Post-check:** run §6 and compare every value.
5. **Do not deploy** the Worker in the same step. GATE R3 (read-only) first, then the Worker under its own approval. The live Worker (`e48ff18`) keeps working with both migrations applied.

### 7.1 After a failed run (read-only)

```sql
begin transaction read only;
select json_build_object('latest', (select max(version) from supabase_migrations.schema_migrations),
  'role_column', exists(select 1 from information_schema.columns where table_name = 'sarvam_agent_integrations' and column_name = 'role'),
  'idempotency_column', exists(select 1 from information_schema.columns where table_name = 'call_logs' and column_name = 'idempotency_key'),
  'old_index', exists(select 1 from pg_indexes where indexname = 'idx_sarvam_agent_integrations_one_active')) r;
rollback;
```

Expected after a failed run: `latest 20261118120000`, `role_column false`, `idempotency_column false`, `old_index true`.

## 8. Rollback

Unchanged from the preflight §5. If needed after a successful run: dual-agent rollback first, then the admission rollback, each only after confirming the Worker is still on `e48ff18`.
