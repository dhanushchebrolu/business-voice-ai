# ClickAI production security remediation plan

Prepared 2026-11-18. **Nothing in this plan has been executed.** Every step
marked **GATE** needs explicit approval before it runs. Evidence was gathered
read-only, as counts and key names. No secret values were read or printed.

## 1. Current state (verified 2026-11-18)

| Item                      | State                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit                    | `062017e63c0330e0f3746ff5d865e51cba778adc` on `origin/feature/provisioning-phase1` (local HEAD identical; `main` unchanged at `707ceaa`)                               |
| CI                        | GitHub Actions `Test` run #96 (id 44298211965) on `062017e`: **success**: typecheck, lint, PostgreSQL tests (no skips), full suite, build                              |
| Production Worker `klyro` | 100% on `33e17544-5b64-4060-8b2c-8e77ce5c44f4` (`09327bc`). This is the rollback target                                                                                |
| Cloudflare builds         | `klyro`: only trigger is `main` → `npx wrangler deploy`. **A push or merge to `main` deploys production.** Preview builds are off. `clickai-staging`: Git disconnected |
| Migrations                | 69 applied, latest `20261117180000`; `20261118120000` (opt-out guard) **not applied**                                                                                  |
| Payment Enforcement       | off (no `billing.payment_required` row with `enabled = true`)                                                                                                          |
| Campaign dispatch         | `CAMPAIGN_DISPATCH_ENABLED` / `KLYRO_DISPATCH_MODE` unset                                                                                                              |
| Backup tables             | none exist yet                                                                                                                                                         |

## 2. Exposure inventory (production, read-only)

| Location                              | Rows                                     | What is exposed                                                                                                                         | Covered by                                                                     |
| ------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `call_logs.provider_metadata`, Sarvam | 7 (calls ended 2026-11-12 to 2026-11-17) | caller numbers, transcript, agent variables                                                                                             | `production-cleanup-20261118-sarvam-provider-metadata.sql` (guard = 7)         |
| `call_logs.provider_metadata`, Exotel | 23 (2026-09-16 to 09-17)                 | numbers (`From`, `To`, `CallFrom`, `CallTo`, `DialWhomNumber`, `ForwardedFrom`), `RecordingUrl`, **`verify_token`**                     | `production-cleanup-20261118-exotel-vobiz-provider-metadata.sql` (guard = 198) |
| `call_logs.provider_metadata`, Vobiz  | 175 (2026-10-05 to 11-07)                | numbers, `CallerName`, `ParentAuthID`, billing fields, **`verify_token`**                                                               | same script                                                                    |
| **`webhook_events.payload`, Exotel**  | **26** (2026-09-16 to 09-17)             | the same raw form posts, including **`verify_token`**                                                                                   | `production-cleanup-20261118-webhook-events-payload.sql` (guard = 33)          |
| **`webhook_events.payload`, Sarvam**  | **7** (2026-11-12 to 11-17)              | `user_phone_number`, `agent_phone_number`, `interaction_transcript`, `final_agent_variables`, `output_agent_variables`, `recording_url` | `production-cleanup-20261118-webhook-events-payload.sql` (guard = 33)          |

**New finding (fixed locally 2026-11-18, not deployed):** `src/routes/api/public/webhooks/telephony.ts`
stores the full raw webhook (`payload: event.raw`) in `webhook_events` for
every provider. Commit `062017e` fixed `call_logs` only. Each new Sarvam call
still adds a raw transcript and phone numbers to `webhook_events`, and the
retention job does not clean this table. Nothing reads the telephony
`payload`: it is only the de-duplication record. Only platform admins can
read it (RLS policy "admins read webhook events").

## 3. Webhook credentials (names only)

| Provider | Worker secret (`klyro`)                                                                     | Provider status in production                                | Historical token variety in `call_logs`             |
| -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| Exotel   | `EXOTEL_WEBHOOK_SECRET` (also `EXOTEL_SID`, `EXOTEL_TOKEN`, `EXOTEL_API_KEY`)               | both numbers **released** (2026-10-05); last call 2026-09-17 | 2 distinct tokens (one change during 2026-09-16/17) |
| Vobiz    | `VOBIZ_WEBHOOK_VERIFY_TOKEN` (also `VOBIZ_AUTH_TOKEN`; `VOBIZ_AUTH_ID` is a plain variable) | **1 number active**; last call 2026-11-07                    | 1 distinct token across all 175 rows                |

**Are the exposed tokens still configured?** This can't be proven from
outside. Cloudflare secrets are write-only, and no local copy exists (no
`.dev.vars` or `.env` file holds these names). The Worker shows "secret
change" versions after 2026-11-07 (2026-11-10 and 2026-11-12), but Cloudflare
does not record which secret changed. Vobiz used one token for the whole of
2026-10-05 to 11-07, and nothing shows it was rotated since. **Treat both
leaked tokens as still active.** The Vobiz token also appears in the
answer/hangup URLs set in the Vobiz console.

