# Production deployment runbook: automated Voice AI provisioning

Written 2026-11-27. **Not executed.** Release of `feature/automated-voice-provisioning` to the
Worker `klyro` and Supabase project `eorazvlmqwunmhwviocn`, with three migrations
(`production-migration-checklist.md`). Production state below is per repository documents and session
notes; steps 1 to 4 confirm it. Findings referred to as H, M, L are in
`pre-deployment-readiness-audit.md`.

**Every step that changes production needs the owner's approval at the time.** Stop at the first
unexpected result.

Never: merge to `main`, `supabase db push`, `wrangler deploy` or `wrangler triggers deploy`, change
payment enforcement, outbound switches or environment variables, touch Smile Dental or Smile Dental 1
outside the approved tests, buy a number, or activate a campaign.

## 0. Blockers to settle before starting

| #   | Blocker                                                                                                                                                                                                                   | Needed                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `main` deploys `klyro` on every push (per `production-security-remediation-plan.md`, 2026-11-18) and is older than the live build.                                                                                        | Owner confirms the trigger in Cloudflare and holds `main` and Lovable (step 2). The hold lasts until `main` contains the released code. |
| B2  | No backup or point-in-time recovery window has been confirmed.                                                                                                                                                            | Confirm in the Supabase dashboard (step 5).                                                                                             |
| B3  | Production has not been read since these migrations were written.                                                                                                                                                         | Step 4 must match the expectations.                                                                                                     |
| B4  | Nothing has run against real Sarvam or Vobiz (H5).                                                                                                                                                                        | Supervised tests (steps 11 to 13) before any customer is onboarded; each needs approval, a spare number and real calls.                 |
| B5  | Payment eligibility for **submitting** a setup is undecided: with enforcement off (today) submission does not require payment; with it on, a paid `setup_paid` customer cannot submit without an entitlement or override. | Owner decision. Does not block deploying; do not change enforcement during the release.                                                 |

## 1. Verify branch and commit

```powershell
git fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/feature/automated-voice-provisioning:refs/remotes/origin/feature/automated-voice-provisioning
git rev-parse origin/feature/automated-voice-provisioning
git rev-list --left-right --count origin/main...origin/feature/automated-voice-provisioning
```

- Write the SHA down; it is the release. The left count must be `0` (nothing on `main` is missing
  from the release). If `main` moved, stop and re-test.
- The GitHub `Test` run for that SHA is green.

## 2. Hold the `main` deployment mechanisms

1. Cloudflare dashboard → Workers & Pages → `klyro` → Settings → Build: record the production branch
   and deploy command; disable automatic builds for the release window (or confirm the owner of every
   push path agrees to a freeze).
2. No publishing or editing in Lovable (it pushes to `main`).
3. No pull request merged to `main`.

Releasing from the feature branch leaves `main` older than production, so this hold stays after the
release until `main` is brought up to date (a separate, approved change).

## 3. Verify the production environment (read only)

```powershell
npx wrangler deployments status --name klyro
npx wrangler secret list --name klyro
npx wrangler versions list --name klyro
```

- Live version per notes: `009eea99-0e4d-4ff9-bb36-fe22dda8b6e0` (build of `b60b77f`). Record the
  **full** ID actually shown: it is the rollback target `<OLD>`.
- `CAMPAIGN_DISPATCH_ENABLED`, `KLYRO_DISPATCH_MODE` and `OUTBOUND_CALLING_DISABLED` are not listed.
  Record whether `VOICE_AGENT_OUTBOUND_ENABLED`, `OUTBOUND_PILOT_RESTRICTION` and
  `SARVAM_OUTBOUND_TEST_ALLOWLIST` exist. Change none.
- Confirm the Supabase CLI is linked to `eorazvlmqwunmhwviocn`.

## 4. Read-only compatibility checks

```powershell
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/production-readonly-checks.sql
```

Save the output outside the repository (it holds customer IDs). Continue only if:

| Field                                                                          | Required                                                                                 |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `identity.expected_system_identifier`                                          | `true`                                                                                   |
| `identity.latest_migration`                                                    | `20261203090000`                                                                         |
| `identity.recent_versions`                                                     | every file from `20261123090000` to `20261203090000`, nothing else                       |
| `switches`                                                                     | record; `billing.payment_required` unchanged from what the owner expects (off per notes) |
| `bridge_tokens.live`                                                           | `0` (otherwise they will be revoked; agree first)                                        |
| `multiple_receptionists`, `shared_agent_ids`, `deployments_on_several_numbers` | empty                                                                                    |
| `open_provisioning_jobs`                                                       | each one understood                                                                      |
| `campaigns.running_or_scheduled`                                               | `0`                                                                                      |

Review, do not "fix":

