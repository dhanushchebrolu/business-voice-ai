# Production deployment runbook: automated Voice AI provisioning

Written 2026-11-27. **Not executed.** Release of `feature/automated-voice-provisioning` to the
Worker `klyro` and Supabase project `eorazvlmqwunmhwviocn`, with three migrations
(`production-migration-checklist.md`). Production state below is per repository documents and session
notes, except the Cloudflare, GitHub and backup facts read on 2026-11-27; steps 1 to 4 confirm it.
Findings referred to as H, M, L are in `pre-deployment-readiness-audit.md`.

**Every step that changes production needs the owner's approval at the time.** Stop at the first
unexpected result.

Never: merge to `main`, `supabase db push`, `wrangler deploy` or `wrangler triggers deploy`, change
payment enforcement, outbound switches or environment variables, touch Smile Dental or Smile Dental 1
outside the approved tests, buy a number, or activate a campaign. While the hex-named binding exists
(Appendix A2), never run `wrangler secret list` or `versions view` unfiltered. Never use
`supabase db query --linked` as a read-only check (step 4).

## 0. Blockers to settle before starting

| #   | Blocker                                                                                                                                                                                                                                                               | Needed                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| B1  | `main` deploys `klyro` on every push: GitHub shows a successful `Workers Builds: klyro` check on the `main` commits of 2026-11-24 and 25. `main` is unprotected and older than the live build, so any push or Lovable publish replaces the live code with older code. | Turn the automatic build off before anything else (step 2).                                                             |
| B2  | The Supabase Management API lists **no backup** and point-in-time recovery **off** (2026-11-27).                                                                                                                                                                      | A restorable backup before the first migration (step 5).                                                                |
| B3  | Production has not been read since these migrations were written.                                                                                                                                                                                                     | Step 4 must match the expectations.                                                                                     |
| B4  | Nothing has run against real Sarvam or Vobiz (H5).                                                                                                                                                                                                                    | Supervised tests (steps 11 to 13) before any customer is onboarded; each needs approval, a spare number and real calls. |
| B5  | Payment eligibility for **submitting** a setup is undecided: with enforcement off (today) submission does not require payment; with it on, a paid `setup_paid` customer cannot submit without an entitlement or override.                                             | Owner decision. Does not block deploying; do not change enforcement during the release.                                 |
| B6  | Campaign calling has been switched on since 2026-11-24 15:20 UTC and the pilot call list switched off. Running campaigns and outbound-enabled numbers have not been read since 2026-11-25.                                                                            | Read the campaigns (step 4), then switch dispatch off (Appendix A1).                                                    |
| B7  | A Worker binding is _named_ with a 48-character hex string. It was typed in during the Exotel setup and is most likely an Exotel credential (not proven).                                                                                                             | Check and revoke it in Exotel, then remove the binding before step 6 (Appendix A2).                                     |

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

Do this first: nothing in the repository can stop a push to `main` from deploying.

1. Cloudflare dashboard (the account that owns `klyro`) → Workers & Pages → `klyro` → Settings →
   Builds: record the production branch and deploy command, then disable automatic deployments (or
   disconnect the repository). It is reversible and changes no running code. Effect: pushes to
   `main`, Lovable's included, no longer update production.
2. Verify: the setting shows disabled, and `npx wrangler deployments status --name klyro` still shows
   the same version.
3. No publishing or editing in Lovable and no merge to `main` during the release.
4. Optional second barrier: protect `main` on GitHub (it has no protection on 2026-11-27).

Releasing from the feature branch leaves `main` older than production, so keep builds off until
`main` contains the released code (a separate, approved change).

## 3. Verify the production environment (read only)

```powershell
npx wrangler deployments status --name klyro
```

```powershell
npx wrangler secret list --name klyro | ForEach-Object { $_ -replace '[0-9a-fA-F]{32,}', '<hidden>' }
```

```powershell
npx wrangler versions list --name klyro
```

The filter only protects the screen: Wrangler also writes the full response to its debug log in
`~/.wrangler/logs`. `versions view` prints plain-text values (including the call allowlist): never
share its raw output.

- Live version per notes: `009eea99-0e4d-4ff9-bb36-fe22dda8b6e0` (build of `b60b77f`). Record the
  **full** ID actually shown: it is the rollback target `<OLD>`.
- Read on 2026-11-27: 30 bindings, compatibility date `2026-09-16`.
- Listed: `CAMPAIGN_DISPATCH_ENABLED` and `OUTBOUND_PILOT_RESTRICTION` (Appendix A1; values cannot be
  read back) and the plain-text `SARVAM_OUTBOUND_TEST_ALLOWLIST`.
- Not listed: `OUTBOUND_CALLING_DISABLED`, `KLYRO_DISPATCH_MODE` (no code reads it),
  `VOICE_AGENT_OUTBOUND_ENABLED`, `LOVABLE_CRON_SECRET` (the dispatch cron route then answers 500).
- `node scripts/ops/klyro-cron.mjs status` (read only) shows `["* * * * *"]`.
- Anything else different: stop. Change nothing during the release.

## 4. Read-only compatibility checks