## 4. Credential remediation (no webhook downtime)

### Exotel: retire, don't rotate

No active numbers and no traffic since 2026-09-17, so removing the secret
causes no downtime.

1. **GATE E1.** In the Exotel console, remove or disable any flow or applet URL
   that points at ClickAI. If the Exotel account is closed, skip this step.
2. **GATE E2.** `wrangler secret delete EXOTEL_WEBHOOK_SECRET --name klyro`.
   This creates and deploys a new version from the deployed code, so run it
   **after** the release in step 6. Optionally also delete `EXOTEL_TOKEN`,
   `EXOTEL_API_KEY` and `EXOTEL_SID` if Exotel is retired.
3. Verify: the Worker's Exotel adapter no longer loads (readiness check), and
   no Exotel webhook arrives.

### Vobiz: rotate with an overlap window

Today exactly one token is accepted, so a plain swap leaves a gap (seconds to
minutes) in which callbacks fail. To avoid that gap:

1. **V1 (implemented locally 2026-11-18, ships with the release).**
   `VOBIZ_WEBHOOK_VERIFY_TOKEN_PREVIOUS` is accepted only until
   `VOBIZ_WEBHOOK_VERIFY_TOKEN_PREVIOUS_EXPIRES_AT` (ISO 8601, at most 14
   days ahead; otherwise it is refused). Comparisons are constant-time, the
   Vobiz signature check is unchanged, and URLs that Klyro hands out always
   carry the current token.
2. **GATE V2.** Stage the old token as previous (with its expiry) and the
   new token as current in one version, then deploy it. Both tokens now work.
3. **GATE V3.** Update the token in the Vobiz console application URLs
   (answer/hangup) for the active number.
4. Monitor for at least 24 hours, until the `matchedToken: "previous"`
   warnings stop and no rejections appear.
5. **GATE V4.** Delete both `_PREVIOUS` secrets. The old token also stops
   working on its own at the expiry.
6. Rollback at any point before V4: put the old value back as current. It
   still works because it is the previous token.

The full sequence, the rollback and the Exotel retirement steps are in `docs/vobiz-webhook-token-rotation.md`. If V1 is not shipped, the rotation falls back to a quiet-window cutover. Vobiz has had no traffic since 2026-11-07, so the
real risk is small, but it is not zero-downtime.

`VOBIZ_AUTH_TOKEN` and `EXOTEL_TOKEN`/`EXOTEL_API_KEY` never appeared in stored
payloads. Rotating them is not required by this exposure.

## 5. Cleanup SQL review

| Script                                                                         | Guard                                                        | Backup                                                                | Verified by test                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `production-cleanup-20261118-sarvam-provider-metadata.sql` + rollback       | exactly 7 rows (matches today)                               | `call_logs_provider_metadata_backup_20261118` (RLS on, no API grants) | `provider_metadata_cleanup.pg.test.ts` (runs the files as written; aborts on a wrong count; rollback Part A restores; newer keys win) | **Timing:** once `062017e` is deployed, the hourly retention job also sanitizes Sarvam rows older than 7 days + 1 hour, **without a backup**. The oldest row (ended 2026-11-12) becomes eligible on 2026-11-19. If the job gets there first, the guard (7) aborts safely; re-count and adjust the guard, or run script 1 within the same hour as the deploy |
| 2. `production-cleanup-20261118-exotel-vobiz-provider-metadata.sql` + rollback | exactly 198 (matches today)                                  | `call_logs_provider_metadata_backup_20261118_telephony`               | same test file, 3 cases                                                                                                               | Keeps `recording_url` (from Exotel `RecordingUrl`), the same rule new calls follow                                                                                                                                                                                                                                                                          |
| 3. `production-cleanup-20261118-webhook-events-payload.sql` + rollback         | exactly 33 (26 Exotel + 7 Sarvam), re-counted before running | `webhook_events_payload_backup_20261118`                              | same test file, 4 cases (incl. replay still hits the unique key)                                                                      | Sets `payload` to `{}` (the shape new writes use) for raw Exotel/Vobiz/Sarvam rows; keys and processing state untouched. Must run **after** the `telephony.ts` fix is deployed, or new raw rows keep arriving. Leave Razorpay/WhatsApp/Instagram rows untouched                                                                                             |

Each rollback has two parts. Part A restores from the backup while keeping
any key written since (`backup || current`). Part B drops the backup:
recommended within 7 days, because the backup itself holds the numbers and
the old tokens.

## 6. Contact opt-out migration `20261118120000`

Adds `contacts_opt_out_guard` (blocks clearing or deleting an opted-out
contact), the truncate guard, and the `reverse_contact_opt_out` function
(authenticated callers only). It is additive and changes no data. Rollback:
`docs/production-rollback-20261118120000-contact-opt-out-guard.sql`.

**Pre-check (read-only), baseline taken 2026-11-18:**