- `multiple_businesses`, `duplicate_setup_records`: left as they are by the release.
- `business_without_receptionist`: these customers are sent back to the wizard by the new build.
  Check the list with the owner, especially if it includes a protected customer.
- `live_mapping_differences`: run **no** provisioning action, agent registration or payment-triggered
  step for these customers: it can change the live deployment (M3).
- `outbound_agents`: a confirmed one keeps dialling; re-confirming a new version needs the recovery
  action (H2, see `voice-ai-provisioning-workflow.md`).
- `campaigns.with_provider_campaign` above 0: do not resume them (L1).
- `protected_fingerprints`: keep for steps 9, 10 and 14.

## 5. Backup and rollback preparation

- Supabase dashboard → Database → Backups: confirm a restorable backup or recovery window from today.
  Record it. A restore loses later writes, so it is the last resort, not the rollback plan.
- Record `<OLD>`, the release SHA and the pre-check output.
- Open the three rollback scripts and read section "Rollback" below.

## 6. Build and upload the Worker (no traffic yet)

Building and uploading changes no traffic; it can be done before the migrations to keep the window
short.

1. Clean worktree at the release SHA.
2. `bun install --frozen-lockfile`
3. `npm run build` with the live Worker's own `VITE_SUPABASE_URL` and publishable key (read from the
   live version's bindings; never printed or committed). Do **not** set `CLICKAI_DEPLOY_TARGET`.
4. Check the bundle contains the production Supabase URL and no placeholder, and the generated
   `.output/server/wrangler.json` names `klyro` with cron `* * * * *`.
5. `npx wrangler versions upload --name klyro` → record `<NEW>`.
6. Compare bindings of `<NEW>` and `<OLD>`: same names, types, plain-text value hashes and
   compatibility date (30 bindings per notes). Any difference: stop.

## 7. Migrations before the deploy

Quiet period. Follow the per-migration ticks in the checklist.

```powershell
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-outbound-execute-20261204090000.sql
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-outbound-verify-20261204090000.sql
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-outbound-execute-20261205090000.sql
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-outbound-verify-20261205090000.sql
```

Do **not** run `20261206090000` yet. From here until step 8 no bridge token can be created. Live
customers are unaffected, so a pause here is safe.

## 8. Deploy the Worker

```powershell
npx wrangler versions deploy <NEW>@100% --name klyro --yes
```

## 9. Health checks (first 15 minutes)

- `npx wrangler deployments status --name klyro`: `<NEW>` at 100%.
- `npx wrangler tail --name klyro`: no new errors; the minute tick runs; `sweep.*` succeed;
  `campaign.dispatch` `skipped: disabled`; no `provisioning_sweep:run_failed`.
- https://clickai.in loads and sign-in works.
- `POST https://clickai.in/api/public/operator/mcp` without a token returns 401 (use the host in
  `TELEPHONY_WEBHOOK_BASE_URL` if different).
- Rerun the read-only checks: `protected_fingerprints`, `numbers` and `live_mapping_differences`
  unchanged from step 4.
- Place no test call to a live customer; watch their next real calls (no new `not_admitted`,
  `credential_mismatch` or 5xx on the agent API).

## 10. Dashboard, wizard, then the guard

On an approved test account (not a protected or real customer; a new sign-up is a production write
and needs approval):

1. The dashboard and the admin provisioning list load.
2. Complete the setup wizard once. Reload: it does not open again; one business and one receptionist.
3. Open `/app/onboarding` again: the saved values are prefilled; finishing without edits changes
   nothing.

Then apply the guard, only when `<NEW>` has been at 100% for at least 30 minutes with no rollback
under consideration (browser tabs opened before the deploy still run the old wizard; a reload fixes
them):

```powershell
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-outbound-execute-20261206090000.sql
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-outbound-verify-20261206090000.sql
```

Verify: save the test account's wizard or Business page once more without error; the read-only checks
show no new duplicates.

## Provisioning checks (before any supervised call)

- Submitting an incomplete setup is refused and lists what is missing.
- A complete submission on the test tenant creates exactly one job, in a waiting state; submitting
  again joins it.
- No job appears because of a payment (watch for it; make no payment for this check).
- The admin page shows the job and its work order for the right customer ID.

Run no provisioning action on a customer listed in `live_mapping_differences` or on Smile Dental.

## 11. Inbound supervised test (approval required)

Tenant "Smile Dental 1" only if the owner approves changing it for this test; otherwise another test
tenant. Never a number ending 0061 or 0870.

1. Finish prerequisites: voice settings, a spare number, connection row, number confirmation.
2. Submit; generate the inbound credential; create a bridge token for this job; check the customer ID.
3. Build the agent from the work order; read the agent ID back before reporting it.
4. Select the credential in Sarvam, commit, submit. Expect: deployment created paused, verified,
   resumed, number active.
