# Outbound calling — production readiness (controlled first-call pilot)

Started 2026-11-21. Branch `feature/provisioning-phase1`. Worker `klyro`.
Production database `eorazvlmqwunmhwviocn`. All production reads in this
document were read-only (`begin transaction read only … rollback`,
`wrangler deployments status / versions list / versions view`). No phone
number, allowlist entry or secret value appears here.

Re-run the production status at any time (read only):

```powershell
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/outbound-readiness-status.sql
```

## 1. Master checklist

| #   | Item                                        | State                                                   |
| --- | ------------------------------------------- | ------------------------------------------------------- |
| 1   | H1 retry limits (DB + app)                  | Live: migration 20261122090000, Worker since `8cae8981` |
| 2   | H2 fail-closed allowlist                    | Live since `4d3a8a24`                                   |
| 3   | H3 emergency stop at launch/resume/pre-dial | **Deployed** `da71e765` (commit `0cd054a`)              |
| 4   | R1 undialled contact failed after a stop    | **Deployed** `e7472488` (commit `8abac61`)              |
| 5   | Contact lifecycle and recovery sweeps       | Audited (§3.2)                                          |
| 6   | Duplicate call / idempotency                | Audited (§3.3)                                          |
| 7   | Provider lifecycle and webhooks             | Audited (§3.4), provider behaviour partly unverifiable  |
| 8   | Wallet, billing, budget                     | Audited (§3.5)                                          |
| 9   | Tenant isolation and privacy                | Audited (§3.6), production RLS checked                  |
| 10  | Authenticated dashboard walkthrough         | **Blocked** (§6)                                        |
| 11  | Configuration and operations                | Checked read-only (§5)                                  |
| 12  | Supervised first call                       | Not started (needs owner approval, §8)                  |

## 2. Findings

| ID  | Severity | Finding                                                                                                                                                                                                                                                                                                                                         | Status                    |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| H3  | High     | The database emergency stop was read only inside the admission functions. A stop set after admission still let that call reach Sarvam; launch/resume ignored it; the LiveKit path never read it.                                                                                                                                                | Fixed `0cd054a`, deployed |
| R1  | High     | A pause, cancel, kill switch or the end of calling hours landing between admission and the dial finalized the never-started call while the contact still pointed at it, so its `failed` outcome reached a contact that was never dialled: an attempt was used and the contact became terminal `failed` (lost from the campaign) or got a retry. | Fixed `8abac61`           |
| L1  | Low      | Sarvam can mark an instant-outbound attempt for its own retry (`next_action_status = retry`). ClickAI sends no retry setting and cannot confirm whether Sarvam redials an instant call. Reconciliation treats it as pending and never redials itself.                                                                                           | Documented limitation     |
| L2  | Low      | `releaseOrphanedCampaignClaims` returns an orphaned claim (no call row after 15 min) to `pending` even when its campaign was cancelled meanwhile. Nothing dials a cancelled campaign, so it is cosmetic.                                                                                                                                        | Documented, not changed   |

No other critical or high issue was reproducible.

## 3. Audit notes

### 3.1 H3 — emergency stop

- `outboundEmergencyStopActive` (`src/lib/outbound-eligibility.server.ts`)
  reads `platform_settings 'outbound.calling_paused'` fresh each time. Fails
  closed: a read error, or any value admission would not read as false,
  counts as stopped; no row means not stopped (same as admission).
- Checked at: `launchCampaign` (= `resumeCampaign`); dispatcher entry
  (nothing claimed); the last database read before
  `createInstantOutbound` (test asserts the order); single Sarvam calls after
  admission; LiveKit request and the agent's claim before it dials.
- Refused at pre-dial: call `initiated → failed` (`start_failure`, zero
  charge, outside the budget); contact back to its pre-claim status and
  attempt count, `current_call_id` null, no retry; then finalized, so the
  outcome never reaches the contact. The run ends for every campaign.
- It cannot end a call a provider already accepted, and a stop set in the
  milliseconds between the last check and the request leaving cannot be
  caught (it would need a lock held across the HTTP request).

