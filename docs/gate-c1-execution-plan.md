# GATE C1 — production migration 20261121090000 (campaign context engine)

Status: **executed 2026-11-20 (owner-approved).**

- Migration applied with `docs/gate-c1-execute-20261121090000.sql` (SHA-256
  `678a1b69…2d6e`): result row returned, existing data and policies unchanged;
  verification `all_pass` (34/34).
- Worker built from `5a519a8` and deployed as klyro
  `ecc01a98-7069-4218-a0b4-c0e7ad3a0c66` at 100% (2026-11-20 18:08:35 UTC);
  28 bindings, same set as `4832430f`; `CAMPAIGN_DISPATCH_ENABLED`,
  `KLYRO_DISPATCH_MODE`, `OUTBOUND_CALLING_DISABLED` unset. After deploy:
  `campaign.dispatch` reports `skipped: disabled` every minute, 0 calls,
  0 campaigns, stop `{"enabled": false}`, verification `all_pass`.
- Worker rollback:
  `npx wrangler versions deploy 4832430f-fdc6-4188-87e1-b5362923bdd4@100% --name klyro --yes`.
- One verification run during a dispatch job returned
  `dispatch_reports_disabled: false` (the job row was mid-run); the next run
  passed. Run it again if that check alone is false.

## 1. The package

| File                                                             | Purpose                                  | SHA-256                                                            |
| ---------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `docs/gate-c1-execute-20261121090000.sql`                        | Guarded apply (one transaction)          | `678a1b6963cc252595b32e1147a1b25f0d130c38a7b637e6bc0f045c8b4b2d6e` |
| `docs/gate-c1-verify-20261121090000.sql`                         | Read-only post-migration verification    | `f4f4daa408e36cfb593f02ed5e25feae4960ec80666cc284affeca20a777b079` |
| `docs/gate-c1-rollback-20261121090000.sql`                       | Guarded rollback (one transaction)       | `18ac117e004fb702f01793419a5949d7e3858e4abd65232fd2d735eb841168d2` |
| `docs/gate-c1-verify-rollback-20261121090000.sql`                | Read-only verification after a rollback  | `a584d0a3e8916bff82efcf380ecbb12b589ffded12118e1ac2d5ae7cd0e84514` |
| `scripts/build-gate-c1-package.mjs`                              | Generates the execute and rollback files | `4d222d5a83c435deb05adb322017a7ab12601b849d272903cac001ab380f4bb0` |
| `supabase/migrations/20261121090000_campaign_context_engine.sql` | The migration (embedded verbatim)        | `99ddb42d9e7f6de6fdf7e05d767566e6de0af5dac0d8a3e44fb839fc48b16953` |

Regenerate with `node scripts/build-gate-c1-package.mjs` (defaults: production
system identifier `7678069749886157684`, database `postgres`, output `docs/`).
The generator refuses to build if `admit_single_outbound_call` in
20261119090000 is not the version production runs (md5
`27780f3d2d6f761bb553cc5ea825ee22`), if the migration contains BEGIN/COMMIT, or
if it contains the embedding dollar tag. Regenerating changes the hashes above;
update this table if you do.

Check the files before running:

```powershell
Get-FileHash docs\gate-c1-*-20261121090000.sql -Algorithm SHA256
```

## 2. Channel and transaction

`npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <file>`
sends the file as one request, which runs as **one transaction** (verified at
GATE R2). The files therefore contain no BEGIN/COMMIT: any error anywhere —
guard, migration, history insert or in-transaction check — rolls back
everything, and production is left exactly as it was.

The execute file sets, for its transaction only:

- `SET LOCAL lock_timeout = '5s'` — production's default is 0 (wait forever).
  The migration takes ACCESS EXCLUSIVE locks on `campaigns`,
  `campaign_contacts` and `call_logs`. If live traffic holds a lock longer
  than 5 s, the statement fails, everything rolls back, and inbound calls are
  never queued behind the migration for more than 5 s.
- `SET LOCAL statement_timeout = '60s'`.

## 3. What the execute file does, in order

1. **Guard** (`DO $guard$`) — aborts, changing nothing, with one of:

   | Abort                                  | Meaning                                                                                                                                                                                                                  |
   | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `GATE_C1_WRONG_DATABASE`               | System identifier is not 7678069749886157684 or the database is not `postgres`                                                                                                                                           |
   | `GATE_C1_UNEXPECTED_HISTORY`           | Latest recorded migration is not 20261120090000                                                                                                                                                                          |
   | `GATE_C1_ALREADY_APPLIED`              | 20261121090000 is already in history                                                                                                                                                                                     |
   | `GATE_C1_OBJECTS_ALREADY_EXIST`        | Any new column, constraint, function, the trigger, or the stop setting row already exists                                                                                                                                |
   | `GATE_C1_PRECONDITION` (admission md5) | `admit_single_outbound_call` differs from 20261119090000                                                                                                                                                                 |
   | `GATE_C1_PRECONDITION` (status check)  | `campaign_contacts_status_check` text differs                                                                                                                                                                            |
   | `GATE_C1_PRECONDITION` (ACL)           | `campaigns` table privileges differ from `{postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=arwd/postgres}`                                                                                              |
   | `GATE_C1_FINGERPRINT`                  | Smile Dental agent / inbound / outbound agent rows or the 0061 number mapping differ from the preflight                                                                                                                  |
   | `GATE_C1_PRECONDITION` (state)         | A number has outbound on; any campaign or campaign contact exists; an outbound call is open or unbilled; credentials are not exactly 1 active inbound + 1 active outbound; payment enforcement is not explicitly `false` |

