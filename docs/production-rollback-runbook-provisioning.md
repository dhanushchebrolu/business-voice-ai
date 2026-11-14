# Production rollback runbook: customer-specific Sarvam provisioning (commit 43b0aab)

Covers the Worker and the five migrations added by Phases 1–5:

| Order to apply | Migration (history version) | Rollback document |
|---|---|---|
| 1 | `20261114090000` agent voice & language settings | `docs/production-rollback-20261114090000-voice-language-settings.sql` |
| 2 | `20261114100000` provisioning runs + Razorpay capture + per-org connection index | `docs/production-rollback-20261114100000-provisioning-runs.sql` |
| 3 | `20261114110000` provisioning_runs agent config columns | `docs/production-rollback-20261114110000-provisioning-runs-agent-config.sql` |
| 4 | `20261114120000` provisioning_runs verification column | `docs/production-rollback-20261114120000-provisioning-runs-verification.sql` |
| 5 | `20261114130000` inbound admission, number confirmation, customer activation | `docs/production-rollback-20261114130000-inbound-admission.sql` |

Every step needs explicit approval at the time. Nothing here is run automatically.

## 0. Decide how far to roll back

Most problems only need **step 1 (Worker rollback)**. The five migrations only add
tables, nullable columns, a widened CHECK and a replacement index; the previous
Worker (`fc0b86da`, commit `f5dc374`) ignores all of them. Roll back the
migrations only when the schema itself must go (for example a re-plan).

| Symptom | Roll back |
|---|---|
| Smile Dental (or any live customer) gets no business context after the deploy, and re-verify does not fix it | Step 1 only |
| Provisioning or customer activation misbehaves | Step 1 only |
| A migration must be withdrawn | Step 1, then steps 2–6 in this exact order |

## Pre-checks (read-only)

```sql
-- Which of the five are applied (expect the ones you are about to roll back):
SELECT version FROM supabase_migrations.schema_migrations
 WHERE version LIKE '20261114%' ORDER BY version;

-- Snapshot the customer rows that must survive (record the counts):
SELECT 'organizations' t, count(*) FROM public.organizations
UNION ALL SELECT 'phone_numbers', count(*) FROM public.phone_numbers
UNION ALL SELECT 'agent_configs', count(*) FROM public.agent_configs
UNION ALL SELECT 'telephony_connections', count(*) FROM public.telephony_connections
UNION ALL SELECT 'audit_logs', count(*) FROM public.audit_logs;
```

## Step 1: Worker back to `fc0b86da` (always first)

```bash
npx wrangler versions deploy fc0b86da-7e0e-4c53-8069-f7d791661fbd@100% --name klyro
```

Verify: `npx wrangler deployments list --name klyro` shows `fc0b86da` at 100%.
Then one approved Smile Dental agent context request or test call must get
business context (the old code has no admission gate).

**Stop here unless the schema must be withdrawn.**

## Steps 2–6: migrations, strict reverse order

Run each document as one transaction with the approved production method. Each
document checks its own preconditions and aborts (writing nothing) if they fail.

| Step | Document | Refuses when | Removes |
|---|---|---|---|
| 2 | `…130000-inbound-admission.sql` | `customer_activate` runs exist | 8 `phone_numbers` columns + their CHECK, `agent_voice_language_settings.applied_sarvam_app_id`; restores the 3-value trigger CHECK; history row |
| 3 | `…120000-provisioning-runs-verification.sql` | 130000 still recorded | `provisioning_runs.verification`; history row |
| 4 | `…110000-provisioning-runs-agent-config.sql` | 120000 or 130000 still recorded, or `verification` column present | `provisioning_runs.generated_agent_config`, `agent_config_fingerprint`, `deployment_verified_at`; history row |
| 5 | `…100000-provisioning-runs.sql` | 110000/120000/130000 still recorded, or a Sarvam connection id is shared by several organizations | per-org connection index (restores the global one), `record_razorpay_capture()`; history row. **Keeps** `provisioning_runs` (its DROP is commented out). |
| 6 | `…090000-voice-language-settings.sql` | any later version still recorded, `applied_sarvam_app_id` still present, or the settings table has rows | `agent_voice_language_settings` (+ its triggers, policy, index, grants), `agent_voice_language_same_org()`; history row |

Every document also stops with `ROLLBACK_NOT_NEEDED` (changing nothing) when its
own version is not recorded as applied, so running a step twice is harmless.
Dependency checks run before that, so an out-of-order attempt is always reported
as `ROLLBACK_BLOCKED`.

After each step, run the post-rollback queries at the end of that document.

## After the full rollback

```sql
SELECT count(*) FROM supabase_migrations.schema_migrations
 WHERE version LIKE '20261114%';               -- 0
-- Re-run the snapshot query: every count must equal the pre-check snapshot.
```

## What is lost, and what is kept

- **Lost** (by design): verified mappings, number confirmations and admission
  blocks on `phone_numbers`; provisioning run reports and generated configs;
  saved voice/language settings (step 6 refuses until they are exported and
  removed deliberately).
- **Kept**: every organization, phone number, agent, connection, audit row,
  payment, call log and the `provisioning_runs` rows themselves.
- **Not affected**: Sarvam (no Sarvam call is part of any rollback step), the
  live number routing, and payment enforcement settings.

## Re-applying later

The five migrations are re-runnable in their normal order (`090000` →
`130000`); a fresh rollout then needs Smile Dental re-verified again with the
admin "Re-verify live deployment" action, the only approved verification method.
`docs/DO-NOT-RUN-smile-dental-manual-mapping-record.sql` is NOT a substitute for
it (see that file's header).

## Limitations

- Tested only on a disposable local PostgreSQL with Supabase stand-in roles,
  not on a Supabase project.
- The Worker rollback and the "previous Worker ignores the new schema" claim
  come from code review plus the read-only production audit of 2026-11-14.
- `provisioning_runs` is intentionally kept by step 5; dropping it is a separate,
  explicit decision (it holds operational history only).