### 3.2 Contact lifecycle and recovery

| State / event                         | What happens                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Claim                                 | `pending/retry_scheduled → calling`, conditional on status and the attempt count read (no double claim)        |
| Pause/cancel before claim             | Batch stops at the next contact (status re-read before every claim)                                            |
| Pause/cancel between check and claim  | Claim given back (`releaseCampaignClaim`), cancelled if the campaign was cancelled                             |
| Admission refused                     | Claim given back exactly; `budget_exhausted` pauses the campaign; `outbound_paused` ends the run               |
| Stop after admission (any kind)       | R1/H3 path above: never started, contact given back, no attempt used                                           |
| Opt-out / allowlist / country         | Allowlist: not claimed, left as is; opt-out: `opted_out`; other country: `excluded` with reason; never dialled |
| Definite provider rejection           | Call `failed`, zero charge; finalization applies `failed` (retry only if the campaign allows it, H1 limits)    |
| Ambiguous provider error              | Call and contact `outcome_unknown`; never redialled; wallet worst case stays reserved; operator resolves       |
| Accepted, webhook missing             | `sweep.sarvam_reconcile` reads the attempt from Sarvam analytics and applies only a final outcome              |
| No attempt id after 30 min            | `flagStartsWithoutAttempt` → `outcome_unknown` (call and contact)                                              |
| `calling` with no call row for 15 min | `releaseOrphanedCampaignClaims` → `pending`, attempt restored (conditional on the exact claim)                 |
| Webhook outcome                       | `apply_call_campaign_outcome` applies only while the contact still points at that call; exactly once           |

Concurrency: two dispatchers cannot claim the same contact (conditional
claim) and cannot hold two live calls for one contact
(`idx_call_logs_campaign_contact_inflight`) or one number
(`idx_call_logs_sarvam_outbound_number_reservation`). `campaign_contacts`
has an `updated_at` trigger, so the 15-minute orphan window always starts at
the claim.

### 3.3 Duplicate calls and idempotency

Every dial goes through one of three functions; nothing else calls a provider:

| Path                                  | Function                                       | Gates                                                                                                                  |
| ------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Campaign dispatch                     | `dispatchDueCampaigns`                         | `CAMPAIGN_DISPATCH_ENABLED`, kill switch, hours, DB stop, allowlist, country, DNC, admission (lock), pre-dial          |
| Customer, admin and admin-test single | `sendSarvamInstantOutboundCall`                | kill switch, country, hours, allowlist, number outbound flag, DNC, relationship, admission (idempotency key), pre-dial |
| LiveKit agent                         | `startOutboundAgentCall` + `claimOutboundCall` | `VOICE_AGENT_OUTBOUND_ENABLED`, kill switch, allowlist, DNC, relationship, DB stop, rate limits, one-job claim         |

The generic `initiateOutboundCall` server function is retired (always throws)
and Sarvam cohort upload has no caller. The call row is written before every
dial; a replayed single request returns the first call
(`idempotency_key`, unique per workspace) and the number reservation index
blocks a second live call to the same number from any path. Sarvam's
instant-outbound API takes no idempotency key: an ambiguous start is held in
`outcome_unknown` and never redialled; an operator resolves it.

### 3.4 Provider lifecycle and webhooks

- Sarvam webhooks are accepted only with the `verify_token` (constant-time,
  current or previous secret); Sarvam's own signature is unverified, so it
  fails closed without the token.
- Deduplicated by `(provider, event_id)` before any side effect; a failed
  event is retried once by claim, never twice concurrently.
- An outbound event resolves only to a ClickAI-created row (by
  `provider_call_id`, then ClickAI's own call id), and its organization must
  match; nothing creates an outbound row from a webhook.
- State changes go through `checkCallTransition` (no regression); terminal
  events write the final status once; finalization (billing, campaign
  outcome) runs under a lease and is idempotent (`billing_applied_at`,
  `campaign_applied_at`).
- Maximum duration: enforced by Sarvam's agent setting (Smile Dental's
  outbound agent: 300 s, recorded on the agent). ClickAI has no hang-up API;
  billing is capped at the recorded maximum, so an overrun costs ClickAI, not
  the customer.

