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

| #   | Item                                        | State                                                           |
| --- | ------------------------------------------- | --------------------------------------------------------------- |
| 1   | H1 retry limits (DB + app)                  | Live: migration 20261122090000, Worker since `8cae8981`         |
| 2   | H2 fail-closed allowlist                    | Live since `4d3a8a24`                                           |
| 3   | H3 emergency stop at launch/resume/pre-dial | **Deployed** `da71e765` (commit `0cd054a`)                      |
| 4   | R1 undialled contact failed after a stop    | **Deployed** `e7472488` (commit `8abac61`)                      |
| 5   | Contact lifecycle and recovery sweeps       | Audited (§3.2)                                                  |
| 6   | Duplicate call / idempotency                | Audited (§3.3)                                                  |
| 7   | Provider lifecycle and webhooks             | Audited (§3.4), provider behaviour partly unverifiable          |
| 8   | Wallet, billing, budget                     | Audited (§3.5)                                                  |
| 9   | Tenant isolation and privacy                | Audited (§3.6), production RLS checked                          |
| 10  | Authenticated dashboard walkthrough         | Admin pages verified; customer pages need a customer login (§6) |
| 11  | Configuration and operations                | Checked read-only (§5)                                          |
| 12  | Supervised first call                       | Not started (needs owner approval, §8)                          |

## 2. Findings

| ID  | Severity | Finding                                                                                                                                                                                                                                                                                                                                         | Status                               |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| H3  | High     | The database emergency stop was read only inside the admission functions. A stop set after admission still let that call reach Sarvam; launch/resume ignored it; the LiveKit path never read it.                                                                                                                                                | Fixed `0cd054a`, deployed            |
| R1  | High     | A pause, cancel, kill switch or the end of calling hours landing between admission and the dial finalized the never-started call while the contact still pointed at it, so its `failed` outcome reached a contact that was never dialled: an attempt was used and the contact became terminal `failed` (lost from the campaign) or got a retry. | Fixed `8abac61`                      |
| L1  | Low      | Sarvam can mark an instant-outbound attempt for its own retry (`next_action_status = retry`). ClickAI sends no retry setting and cannot confirm whether Sarvam redials an instant call. Reconciliation treats it as pending and never redials itself.                                                                                           | Documented limitation                |
| D1  | Low      | Admin Calls "Needs review" (and an organization filter) with no results showed "No calls yet / Calls will appear here as numbers go live", which misreads as "no calls ever" during a supervised call.                                                                                                                                          | Fixed `1464e38`, deployed `ac20dc95` |
| L2  | Low      | `releaseOrphanedCampaignClaims` returns an orphaned claim (no call row after 15 min) to `pending` even when its campaign was cancelled meanwhile. Nothing dials a cancelled campaign, so it is cosmetic.                                                                                                                                        | Documented, not changed              |

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

| When (UTC)          | Worker version                         | Commit    | CI (Test / Voice agent)                       | Rollback to                            | Result                   |
| ------------------- | -------------------------------------- | --------- | --------------------------------------------- | -------------------------------------- | ------------------------ |
| 2026-11-21 06:27:23 | `da71e765-5052-4976-967d-b1db7f8830f2` | `0cd054a` | 44874631072 / 44874631141 green               | `4d3a8a24-4ad2-4ade-8ecb-c1d6a6c8d630` | Verified                 |
| 2026-11-21 06:47:36 | `e7472488-514c-4ad6-8920-0fbecabea732` | `8abac61` | 44876687069 green (voice agent not triggered) | `da71e765-5052-4976-967d-b1db7f8830f2` | Verified                 |
| 2026-11-21 07:27:52 | `ac20dc95-5efa-47b3-b1cc-e4012f7808bc` | `1464e38` | 44879686871 green                             | `e7472488-514c-4ad6-8920-0fbecabea732` | Verified (fix seen live) |
| 2026-11-21 08:30:40 | `7ba8937d-1325-4205-bf85-c96550d07393` | `a8bb13b` | 44883771803 green                             | `ac20dc95-5efa-47b3-b1cc-e4012f7808bc` | Verified                 |
| 2026-11-21 11:12:09 | `f8737bfb-3afb-4393-a098-ea45e6b6a5bf` | `b828823` | 44897430318 green                             | `7ba8937d-1325-4205-bf85-c96550d07393` | Verified                 |
| 2026-11-21 11:58:37 | `85bf47fe-2ba4-4ef8-a124-e7d58d687f6b` | `b5311c8` | 44901049838 green                             | `f8737bfb-3afb-4393-a098-ea45e6b6a5bf` | Verified                 |
| 2026-11-21 12:31:09 | `d5512be9-5d5a-4bfa-bf31-89d5a1181574` | `30a56c5` | 44903657296 green                             | `85bf47fe-2ba4-4ef8-a124-e7d58d687f6b` | Verified                 |
| 2026-11-23 14:08:44 | `a72542d2-c894-489b-a818-7e809566b376` | `fa498dc` | 45188543353 green                             | `d5512be9-5d5a-4bfa-bf31-89d5a1181574` | Verified                 |

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

