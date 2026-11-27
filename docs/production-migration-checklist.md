# Production migration checklist: setup wizard and bridge token scope

Written 2026-11-27. **Nothing here has been run against production.** "Per notes" means a repository
document or the team's session notes, not a query. Release order:
`production-deployment-runbook.md`.

## Inventory

Latest applied in production, per notes: `20261203090000`; every earlier file is expected to be
recorded. Exactly three migrations are pending, in this order. The read-only checks
(`production-readonly-checks.sql`) confirm both; if an earlier version is missing, stop.

| Order | File (`supabase/migrations/`)                    | When                                        |
| ----- | ------------------------------------------------ | ------------------------------------------- |
| 1     | `20261204090000_operator_bridge_token_scope.sql` | **before** the new Worker                   |
| 2     | `20261205090000_business_setup_save.sql`         | **before** the new Worker                   |
| 3     | `20261206090000_business_setup_guard.sql`        | **after** the new Worker serves all traffic |

### 1. `20261204090000` bridge token scope

| Field                 |                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose               | A bridge token is limited to one customer, one provisioning job and one agent role.                                                                                                                                                |
| Depends on            | `20261203090000` (`operator_bridge_tokens`, `provisioning_runs`).                                                                                                                                                                  |
| Changes               | Three columns; unique index on `provisioning_runs (id, organization_id)`; composite foreign key (cascade); two checks; one-live-token index.                                                                                       |
| Existing data         | **Revokes every token without a scope** (all existing ones). No other row changes.                                                                                                                                                 |
| Locks                 | Apply: `ACCESS EXCLUSIVE` on `operator_bridge_tokens`; writes wait on `organizations` and `provisioning_runs`, reads continue. Rollback: **`ACCESS EXCLUSIVE` on all three, so every read of `organizations` waits** until commit. |
| Live code (`b60b77f`) | Customers unaffected. **Creating a bridge token fails** (`operator_bridge_tokens_scoped`): intended, because live tokens work for every customer. Issue none until the new Worker is live.                                         |
| New code without it   | Token issue and use fail.                                                                                                                                                                                                          |
| Rollback              | Revokes all live tokens, then drops everything added. Only token scope is lost. Roll the Worker back first, and revoke tokens **before** that: the older code ignores the scope.                                                   |

### 2. `20261205090000` setup save function (phase 1)

| Field               |                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Purpose             | `save_business_setup` saves the wizard in one transaction, one submission at a time per customer.       |
| Depends on          | `is_org_member`, unique `business_hours (business_id, day_of_week)` (both older); gate order after 1.   |
| Changes             | Two functions (`SECURITY INVOKER`; `authenticated` may execute, `anon` may not). No table change.       |
| Existing data       | None.                                                                                                   |
| Locks               | No table lock, applying or rolling back.                                                                |
| Live code           | **Unaffected**, including its retry after a failed save: it never calls these functions.                |
| New code without it | The setup wizard cannot save.                                                                           |
| Rollback            | Drops the two functions; saved rows stay. Not needed for a Worker rollback. Refused while 3 is applied. |

### 3. `20261206090000` one setup per customer (phase 2)

| Field               |                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose             | A signed-in browser cannot insert a second business or receptionist for a customer.                                                                            |
| Depends on          | 2 (`lock_business_setup`); the new Worker at 100% of traffic.                                                                                                  |
| Changes             | Trigger function (`SECURITY DEFINER`, not executable by clients); `BEFORE INSERT` triggers on `businesses` and `agent_configs`, for role `authenticated` only. |
| Existing data       | None. Existing duplicates stay. Server-side (`service_role`) inserts are unaffected.                                                                           |
| Locks               | Apply: writes wait on `businesses` and `agent_configs`, reads continue. Rollback: reads and writes of both wait until commit.                                  |
| Live code           | **Not compatible.** After a failed first save, its retry (and any old tab) is refused with `BUSINESS_SETUP_EXISTS`. A first save that succeeds is unaffected.  |
| New code without it | Works. Only the protection against old tabs and direct inserts is missing.                                                                                     |
| Rollback            | Drops triggers and function; safe with either code version. **Run before any Worker rollback.**                                                                |

## The compatibility problem and why there are two phases

The live wizard saves with separate inserts, stops if the business or opening hours fail, and
ignores later errors. If the guard arrived with the function (one migration, as first written):