Run `docs/production-readonly-checks.sql` in the Supabase dashboard SQL editor of project
`eorazvlmqwunmhwviocn` (not yet tried: whether the editor shows rows for a script ending in
`rollback`; if it shows none, stop rather than edit it). Do **not** use `supabase db query --linked`:
without a database password, version 2.120.0 first asks Supabase to create a temporary login role
with write rights, although the query does not use it.

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
| `campaigns.dialled_when_switch_on`, `outbound_calls_unfinished`                | `0`, or each one understood and paused before Appendix A1                                |
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

```powershell
npx -y supabase@2.120.0 backups list --project-ref eorazvlmqwunmhwviocn
```

This only reads (it creates no login role). On 2026-11-27 it listed **no backups** and point-in-time
recovery off, so there is nothing to restore from. Before the first migration, either enable backups
in the dashboard (Database → Backups; may need a plan change) and wait for one to be listed, or take a
full logical dump with `pg_dump` using the database password, store it encrypted outside the
repository (it holds customer data), and restore it once into a disposable database to prove it
works. A restore loses later writes: it is the last resort, not the rollback plan.

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

Quiet period. Follow the per-migration ticks in the checklist. Each command below also creates the
temporary login role described in step 4: include that in the approval.

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
  `campaign.dispatch` as decided in A1 (off: `skipped: disabled`; on: it runs and, with no running
  campaign, considers 0); no `provisioning_sweep:run_failed`.
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
3. The allowlist limits calls **only while `OUTBOUND_PILOT_RESTRICTION` is not `off`**, and it was set
   to `off` on 2026-11-24: any eligible contact can be dialled. Restore the restriction and set
   `SARVAM_OUTBOUND_TEST_ALLOWLIST` to your number (changes for every customer, separate approval), or
   have the owner accept testing without it. No campaign may be running. Enable outbound on the test
   number, check wallet balance, 09:00–21:00 IST.
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

- **R3.** `npx wrangler versions deploy <OLD>@100% --name klyro --yes`, then step 9's checks. A
  version carries the secrets of its time: `<OLD>` must be newer than any secret change made under
  Appendix A, or the old switch values and the removed binding come back.

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

## Appendix A: Cloudflare findings of 2026-11-27 (owner actions, not done)

Do these before step 6: a secret change creates a new version from the latest uploaded one and
deploys it, so it must not run while an undeployed upload exists. The code stays the same. Record the
new version ID each time and use the last one as `<OLD>`.

### A1. Campaign switches

`OUTBOUND_PILOT_RESTRICTION` (2026-11-24 15:19 UTC) and `CAMPAIGN_DISPATCH_ENABLED` (15:20 UTC) were
set on request to `off` and `true`, as `outbound-production-readiness.md` describes. Production ran a
dispatch tick on 2026-11-25. No later secret change appears in the version history.

- Only `true` (any case, spaces ignored) turns dispatch on. Absent or anything else is off.
- Only `off` removes the call list. Absent or anything else keeps it, failing closed.
- The switch changes no campaign: one left `running` waits and **resumes by itself** when the switch
  returns to `true` (tested). Pause a campaign in the app if it must not resume.
- It does not stop single calls, or a campaign that Sarvam paces (`with_provider_campaign`). The
  emergency stop blocks new ClickAI calls but cannot end what Sarvam has accepted.

For the release:

1. Read the campaigns (step 4). If any is running, agree with its owner and pause it.
2. Dashboard → `klyro` → Settings → Variables and Secrets → `CAMPAIGN_DISPATCH_ENABLED` → value
   `false` → Deploy. Effect: no campaign dialling; launch and resume are refused with "not switched
   on". Reversible by setting `true`.
3. Verify: a new version at 100% with the same binding names; no new campaign call afterwards.
4. Pilot restriction: leave it unless the owner wants it back. Anything but `off` also limits every
   customer's single calls to the allowlist.

Emergency stop for all outbound calls: `outbound-emergency-stop-runbook.md`.

### A2. Hex-named binding

Evidence (Cloudflare version history, read 2026-11-27): on 2026-09-16 one Wrangler login ran a series
of secret commands: **09:03:04 this binding** (version 85), 09:04:04 `EXOTEL_API_KEY`, 09:04:43
`EXOTEL_SID`, 09:05:15 an existing secret rewritten, 09:05:32 `EXOTEL_TOKEN`, 09:06:52
`EXOTEL_WEBHOOK_SECRET`. The login is the one that deploys today. The likeliest reading is an Exotel
credential typed where the name belonged. It cannot be proven here: the value cannot be read, and no
code, git commit or local setting contains the string. ClickAI has held no Exotel secret since
2026-11-18.

1. In the Exotel console, compare the account's API key and API token with the binding name (seen in
   the Cloudflare dashboard). Paste it nowhere else.
2. Revoke or regenerate every Exotel API credential. Nothing in ClickAI uses one, so nothing breaks;
   check first that no other system of yours does.
3. If it matches none of them, keep looking (the audit log for that day needs dashboard access) and do
   not rotate unrelated credentials.
4. Delete the binding in the dashboard (Settings → Variables and Secrets), not by command, which would
   put the name in shell history. Verify with the filtered list in step 3: one binding fewer.
5. Never roll back to a version older than that deletion.
6. Afterwards, delete local copies if wanted: `~/.wrangler/logs`, saved session transcripts and
   scratch files, the one PowerShell history line. Old Cloudflare versions keep the name, so revoking
   is the real fix.
7. Record the outcome in `architecture/saas-scale-plan.md` section 5.