2. **The migration**, byte for byte.
3. **History row** in `supabase_migrations.schema_migrations`
   (`20261121090000`, `campaign_context_engine`, statements = the file text).
4. **Emergency stop row**: `platform_settings` `outbound.calling_paused` =
   `{"enabled": false}`, `is_public = false`.
5. **In-transaction check** (`DO $check$`): columns, constraints, function
   signatures (old 6-argument campaign admission absent), EXECUTE only for
   `service_role`, exact trigger definition, IST hour boundaries, stop flag /
   hours / 15-minute in-flight window / unbilled reservation in both
   admissions, `FOR SHARE` in campaign admission, column grants, table ACL,
   RLS policies unchanged (md5), stop row, history md5, a data fingerprint of
   14 tables unchanged (new columns excluded), no snapshots, no outbound
   numbers, no campaigns. Any failure raises and rolls back everything.
6. **Result row** `gate_c1_result` (applied version, identity, timeouts in force).

## 4. Order of operations

Migrate first, then deploy. Dispatch stays off throughout.

1. Owner approves GATE C1 in chat.
2. Confirm the Worker bindings (names only, no values):

   ```powershell
   npx wrangler secret list --name klyro
   ```

   `CAMPAIGN_DISPATCH_ENABLED`, `KLYRO_DISPATCH_MODE` and
   `OUTBOUND_CALLING_DISABLED` must not be listed (preflight state). Do not add
   `CAMPAIGN_DISPATCH_ENABLED` at any point in this gate.

3. Check the file hashes (§1).
4. **Apply** (the command; do not run without approval):

   ```powershell
   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c1-execute-20261121090000.sql
   ```

   - Success: one row `gate_c1_result` with `"applied": "20261121090000"`.
   - Any `GATE_C1_*` error or lock timeout: nothing changed. Do not edit the
     file and retry. Read the message, re-run the preflight, report, and wait.
     A lock timeout alone may be retried once at a quieter moment.

5. **Verify** (read only):

   ```powershell
   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c1-verify-20261121090000.sql
   ```

   Expect `"all_pass": true`. `dispatch_reports_disabled` reads the last
   `campaign.dispatch` job; it is true only once the deployed Worker has run
   the job within 10 minutes and reported `skipped: disabled`. Before the new
   Worker is deployed it may be false while everything else is true — re-run
   after step 6.

6. Deploy the Worker built from the commit containing this migration's app
   code (5bd7764 or later), with dispatch still unset. The old Worker
   (8a6e5fb) keeps working against the migrated schema in the meantime: every
   change is additive except `admit_single_outbound_call`, whose signature is
   unchanged, and outbound is off on every number.
7. Re-run the verification; all checks true.
8. Application constants not visible to SQL: `CAMPAIGN_MAX_IN_FLIGHT = 3`
   (`src/lib/campaign-dispatch.server.ts`) and `SINGLE_CALL_LIMITS.inFlight = 3`
   (`src/lib/sarvam-outbound-call.server.ts`) are the in-flight argument both
   paths pass to admission; the database counts every open outbound call of
   the customer (single and campaign) against it.

Nothing in this gate enables a campaign, outbound on a number, the cohort
dispatch mode, or payment enforcement.

## 5. Rollback runbook

Use only on an owner's instruction. Rollback is not needed to stop calling —
the emergency stop (`docs/outbound-emergency-stop-runbook.md`) does that
without a schema change.

### Preconditions (the rollback guard enforces each)

- Identity: the same cluster and database as above (`GATE_C1_WRONG_DATABASE`).
- History: latest migration is exactly 20261121090000 — nothing applied on
  top. If a later migration exists, stop: it must be rolled back first, by its
  own procedure.
- No campaign is `running`, `paused`, `scheduled` or `queued`
  (`GATE_C1_ROLLBACK_PRECONDITION: cancel or complete every campaign first`).
- No outbound call is open (initiated, ringing, answered, in_progress,
  outcome_unknown).

### Check active campaigns and calls first (read only)