### 3.5 Wallet, billing and budget

- Billing: started minutes, rounded up, capped at the minutes reserved at
  admission, at the price locked at admission. 30 s → 1 min, 79 s → 2 min,
  120 s → 2 min, 300 s → 5 min, anything longer → 5 min (tests in
  `call-finalization.server.test.ts`). The real supervised call of
  2026-11-20 (79 s) was billed 800 paise = 2 × 400.
- Admission runs under the customer's row lock and reserves the worst case
  of every open or unbilled outbound call (single and campaign), so two
  concurrent admissions cannot overspend the wallet or campaign budget
  (PostgreSQL tests in `campaign_context_engine.pg.test.ts`,
  `outbound_call_admission.pg.test.ts`).
- Start failures are `start_failure`: zero minutes, excluded from the budget.
- `outcome_unknown` keeps its reservation until resolved.
- Billing goes through `apply_call_billing` once per call (lease +
  `billing_applied_at`); every debit is a wallet transaction.

### 3.6 Tenant isolation and privacy

- Server functions resolve the workspace from the caller's membership
  (`campaignOrganizationForCaller`, `outboundNumberOrganizationForCaller`); another
  workspace's campaign, number or call is reported exactly like a missing
  one (tests in `outbound-authorization.server.test.ts`,
  `call-context-snapshot.server.test.ts`).
- Production (read only, 2026-11-21): RLS on for `call_logs`, `campaigns`,
  `campaign_contacts`, `contacts`, `wallet_balances`, `wallet_transactions`,
  `phone_numbers`, `jobs`, `webhook_events`, pricing tables; `anon` cannot
  read any of them; customers cannot insert or update calls, campaigns'
  status, contacts' campaign state or wallets directly.
- A customer can edit `contacts`, but the `trg_contacts_opt_out_guard`
  triggers make do-not-call permanent (cannot be cleared, renumbered or
  deleted).

## 4. Deployments

| When (UTC)          | Worker version                         | Commit    | CI (Test / Voice agent)                       | Rollback to                            | Result   |
| ------------------- | -------------------------------------- | --------- | --------------------------------------------- | -------------------------------------- | -------- |
| 2026-11-21 06:27:23 | `da71e765-5052-4976-967d-b1db7f8830f2` | `0cd054a` | 44874631072 / 44874631141 green               | `4d3a8a24-4ad2-4ade-8ecb-c1d6a6c8d630` | Verified |
| 2026-11-21 06:47:36 | `e7472488-514c-4ad6-8920-0fbecabea732` | `8abac61` | 44876687069 green (voice agent not triggered) | `da71e765-5052-4976-967d-b1db7f8830f2` | Verified |

Procedure for each: clean worktree at the exact commit, `bun install
--frozen-lockfile`, `npm run build` with the live Worker's own
`VITE_SUPABASE_URL` and plain `SUPABASE_PUBLISHABLE_KEY` (read from the live
version's bindings, never printed; bundle checked for the production URL and
for no placeholder), `npx wrangler versions upload --name klyro`, binding
diff against live (names, types and plain-text value hashes), then
`npx wrangler versions deploy <id>@100% --name klyro --yes`.

Post-deploy verification of `da71e765`, repeated for `e7472488`: 100% traffic; 28 bindings identical
to `4d3a8a24`; GATE C1 and C4-H1 verifications `all_pass`; the next jobs tick
ran `sweep.call_finalization` and `campaign.dispatch` with 0 failures and no
alert; every `campaign.dispatch` job in the last hour `skipped: disabled`; no
new outbound call.

Rollback (code only; no migration involved):

```powershell
# R1 only (keeps H3):
npx wrangler versions deploy da71e765-5052-4976-967d-b1db7f8830f2@100% --name klyro --yes
# R1 and H3 (back to H2):
npx wrangler versions deploy 4d3a8a24-4ad2-4ade-8ecb-c1d6a6c8d630@100% --name klyro --yes
```