5. One call from your own phone: greeting, business facts, availability, a booking, call outcome.
   The booking is in this tenant only; the call is recorded as inbound.

## 12. Outbound supervised test (approval required)

1. Outbound credential; outbound agent from its work order; report, select credential, commit,
   submit. In Sarvam: 300 seconds maximum, no transfer, only the listed tools.
2. Console voice test (booking is refused there; expected).
3. `SARVAM_OUTBOUND_TEST_ALLOWLIST` limits calls to your number (an environment change: separate
   approval; confirm pilot restriction is not `off`). Campaigns stay disabled. Enable outbound on the
   test number, check wallet balance, 09:00–21:00 IST.
4. Confirm the outbound agent, then one call. Expect the outbound agent, booking only for your
   number, opt-out honoured, correct charge. "Transfer me" and "call me back" are refused; one call
   runs past 5 minutes.
5. On failure: "Withdraw outbound".

## 13. Vobiz routing verification

Read only in the consoles. Before activation: the spare number is on the Sarvam connection and in no
other deployment. After: the deployment lists exactly that number and the new agent; ClickAI's
verification is all green; Smile Dental's deployment, agent, version and number are unchanged.

## 14. Monitoring (48 hours)

- Logs: `provisioning_sweep:run_failed`, `provisioning_runs:event_write_failed`,
  `provisioning_runs:fail_write_failed`, `operator_bridge:*`, `sarvam_agent:credential_mismatch`,
  `campaign_dispatch:agent_not_outbound_ready`, agent-API 401/403 rates.
- Wizard: errors from `save_business_setup`; `BUSINESS_SETUP_EXISTS` (an old tab: ask to reload).
- Daily, with the read-only checks: open jobs and their age, live mapping differences, duplicate
  records, protected fingerprints (a real change by that customer also changes them: explain it).

## 15. Rollback

### Triggers

Live inbound calls lose business data or show new agent-API errors; any outbound call with an
unexpected agent; unexplained change of a protected fingerprint; sweep errors repeating for 10
minutes; sign-in, dashboard or wizard failing.

### Contain first

Revoke bridge tokens in the admin panel. For outbound problems use the emergency stop
(`outbound-emergency-stop-runbook.md`). A wizard problem alone may only need the guard removed (step
R1).

### Worker rollback, in this order

- **R1.** If `20261206090000` is applied: set its approval line to `ROLL BACK 20261206090000` and run
  `docs/gate-outbound-rollback-20261206090000.sql`. The old wizard cannot retry with the guard on.
- **R2.** Revoke every bridge token (the old code treats a scoped token as valid for every customer).
  This is a production write; run it as its own approved statement:

  ```sql
  update public.operator_bridge_tokens set revoked_at = now() where revoked_at is null;
  ```

- **R3.** `npx wrangler versions deploy <OLD>@100% --name klyro --yes`, then step 9's checks.

Stop here. Both remaining migrations are safe under the old code: `20261205090000` is unused, and
`20261204090000` only prevents the old code from creating tokens (the safe state). Confirm no
outbound version while the old build is live (it has no tool-credential checkpoint).

### Database rollback (only if the schema itself is the problem)

Newest first, each after R3, with approval line `ROLL BACK <version>`:

1. `docs/gate-outbound-rollback-20261206090000.sql` (R1)
2. `docs/gate-outbound-rollback-20261205090000.sql`
3. `docs/gate-outbound-rollback-20261204090000.sql` (revokes live tokens, then drops the scope)

Each refuses unless its version is the latest. The `20261204090000` rollback blocks **every read of
`organizations`** until it commits (sign-in and dashboards stall): quiet period only. `20261203090000`
has its own older rollback gate and is not part of this release.

### Recovery

- Execute script failed or timed out: nothing changed. Read the `GATE_...` message; a lock timeout or
  "existing data changed" during traffic may be retried in a quieter moment; anything else stops the
  release.
- Result unknown (connection lost): run the read-only checks; `latest_migration` says whether it
  committed. Never rerun blindly (the script refuses a second run anyway).
- Not undone by any rollback: rows saved by the new wizard, provisioning jobs, agents registered and
  Sarvam deployments created in the window. Review them by hand; delete nothing automatically.
- A customer left half set up after a rollback: the old build treats a customer with a business as
  onboarded; complete their details on the Business and Agent pages.

## Rehearsal status

Rehearsed on disposable PostgreSQL only: the three applies, verifies, refusals and rollbacks, with
the old and new wizard writes at each stage (`release_sequence.pg.test.ts`). **Not** rehearsed:
anything against production or Cloudflare, production-sized lock durations, or a real Worker rollback.