```sql
SELECT max(version) FROM supabase_migrations.schema_migrations;            -- expect 20261117180000
SELECT count(*) FROM supabase_migrations.schema_migrations
 WHERE version = '20261118120000';                                         -- expect 0
SELECT count(*), count(*) FILTER (WHERE opted_out) FROM public.contacts;   -- baseline 2 / 0
SELECT count(*) FROM pg_trigger
 WHERE tgname IN ('trg_contacts_opt_out_guard','trg_contacts_opt_out_truncate_guard');  -- expect 0
SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
 AND proname IN ('contacts_opt_out_guard','contacts_opt_out_truncate_guard','reverse_contact_opt_out'); -- expect 0
```

Dry run: `npx supabase db push --linked --dry-run`. It must list exactly
`20261118120000_contact_opt_out_guard.sql`.

**Post-check (read-only):**

```sql
SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261118120000';  -- 1
SELECT tgname, tgenabled FROM pg_trigger
 WHERE tgname IN ('trg_contacts_opt_out_guard','trg_contacts_opt_out_truncate_guard');       -- 2 rows, 'O'
SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
       has_function_privilege('service_role', p.oid, 'EXECUTE') svc
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('contacts_opt_out_guard','contacts_opt_out_truncate_guard','reverse_contact_opt_out');
-- reverse_contact_opt_out: anon f, auth t, svc f; both guards: f/f/f
SELECT count(*), count(*) FILTER (WHERE opted_out) FROM public.contacts;   -- unchanged from pre-check
```

## 7. Step-by-step execution plan

Each step runs only after its gate is approved. Stop at the first failed check.

| #   | Step                                                                                                                                                                                               | Gate                            | Check / rollback                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Approve this plan; pick the release route (manual `wrangler deploy` from the tested commit, or merge to `main`, which auto-deploys through Workers Builds and syncs to Lovable)                    | **GATE 0**                      | —                                                                                                                                                          |
| 1   | **Implemented locally, uncommitted:** identifiers-only telephony `webhook_events` rows, and (V1) the time-limited Vobiz previous token. Remaining: commit and push to the feature branch; CI green | **GATE 1** (code + commit/push) | CI run on the exact SHA                                                                                                                                    |
| 2   | **Drafted:** cleanup script 3 (`webhook_events`) with a backup, rollback and pg test (passing). Remaining: review                                                                                  | **GATE 2**                      | pg test runs the SQL as written                                                                                                                            |
| 3   | Read-only re-count: 7 / 198 / 33, migration not applied, Payment Enforcement off, `klyro` on `33e17544`                                                                                            | —                               | any mismatch: stop and review                                                                                                                              |
| 4   | Apply migration `20261118120000` (dry run first)                                                                                                                                                   | **GATE 3**                      | §6 post-check; rollback SQL in `docs/`                                                                                                                     |
| 5   | Deploy the Worker from the approved SHA. Record the new version id. Keep dispatch vars unset and Payment Enforcement off                                                                           | **GATE 4**                      | `wrangler deployments status` shows 100% on the new version; error rate and logs normal; rollback `wrangler rollback 33e17544-5b64-4060-8b2c-8e77ce5c44f4` |
| 6   | Verify on the next real Sarvam call (no paid test call): `call_logs.provider_metadata` and `webhook_events.payload` hold identifiers only                                                          | —                               | key-name query only                                                                                                                                        |
| 7   | Run cleanup script 1 (Sarvam, 7). **Same hour as step 5**, before the retention job reaches 2026-11-12 rows                                                                                        | **GATE 5**                      | post-check in the script; rollback Part A                                                                                                                  |
| 8   | Run cleanup script 2 (Exotel/Vobiz, 198)                                                                                                                                                           | **GATE 6**                      | post-check; rollback Part A                                                                                                                                |
| 9   | Run cleanup script 3 (`webhook_events`, 33)                                                                                                                                                        | **GATE 7**                      | post-check; rollback Part A                                                                                                                                |
| 10  | Exotel retirement (E1, E2)                                                                                                                                                                         | **GATE 8**                      | no Exotel traffic; readiness shows Exotel unconfigured                                                                                                     |
| 11  | Vobiz rotation (V2, V3), then 24 h or more of monitoring, then V4                                                                                                                                  | **GATES 9 and 10**              | logs match the current token; rollback before V4                                                                                                           |
| 12  | Drop the three backup tables (rollback Part B), within 7 days                                                                                                                                      | **GATE 11**                     | `to_regclass(...) IS NULL`                                                                                                                                 |
| 13  | Sarvam v6 `record_call_outcome` `opted_out` field (separate, `docs/sarvam-opt-out-tool-prerequisite.md`)                                                                                           | **GATE 12**                     | its checklist                                                                                                                                              |

Never in this plan: Payment Enforcement, campaign dispatch, Smile Dental's
live agent or deployment, Vobiz number changes, paid calls without separate
approval.