1. A customer submits the live wizard; the business row is saved; the hours insert fails.
2. The customer presses submit again; the live wizard inserts the business again.
3. The guard refuses it. The live wizard cannot reuse the first row, so the customer cannot finish
   until the new Worker is live (the new wizard completes the saved business).

Without the guard step 2 creates a duplicate business, as it does today. So the function ships first
(harmless to the live code) and the guard last (when no live code needs direct inserts). The same
applies to a Worker rollback, which is why the guard is rolled back first. Both behaviours, and every
rollback, are reproduced in `supabase/migrations/release_sequence.pg.test.ts`.

Between steps 2 and 3, and for an old tab left open until step 3, today's behaviour remains: a retry
in the old wizard can create a duplicate. Nothing worse than now.

## Gate scripts

`docs/gate-outbound-{execute,verify,rollback}-<version>.sql`, generated by
`scripts/build-gate-outbound-package.mjs`. Do not edit them, except the approval line.

| Requirement       | How                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Exact project     | `--project-ref eorazvlmqwunmhwviocn`; script refuses any other PostgreSQL system identifier (`7678069749886157684`) or database.       |
| Migration history | Refuses unless the latest version is exactly the previous one (rollback: exactly this one).                                            |
| No duplicate run  | The same history check, plus "objects already exist".                                                                                  |
| Lock timeout      | `SET LOCAL lock_timeout = '5s'`, `statement_timeout = '60s'`.                                                                          |
| One transaction   | Refuses if run statement by statement. Any error changes nothing.                                                                      |
| Operator approval | Committed with an empty approval line; the operator types the phrase for that one run.                                                 |
| Unexpected schema | Refuses if prerequisites are missing or objects exist; checks the result before commit.                                                |
| Existing data     | Row fingerprint of 19 tables before and after; any difference rolls back. `operator_bridge_tokens` is not in it (migration 1 revokes). |
| Credentials       | None in any file; the Supabase CLI uses the operator's own linked login.                                                               |

Approval lines: `APPLY 20261204090000`, `APPLY 20261205090000`,
`APPLY 20261206090000 AFTER THE NEW WORKER SERVES ALL TRAFFIC`; rollbacks `ROLL BACK <version>`.
The third phrase is the operator's statement: no script can see which Worker is live.

Locks above were measured on PostgreSQL in the rehearsal test and are held until the script
commits.

Side effect of the command line: `supabase db query --linked` without a database password first asks
Supabase to create a temporary login role with write rights (version 2.120.0), on every run,
including the verify scripts whose headers say read only. Approve it with the migration. Do read-only
checks in the dashboard SQL editor instead.

Known limits:

- The fingerprint reads whole tables while those locks are held. Duration depends on
  production table sizes (not measured). Run in a quiet period.
- A write by live traffic to one of those tables during the run reports "existing data changed" and
  rolls back. Nothing changed: run it again.
- The verify script expects its own version to be the latest. Run it right after its apply, before
  the next migration.
- Never use `supabase db push`.

## Per migration: tick before moving on

For each of 1, 2, 3 (3 only after the Worker steps in the runbook):

- [ ] The previous version is the latest (read-only checks, `identity.latest_migration`).
- [ ] Owner approval for this version.
- [ ] Type the approval phrase into the execute script (a local, uncommitted edit).
- [ ] Run it. Result shows `"existing_data_unchanged": true`.
- [ ] Run the verify script. `"all_pass": true`.
- [ ] Restore the file: `git checkout -- docs/gate-outbound-execute-<version>.sql`.

## Verification queries

The verify scripts are the verification (read-only SQL, `all_pass`; see the side effect above). By hand, in a read-only
transaction:

```sql
-- 20261204090000: expect 3, 0
select count(*) from information_schema.columns
 where table_schema = 'public' and table_name = 'operator_bridge_tokens'
   and column_name in ('organization_id', 'run_id', 'agent_role');
select count(*) from public.operator_bridge_tokens
 where revoked_at is null and (organization_id is null or run_id is null or agent_role is null);
-- 20261205090000: expect true, true, false
select to_regprocedure('public.save_business_setup(uuid, jsonb, jsonb)') is not null,
       has_function_privilege('authenticated', 'public.save_business_setup(uuid, jsonb, jsonb)', 'execute'),
       has_function_privilege('anon', 'public.save_business_setup(uuid, jsonb, jsonb)', 'execute');
-- 20261206090000: expect 2 rows, enabled 'O'
select tgname, tgenabled from pg_trigger where tgname like 'trg\_%\_one\_per\_customer' order by 1;
```
