# GATE C4-H1 — production migration 20261122090000 (campaign retry limits)

Status: **executed 2026-11-21 (owner-approved).** Applied with
`docs/gate-c4h1-execute-20261122090000.sql` (SHA-256 `26f7284a…c09c`): result
row with `"constraints": 2` and `"existing_data_unchanged": true`; verification
`all_pass`; GATE C1 verification still `all_pass`. Worker unchanged
(`5f0a4c37`, commit `3400c98`). Until Worker `a2b7943` is deployed, these
constraints are the only protection against unsafe retry settings: do not roll
back before that deploy.

Fixes GATE C4 audit finding H1 in the database: a campaign may retry only an
unanswered attempt (`no_answer`, `busy`, `failed`), at least 15 minutes and at
most 7 days apart. The application already enforces the same limits from
commit `a2b7943` (outcome decision, launch, form); this makes a direct database
write unable to bypass them. It adds two CHECK constraints and changes no data.

## 1. The package

| File                                                                | Purpose                                  | SHA-256                                                            |
| ------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `docs/gate-c4h1-execute-20261122090000.sql`                         | Guarded apply (one transaction)          | `26f7284ab593ab1a8489d71090f86438a9d66b0b08d9f661336052f09489c09c` |
| `docs/gate-c4h1-verify-20261122090000.sql`                          | Read-only verification after apply       | `1ff40cdf4c6c462768e67d833632cf919487882f4c7621692aef0dd276a889e6` |
| `docs/gate-c4h1-rollback-20261122090000.sql`                        | Guarded rollback (one transaction)       | `2d040d8972c5d93e9ee1588a2b00a0a1a6df464a3de7db51975b845467257309` |
| `docs/gate-c4h1-verify-rollback-20261122090000.sql`                 | Read-only verification after a rollback  | `77a5ae1f470f21999ff0f569a1377f7e23387b1e63195d60d22ce47ddfd79a74` |
| `scripts/build-gate-c4h1-package.mjs`                               | Generates the execute and rollback files | `a58558b37964a926462ac87c1ea3ea286e70494ac5d02288806bb3716a73da6d` |
| `supabase/migrations/20261122090000_campaign_retry_limits.sql`      | The migration (embedded verbatim)        | `f68099a017902b47b6e2946346c5fc16880558f561cc64d94fa351a250e1bd57` |
| `docs/production-rollback-20261122090000-campaign-retry-limits.sql` | Reviewed rollback statements (embedded)  | `52189b50853c5d7fed6f00e77465a517d8cba65def1e0a58c22d6621ee3612de` |

Regenerate with `node scripts/build-gate-c4h1-package.mjs` (defaults: system
identifier `7678069749886157684`, database `postgres`, output `docs/`);
regenerating produces byte-identical files.

```powershell
Get-FileHash docs\gate-c4h1-*-20261122090000.sql -Algorithm SHA256
```

## 2. What the execute file does

Runs through the Supabase query channel as **one transaction** (as GATE C1):
any error rolls back everything. It sets `lock_timeout = 5s` and
`statement_timeout = 60s` for itself only. `ADD CONSTRAINT` takes an ACCESS
EXCLUSIVE lock on `campaigns`, validates every row, and releases it at commit;
with 0 campaigns this is instant.

1. **Guard**, aborting with no change:

   | Abort                                | Meaning                                                            |
   | ------------------------------------ | ------------------------------------------------------------------ |
   | `GATE_C4H1_WRONG_DATABASE`           | Not system identifier 7678069749886157684 / database `postgres`    |
   | `GATE_C4H1_UNEXPECTED_HISTORY`       | Latest migration is not 20261121090000 (also catches a second run) |
   | `GATE_C4H1_OBJECTS_ALREADY_EXIST`    | A retry constraint already exists                                  |
   | `GATE_C4H1_PRECONDITION` (engine)    | GATE C1's campaign admission function or stop setting is missing   |
   | `GATE_C4H1_PRECONDITION` (campaigns) | N campaigns are outside the limits — review them first             |