## 5. Production configuration (read only, 2026-11-21)

| Check                                   | Result                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Latest migration                        | 20261122090000                                                            |
| Emergency stop                          | `{"enabled": false}` (unchanged)                                          |
| Payment Enforcement                     | `false` (unchanged)                                                       |
| Numbers with outbound on                | 0                                                                         |
| Campaigns / campaign contacts           | 0 / 0                                                                     |
| Outbound calls ever                     | 1 (`completed`, the supervised call of 2026-11-20 13:11 UTC)              |
| Unresolved / unbilled outbound          | 0 / 0                                                                     |
| Dead jobs (24 h)                        | 0                                                                         |
| `CAMPAIGN_DISPATCH_ENABLED`             | not set → dispatch off                                                    |
| `OUTBOUND_CALLING_DISABLED`             | not set (kill switch not engaged)                                         |
| `OUTBOUND_CALLING_HOURS` / countries    | not set → 09:00–21:00 Asia/Kolkata, +91 only                              |
| `VOICE_AGENT_OUTBOUND_ENABLED`, LiveKit | not set → LiveKit outbound off                                            |
| Pilot allowlist                         | 1 entry, valid +91 E.164 (value not shown)                                |
| Smile Dental outbound agent             | outbound app v2 confirmed ready, maximum 300 s, both numbers outbound off |
| Opt-out guard triggers                  | present                                                                   |

An operator can tell a call's stage from `call_logs`: `initiated` (admitted;
`provider_call_id` set once Sarvam accepted), `ringing/answered/in_progress`,
terminal status with `resolution_source` (`start_failure` = never sent or
rejected), `outcome_unknown` (needs a decision), `finalization_state` and
`billing_applied_at` (billed). The emergency stop runbook is
`docs/outbound-emergency-stop-runbook.md` (updated for H3).

## 6. Not verified, and why

- **Authenticated dashboard walkthrough** (campaign draft, CSV import,
  launch refusal, pause/resume/cancel, history, snapshot viewer): the built-in
  browser has no signed-in session and production passwords are not entered
  by Claude; most flows also need production writes (campaigns, contacts),
  which are outside this program. Covered instead by server-function and
  route tests. To verify: the owner signs in and walks the flows on a draft
  campaign that is never launched.
- **Provider behaviour**: Sarvam's own redial of an instant call (L1), the
  exact webhook sequence for busy/no-answer, and whether Sarvam ends the call
  at the agent's maximum length can only be seen on a real call.
- **Last-milliseconds stop**: see §3.1.

## 7. Test results

Local, at `8abac61` (Windows; PostgreSQL tests cannot run here and are
counted only from CI): full suite 5,313 tests, 4,949 pass, 0 fail, 364
skipped (the PostgreSQL files); `tsc --noEmit` clean; ESLint 0 errors (21
pre-existing warnings); production build clean. CI `Test` runs every
PostgreSQL file and fails on any skip; runs in §9.

## 8. Before ONE supervised real outbound call

1. Owner approves the call: destination (already the single allowlist
   entry), time inside 09:00–21:00 IST, an operator watching Sarvam and the
   admin Calls page.
2. Turn outbound on for the one Smile Dental number used (the only
   production change needed); dispatch stays off, the allowlist unchanged.
3. Place the call from the admin "Place call" flow (single call path).
4. Watch: call row `initiated` → provider id saved → webhook → terminal →
   finalized → billed at the expected minutes; nothing else dialled.
5. Turn outbound off again on that number; re-run
   `docs/outbound-readiness-status.sql`.
6. If anything looks wrong at any point: activate the emergency stop
   (`docs/outbound-emergency-stop-runbook.md`), then investigate.

## 9. Commits and CI

| Commit    | What                                              | CI                                                 |
| --------- | ------------------------------------------------- | -------------------------------------------------- |
| `0cd054a` | H3 emergency stop                                 | Test 44874631072, Voice agent 44874631141: success |
| `8abac61` | R1 contact state after a stop; billing-unit cases | Test 44876687069: success                          |