```sql
begin transaction read only;
select status, count(*) from public.campaigns group by 1;
select status, campaign_id is not null as campaign, billing_applied_at is not null as billed, count(*)
  from public.call_logs where direction = 'outbound' group by 1, 2, 3;
rollback;
```

Turn on the emergency stop first, cancel or complete every campaign from the
admin UI, and resolve every `outcome_unknown` call (runbook §5) before
proceeding.

### Data loss

The rollback drops data that exists nowhere else:

- `campaigns`: description, context, context_version, context review fields,
  budget_limit;
- `campaign_contacts.excluded_reason` — and every `excluded` contact is moved
  to `cancelled` so the restored status check holds;
- `call_logs.campaign_context_snapshot` — the record of exactly what context
  each campaign call was given;
- the `outbound.calling_paused` setting row (with it, the database emergency
  stop no longer exists; the `OUTBOUND_CALLING_DISABLED` binding remains).

If any campaign, campaign contact or snapshot exists, the guard aborts with
`GATE_C1_ROLLBACK_DATA_LOSS` unless the operator uncomments, in the rollback
file, the line

```sql
-- SET LOCAL gate_c1.accept_data_loss = 'yes';
```

Do that only after exporting the affected rows if they matter:

```sql
begin transaction read only;
select id, description, context, context_version, context_reviewed_at, context_reviewed_by, budget_limit from public.campaigns;
select id, campaign_id, status, excluded_reason from public.campaign_contacts where excluded_reason is not null;
select id, campaign_id, campaign_context_snapshot from public.call_logs where campaign_context_snapshot is not null;
rollback;
```

Editing the file changes its hash; record the new hash with the approval.

### Order

1. Emergency stop on; campaigns cancelled or completed; open calls resolved.
2. Redeploy the previous Worker (8a6e5fb) **before** the rollback. The new
   app code calls the 9-argument campaign admission and reads the new columns;
   it must not run against the rolled-back schema. The old Worker works
   against both schemas.
3. Run the rollback:

   ```powershell
   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c1-rollback-20261121090000.sql
   ```

   In one transaction it restores `admit_single_outbound_call` exactly as in
   20261119090000 (service_role only), runs the reviewed rollback statements
   (`docs/production-rollback-20261121090000-campaign-context-engine.sql`),
   drops the hours helpers, deletes the stop row and the history row, then
   checks the result. Success: one row `gate_c1_rollback_result`.

4. Verify (read only):

   ```powershell
   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c1-verify-rollback-20261121090000.sql
   ```

   Expect `"all_pass": true` and `"no_outbound_number": true`.

### Manual restoration

Nothing is restored automatically. If dropped data is needed again, re-apply
GATE C1 (it succeeds after a clean rollback — rehearsed) and re-enter campaign
descriptions, context and budgets from the export. Past calls' context
snapshots can be written back from the export with a service-role UPDATE of
`call_logs.campaign_context_snapshot` (the immutability trigger only blocks
changing a snapshot that is already set); campaign `context_version` restarts
from the re-entered context, so do this only if the audit trail matters.

## 6. Local rehearsal (PostgreSQL 17.6, 2026-11-20)

A Supabase stand-in database (`gate_c1`) with every migration before
20261121090000 applied and recorded, the `campaigns` ACL set to production's
exact value, and Smile Dental fixture rows (org, agent, connection, 0061
mapping, two credentials, payment enforcement off, wallet, one billed call,
a dispatch job reporting disabled). The package was built for the local
system identifier with the same generator. **18 / 18 passed:**

| Scenario                                            | Result                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Production-built execute file on another cluster    | `GATE_C1_WRONG_DATABASE`; nothing changed                                      |
| A number with outbound on                           | Aborts (`GATE_C1_FINGERPRINT`, 0061 mapping); nothing changed                  |
| An open outbound call                               | `GATE_C1_PRECONDITION: an outbound call is open or unbilled`                   |
| A lock held on `call_logs`                          | Lock timeout after 5 s; everything rolled back                                 |
| Apply                                               | Result row; history latest 20261121090000                                      |
| Verification script                                 | `all_pass`; the script changed nothing                                         |
| Second apply                                        | `GATE_C1_UNEXPECTED_HISTORY`                                                   |
| Rollback with campaign data, data loss not accepted | `GATE_C1_ROLLBACK_DATA_LOSS`                                                   |
| Rollback with a running campaign                    | `GATE_C1_ROLLBACK_PRECONDITION`                                                |
| Production-built rollback file on another cluster   | `GATE_C1_WRONG_DATABASE`                                                       |
| Rollback                                            | Result row; post-rollback verification `all_pass`; state equal to before apply |
| Re-apply after rollback                             | Succeeds                                                                       |

Not rehearsed: the Supabase CLI channel itself (local runs used `node-postgres`
with the file as one query, the same single-transaction semantics GATE R2
verified for the CLI), and Supabase's own roles and default privileges beyond
those the fixture reproduces.