2. The migration, byte for byte.
3. History row `20261122090000` / `campaign_retry_limits` with the file text.
4. **In-transaction check**: both constraint definitions exactly, both
   validated, the recorded text's md5, and a fingerprint of `campaigns`,
   `campaign_contacts`, `phone_numbers`, `agent_configs` and
   `platform_settings` unchanged.
5. Result row `gate_c4h1_result`.

## 3. Order

1. Owner approves GATE C4-H1 in chat.
2. Check the file hashes (§1).
3. **Apply** (do not run without approval):

   ```powershell
   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c4h1-execute-20261122090000.sql
   ```

   Success: one row `gate_c4h1_result`, `"applied": "20261122090000"`,
   `"constraints": 2`, `"existing_data_unchanged": true`. Any `GATE_C4H1_*`
   error or a lock timeout: nothing changed; report and wait.

4. **Verify** (read only):

   ```powershell
   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c4h1-verify-20261122090000.sql
   ```

   Expect `"all_pass": true`. Besides the constraints it confirms the emergency
   stop is still off, no number has outbound on, no campaign is running and
   payment enforcement is unchanged.

Independent of the Worker: the deployed Worker (`3400c98`) and the next one
(`a2b7943`) both work with or without these constraints (the form already
stays within them). Deploying `a2b7943` is a separate approval.

Nothing in this gate enables campaigns, dispatch, outbound or payment
enforcement, or touches any number, agent or setting.

## 4. Rollback

Rarely needed: it only removes the two constraints (no data changes), and the
application keeps enforcing the same limits.

```powershell
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c4h1-rollback-20261122090000.sql
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c4h1-verify-rollback-20261122090000.sql
```

The rollback aborts unless 20261122090000 is the latest migration
(`GATE_C4H1_ROLLBACK_UNEXPECTED_HISTORY`), drops both constraints, deletes the
history row, and checks that history is back to 20261121090000 and data is
unchanged. Expect `gate_c4h1_rollback_result`, then `"all_pass": true`.

**Effect on the GATE C1 rollback:** the C1 rollback refuses to run unless
20261121090000 is the latest migration. After this gate, roll this back first,
then C1.

## 5. Local rehearsal (PostgreSQL 17.6, 2026-11-21)

A Supabase stand-in with every migration through 20261121090000 applied and
recorded, GATE C1's stop row, Smile Dental fixture rows and one draft campaign;
the package built for the local system identifier with the same generator
(differs from the production files only in identity). **18 / 18 passed:**

| Scenario                                         | Result                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Production-built execute file on another cluster | `GATE_C4H1_WRONG_DATABASE`; nothing changed                                                          |
| A campaign retrying `completed`                  | `GATE_C4H1_PRECONDITION: 1 campaign(s) outside the retry limits`; nothing changed                    |
| A write lock held on `campaigns`                 | Lock timeout after 5 s; everything rolled back                                                       |
| Apply                                            | Result row; history latest 20261122090000                                                            |
| Verification                                     | `all_pass`; the script changed nothing                                                               |
| After apply                                      | Inserting a campaign that retries `completed`, or waits 0 minutes, is refused by the new constraints |
| Second apply                                     | `GATE_C4H1_UNEXPECTED_HISTORY`                                                                       |
| Production-built rollback on another cluster     | `GATE_C4H1_WRONG_DATABASE`                                                                           |
| Rollback                                         | Result row; post-rollback verification `all_pass`; state equal to before apply                       |
| Second rollback                                  | `GATE_C4H1_ROLLBACK_UNEXPECTED_HISTORY`                                                              |
| Re-apply after rollback                          | Succeeds                                                                                             |

Also covered by CI: `supabase/migrations/campaign_retry_limits.pg.test.ts`
(5 tests: safe values accepted, unsafe statuses and waits refused on insert and
update, re-runnable, rollback removes exactly the two constraints).

Not rehearsed: the Supabase CLI channel itself (same single-transaction
semantics verified at GATE R2 and used for GATE C1).