Post-deploy verification of `a72542d2` (commit
`fa498dc3f214ca346db737d0c1291982057a5360`, Worker `klyro`, after outbound
reliability migrations 20261123090000-20261128090000): 100% traffic; 28
bindings identical to `d5512be9` (names, types, plain-text value hashes; same
compatibility date; `CAMPAIGN_DISPATCH_ENABLED` absent); bundle carries the
production Supabase URL and no placeholder; the 20261128090000 verification
`all_pass` and every outbound migration's recorded text matches; every
`campaign.dispatch` job since the deploy `skipped: disabled`; 0 numbers
outbound-enabled; payment enforcement off; no new call, webhook event or
ledger row; scheduled jobs succeeded with 0 dead; campaign and call-history
pages load from the new build. Rollback not required.

Rollback (code only; no migration involved):

```powershell
# Outbound reliability Worker fa498dc (back to 30a56c5):
npx wrangler versions deploy d5512be9-5d5a-4bfa-bf31-89d5a1181574@100% --name klyro --yes
# Booking reply template only (keeps the shared prompt core):
npx wrangler versions deploy f8737bfb-3afb-4393-a098-ea45e6b6a5bf@100% --name klyro --yes
# Shared prompt core only (keeps B1, D1, R1, H3):
npx wrangler versions deploy 7ba8937d-1325-4205-bf85-c96550d07393@100% --name klyro --yes
# B1 only (keeps D1, R1 and H3):
npx wrangler versions deploy ac20dc95-5efa-47b3-b1cc-e4012f7808bc@100% --name klyro --yes
# D1 only (keeps R1 and H3):
npx wrangler versions deploy e7472488-514c-4ad6-8920-0fbecabea732@100% --name klyro --yes
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

- **Authenticated dashboard (2026-11-21, owner signed in, admin account).**
  Verified read-only in the browser:
  - Admin overview loads; Payment enforcement shows Disabled.
  - Admin **Calls** loads all 208 calls with financials; no console errors;
    every request 200. **Needs review** returns 0 calls. Its empty state
    said "No calls yet", fixed in `src/routes/admin.calls.tsx` (D1 below).
  - **Call details** of the supervised call: completed, 79 s, provider id
    and interaction id, cost ₹7 / charge ₹8, wallet debit −₹8, finalization
    done in 1 attempt, webhook processed, transcript, "Not a campaign call".
    Answered shows "—" (Sarvam's result webhook carries no answer time).
    The detail's Refresh is a database read; "Load recording from Sarvam"
    calls Sarvam and was not clicked.
  - Admin **Jobs**: scheduler on, nothing dead-lettered, every kind
    succeeding.
  - Isolation: the admin account has no customer workspace, and `/app/*`
    sends it to the public site; no customer data is shown to a non-member.

  Not verified in the browser:
  - **Admin Place Call form** (customer page `SarvamOutboundPanel`):
    opening Smile Dental's admin customer page automatically calls Sarvam
    (`getSarvamDeployments` → `getDeployment`, enabled whenever a number has
    a deployment). That is a provider request, so the page was not opened.
    Validation is covered by tests; the owner can open the page.
  - **Customer Place Call dialog, campaign dashboard, customer tenant
    isolation**: need a customer (Smile Dental member) sign-in. The dialog's
    Call button stays disabled while outbound is off, so it cannot submit.
  - Campaign draft, CSV import, launch refusal, pause/resume/cancel: need
    production writes; covered by server-function and route tests.

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

## 10. B1 — outbound calls could not book (2026-11-21)

**Observed** on the supervised call `418df5bf` (and the 2026-11-20 call): Aria
quoted free times but, asked to book, told the person to call the clinic at
…0030 (the business phone, which is the owner's test phone).

**Root cause: not a failure but a deliberate restriction.** Booking on
outbound calls was switched off in three places: the outbound template had no
`book_appointment` tool (`OUTBOUND_AGENT_TOOLS`), the agent API returned 403
for it from the outbound credential (`roleAllowsAgentApi`), and any booking
carrying an outbound `clickai_call_id` was refused
(`OUTBOUND_BOOKING_NOT_ALLOWED`). The reason (go-live doc risk 4.5): on
instant outbound, the caller id Sarvam passes to tools (`user_identifier`) is
unverified, so a booking could be written for the wrong person. The call's
tool log confirms it: only `context` and `call_outcome` ran; no
`check_availability` or booking attempt (the slots came from the on-start
context).

**Fix (code):**

- The outbound role may call `book_appointment`; callbacks, messages and
  transfer stay forbidden.
- A booking on an outbound call is made only when the tool body's
  `clickai_call_id` names this customer's own Sarvam outbound call that is
  still open (`initiated/ringing/answered/in_progress`, started < 15 min ago),
  and **only for the number ClickAI dialled** (from `call_logs`), never the
  agent-supplied phone. Otherwise: `OUTBOUND_CALL_NOT_VERIFIED` / `OUTBOUND_CALL_NOT_OPEN`
  refusals, nothing written. A name is required (`CUSTOMER_NAME_REQUIRED`).
- Everything after that is the existing booking path: availability rechecked
  inside `create_calendar_event`, one booking per call + slot (idempotency
  key), `confirmed` / `saved_calendar_sync_failed` / not booked reported
  exactly as stored. A dialled test-caller number is checked, never saved.
- The outbound template (version 3) includes `book_appointment` with
  `clickai_call_id = @clickai_call_id` and an instruction to check, offer only
  returned times, collect the name, book, and claim a booking only on
  `bookingOutcome "confirmed"`.

**Production changes this needs (each needs approval):**

1. Deploy the Worker with this commit. **Done 2026-11-21 08:30:40 UTC as `7ba8937d`** (rollback `ac20dc95`); calls cannot book until step 2.
2. Sarvam, Smile Dental's **outbound** app (`Conversatio-…` outbound, now v2):
   add the `book_appointment` HTTP tool exactly as the generated brief shows
   (admin → Provisioning → Smile Dental, the outbound tool configuration; generated by `sarvamToolConfiguration(base, "outbound")`), Bearer =
   the outbound credential; replace the outbound prompt guard with the
   template-v3 text; publish as v3.
3. Admin: register/confirm outbound readiness for v3 (sets
   `sarvam_outbound_app_version` / `sarvam_outbound_ready_version` = 3 and the
   300 s maximum).
4. Decide for test calls: the outbound credential has **no test-caller
   numbers** (…0030 is only on the inbound credential). Add …0030 to the
   outbound credential's `test_caller_numbers` if a test call must never write
   a booking; otherwise a test booking is real and must be cancelled after.
5. Fix Smile Dental's business phone and the agent's transfer number (both
   …0030): the agent gives that number as the clinic's.
6. Google Calendar for Smile Dental is `NEEDS_CALENDAR_SELECTION`: bookings
   are saved in ClickAI only until a calendar is selected.

Rollback: redeploy the previous Worker (`ac20dc95`); the outbound role then
gets 403 on booking again, whatever Sarvam sends. Remove the tool from the
Sarvam outbound app (or keep v2 mapped) to stop the agent attempting it.

## 11. Shared Sarvam prompt core (2026-11-21)

Commit `b828823`, deployed as `f8737bfb`. Both Sarvam agents' prompts are
composed from one core (`src/lib/sarvam-agent-prompt.ts`); outbound
`book_appointment` follows the customer's booking capability; outbound
template v4. Nothing in Sarvam was changed. Baseline:
`docs/sarvam-prompt-baseline-2026-11-21.md` (inbound part provisional: taken
from the v6 draft; live v5 still to be captured).

Commit `b5311c8`, deployed as `85bf47fe`: ClickAI generates the shared
`book_appointment` reply template for both agents (inbound last branch offers
a callback only with request_callback; outbound never). Provisioning for
Smile Dental: outbound template fingerprint `o5-810226e2`, prompt sha256
prefix `0d6956345b6e1c49`, reply template sha256 prefix `31850d0f9d2e065f`.
Sarvam not yet changed.

## 12. Sarvam outbound app v3 published (2026-11-21)

Commit `30a56c5` (deployed `d5512be9`) generates the shared
`check_availability` reply template; Provisioning fingerprint `o6-f2dcbcf3`.
Applied to Sarvam app `Smile-Denta-a17cec18-1c23` (console, owner signed in):

- Check Availability: reply template replaced with the generated one
  ("To book, send the chosen time exactly as shown"); the stale description
  sentence "It never books or holds a time." removed.
- `book_appointment` added: POST `/tools/book_appointment`, Bearer
  `CLICKAI_OUTBOUND_API_KEY`, fields interaction_id (Interaction ID),
  date / time / service_name / customer_name (agent, generated descriptions),
  customer_phone (User identifier), clickai_call_id (agent variable),
  require_service (fixed `true`), generated reply template.
- Instructions replaced with the generated prompt (8 sections, 30 variables
  - 7 tool references as chips).
- Text-chat test (no call): availability offered from the tool; name and
  explicit confirmation asked; booking request refused by ClickAI
  (`OUTBOUND_CALL_NOT_VERIFIED`, chat is not a ClickAI call); agent said
  "not booked". No booking written.
- Committed as **v3** (note "ClickAI outbound template v6 (o6-f2dcbcf3)…").

ClickAI still dials **v2** (`sarvam_outbound_app_version` and ready version
2): registering and confirming v3 is a separate approval. Inbound agent
unchanged (v5). Rollback: keep ClickAI on v2 (no change needed).

## Leaving the pilot: two platform settings, no per-customer steps

Customers launch their own campaigns once these are set on the Worker (variables only, no database edits):

| Variable                     | Value  | Effect                                                                                                                                                                                                         |
| ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAMPAIGN_DISPATCH_ENABLED`  | `true` | The every-minute `campaign.dispatch` job dials launched campaigns. Off: launch is refused with "Campaign calling is not switched on for the platform yet", so a campaign can never sit at `running` undialled. |
| `OUTBOUND_PILOT_RESTRICTION` | `off`  | Ends the pilot destination list for every outbound path (campaigns, single calls, the voice agent). Anything else, or unset, keeps `SARVAM_OUTBOUND_TEST_ALLOWLIST` fail-closed.                               |

There is no per-workspace approval (`organizations.campaign_dispatch_enabled` is no longer read). What still gates a customer: phone entitlement and plan, wallet funds for the maximum call length, campaign budget, an active outbound-enabled Sarvam number with a registered connection, an outbound-confirmed agent, opt-outs, calling hours (09:00–21:00 IST), per-campaign concurrency, idempotent launch, the emergency stop (`outbound.calling_paused`) and `OUTBOUND_CALLING_DISABLED`. Provisioning sets `outbound_enabled` when it activates a number; a hand-mapped number needs it set once.
