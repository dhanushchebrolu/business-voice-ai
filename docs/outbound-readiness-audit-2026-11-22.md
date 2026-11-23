# Outbound readiness audit (2026-11-22, read-only)

Scope: the code in worktree `claude/h3-emergency-stop` at `28ec433` (the
deployed outbound code, per the deploy records in
`docs/outbound-production-readiness.md`), plus the uncommitted local campaign
hardening. Production was **not** queried: production facts below come from
the 2026-11-21 read-only record and are marked "per record". Evidence comes
from reading the execution path, running the test suites, and real-PostgreSQL
race simulations on the isolated local QA database (`clickai-campaign-qa`,
127.0.0.1:55322; a throwaway organization, deleted afterwards). No provider
request was made and no call was placed.

## 1. Executive verdict

**READY WITH CONDITIONS** for supervised, allowlisted, single (non-campaign)
Sarvam calls, one at a time, inside 09:00–21:00 IST, with an operator watching.
One such call already completed and billed correctly on 2026-11-21 (73 s,
billed 2 min = 800 paise; per record).

**NOT READY** for unsupervised customer self-serve outbound, opening the
allowlist, or campaign dispatch. Section 9 lists why (one High, several Medium).

What is strong: admission is atomic (limits, wallet worst case, idempotency,
one open call per number) under the organization row lock; a provider request
is never retried automatically; an ambiguous start becomes `outcome_unknown`
and blocks the number, never redials; billing runs once per call under a lease,
is capped at the admission reservation, and failed/busy/no-answer calls are
billed 0. All of these held under the concurrency simulations (§8).

## 2. End-to-end flow (actual execution path)

```
Dashboard (PlaceCallDialog) or admin "Place call"
  │  one request key per (dialog, number); reused on retry
  ▼
createSarvamInstantOutboundCall            [server fn, requireSupabaseAuth]
  │  normalize destination (E.164), key format
  │  outboundNumberOrganizationForCaller   org from the NUMBER row; owner/admin only
  ▼
placeSarvamCallForOrganization             (customer and admin share it)
  │  checkTelephonyAccess(org, number, outbound): entitlement, lock, payment, number state
  ▼
sendSarvamInstantOutboundCall
  │  staticEligibilityBlocker: kill switch, +91 only, calling hours
  │  allowlist (SARVAM_OUTBOUND_TEST_ALLOWLIST, fails closed)
  │  number: outbound_enabled, provider sarvam, org, connection, agent
  │  webhook URL with verify_token present
  │  do-not-call (contacts.opted_out), prior relationship (no cold calls)
  │  connection and agent belong to the same org; outbound agent + confirmed version
  │  open-call pre-check (same key -> duplicate, else "unresolved call")
  ▼
admit_single_outbound_call  [SQL, service_role, org row FOR UPDATE]
  │  emergency stop row, idempotency key, calling hours (DB clock),
  │  number owned+active, max call length recorded, in-flight (15 min),
  │  hourly/daily/per-destination limits, wallet >= open worst case + this
  │  call's cap x rate, INSERT call_logs 'initiated' (locked cap + rate),
  │  unique (org, destination) open-call index -> destination_busy
  ▼
re-check calling hours + DB emergency stop (never dialled -> failed, 0 charge)
  ▼
SarvamTelephonyAdapter.createInstantOutbound -> POST .../outbounds (15 s timeout, NO retry)
  │  metadata.call_id = call_logs.id, organization_id; webhook_config.url (verify_token)
  │  2xx  -> persistStartResult: provider_call_id = attempt_id
  │  4xx (400/401/403/404/422) -> failed, finalized at 0
  │  timeout / network / 5xx / 429 -> outcome_unknown (held, never retried)
  ▼
Sarvam places the call (agent ends it at its "Max call length")
  ▼
POST /api/public/webhooks/telephony?provider=sarvam&verify_token=…
  │  verify_token (constant-time; current or previous) else 401
  │  normalize: one terminal event per attempt (connected/no_answer/busy/failed)
  │  webhook_events insert (provider, event_id=attempt_id) -> dedupe
  │  find call by provider_call_id, else by metadata.call_id (own UUID) + org check
  │  checkCallTransition; UPDATE … WHERE status NOT terminal
  │  trigger -> finalization_state 'pending'
  ▼
finalizeTerminalCall (lease) -> apply_call_billing -> debit_wallet_for_call
  │  minutes = min(ceil(duration/60), billing_cap_minutes) at locked rate
  │  ledger row wallet_transactions(call_usage, reference=call id) once
  │  apply_call_campaign_outcome (single call: opt-out -> DNC, callback -> lead)
  ▼
Customer: Calls page (status, outcome, transcript); admin: Calls + Needs review
Recovery: cron (every minute) -> sweep.call_finalization, sweep.sarvam_reconcile
  (analytics lookup by attempt_id after 15 min, up to 7 days), flagStartsWithoutAttempt
```

A second, separate dial path exists: LiveKit SIP (`startAgentOutboundCall`,
Vobiz numbers only), off unless `VOICE_AGENT_OUTBOUND_ENABLED=true` (unset per
record). Campaign calls use `admit_campaign_outbound_call` and the dispatcher,
off unless `CAMPAIGN_DISPATCH_ENABLED` (unset per record).

## 3. Files and functions per stage

| Stage                  | File : function                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dashboard              | `src/components/app/PlaceCallDialog.tsx` (request key, double-click guard); admin `src/components/admin/SarvamOutboundPanel.tsx`                                                                                                                                                                                         |
| Server entry           | `src/lib/sarvam-outbound.functions.ts` : `createSarvamInstantOutboundCall`, `getOutboundCallingStatus`                                                                                                                                                                                                                   |
| Authorization          | `src/lib/outbound-authorization.server.ts` : `outboundNumberOrganizationForCaller`, `memberRole`                                                                                                                                                                                                                         |
| Entitlement gate       | `src/lib/telephony-guard.server.ts` : `checkTelephonyAccess`; `src/lib/sarvam-admin-calls.server.ts` : `placeSarvamCallForOrganization`                                                                                                                                                                                  |
| Eligibility            | `src/lib/outbound-eligibility.server.ts` : `staticEligibilityBlocker`, `isOutboundDestinationAllowlisted`, `hasPriorRelationship`, `outboundEmergencyStopActive`; `src/lib/contact-suppression.server.ts` : `isNumberSuppressed`                                                                                         |
| Agent selection        | `src/lib/sarvam-outbound-mode.server.ts` : `outboundAgentTarget`, `outboundCallVariables`, `withoutReservedOutboundVariables`                                                                                                                                                                                            |
| Dial                   | `src/lib/sarvam-outbound-call.server.ts` : `sendSarvamInstantOutboundCall`, `recordSarvamStartFailure`, `persistStartResult`                                                                                                                                                                                             |
| Admission (SQL)        | `supabase/migrations/20261121090000_campaign_context_engine.sql` : `admit_single_outbound_call`, `admit_campaign_outbound_call`, `within_outbound_calling_hours` (first version 20261119090000)                                                                                                                          |
| Provider client        | `src/lib/telephony/sarvam-api-client.server.ts` : `sarvamRequest`, `createInstantOutbound`; `src/lib/telephony/sarvam-provider.server.ts` : `verifyWebhookSignature`, `normalizeWebhookEvent`                                                                                                                            |
| Webhook route          | `src/routes/api/public/webhooks/telephony.ts` : `handleTelephonyWebhook`; `src/lib/telephony/webhook-correlation.server.ts`                                                                                                                                                                                              |
| Event processing       | `src/lib/telephony/telephony-event-processing.server.ts` : `processTelephonyEvent`, `applyCallEvent`, `afterFinalCallEvent`                                                                                                                                                                                              |
| Transitions            | `src/lib/telephony-guard.server.ts` : `ALLOWED_TRANSITIONS`, `checkCallTransition`                                                                                                                                                                                                                                       |
| Finalization / billing | `src/lib/telephony/call-finalization.server.ts` : `finalizeTerminalCall`, `billableTerms`; SQL `20261110090000_sarvam_outbound_call_finalization.sql` (`claim_call_finalization`, `apply_call_billing`, trigger); `20261111090100_wallet_balance_ledger_cache.sql` (`debit_wallet_for_call`, balance cache, append-only) |
| Recovery               | `src/lib/jobs/handlers.server.ts` (`sweep.sarvam_reconcile`, `sweep.call_finalization`); `src/lib/sarvam-reconciliation.server.ts`; `src/lib/sarvam-call-resolution.server.ts` (operator) ; `wrangler.json` cron `* * * * *`                                                                                             |
| Records                | `src/lib/sarvam-admin-calls.server.ts` : `loadCallDetail`; `src/components/app/CallsHistory.tsx`                                                                                                                                                                                                                         |

## 4. Safeguard audit

| Safeguard                 | Where enforced                                                                                                           | Verdict                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Authentication            | `requireSupabaseAuth` on every server fn                                                                                 | OK                                                                                                                           |
| Org membership / role     | org from the number row; owner/admin via the user's own client (RLS)                                                     | OK                                                                                                                           |
| Tenant isolation          | connection and agent org == number org; admission re-checks number+agent org; webhook matches own call id + metadata org | OK                                                                                                                           |
| Caller number             | `outbound_enabled`, provider sarvam, active (admission), connection registered                                           | OK                                                                                                                           |
| Destination normalization | `normalizeCustomerPhone` before any read/write; SQL regex                                                                | OK. Local fix (uncommitted) also refuses +91 1xxx service numbers; **production still allows them** (moot while allowlisted) |
| DNC                       | `isNumberSuppressed` before admission                                                                                    | OK; not re-checked at dial (ms window, Low)                                                                                  |
| Allowlist                 | `SARVAM_OUTBOUND_TEST_ALLOWLIST`, exact E.164, fails closed, all 3 paths                                                 | OK                                                                                                                           |
| Rate limits               | admission: in-flight 3 (15 min window), 30/h, 100/day, 2/destination/day                                                 | OK; see F9                                                                                                                   |
| Calling hours             | app check + DB check at admission + re-check before dial                                                                 | OK                                                                                                                           |
| Maximum duration          | Sarvam agent "Max call length" (admin-entered copy, 60–3600 s single, 60–300 s campaign); billing capped at it           | Partial: ClickAI cannot end a call (F11)                                                                                     |
| Duplicate / idempotency   | client key reused on retry; SQL key unique per org; open-call unique index                                               | OK (simulated)                                                                                                               |
| Concurrency               | org row lock serializes admission and debits                                                                             | OK (simulated)                                                                                                               |
| Emergency stop            | env kill switch; DB row at admission and right before dial                                                               | OK for new calls; cannot stop live calls (F11)                                                                               |
| Campaign isolation        | single limits exclude campaign calls; in-flight and wallet include both; dispatcher behind `CAMPAIGN_DISPATCH_ENABLED`   | OK                                                                                                                           |
| Prior relationship        | contact / inbound call / lead / booking, same org                                                                        | OK (policy, not legal consent)                                                                                               |

## 5. Call lifecycle

```
            admitted (call_logs row)
                  │
             ┌─ initiated ──────────────┬─────────────┬──────────────┐
  re-check   │    │ POST 2xx            │ POST 4xx    │ timeout/5xx  │ no attempt id
  hours/stop │    │ (attempt_id saved)  │             │ /429         │ after N min
  fails      ▼    ▼                     ▼             ▼              ▼
          failed  initiated ── webhook ─► completed | no_answer | busy | failed
          (start_failure,            ▲                      (terminal, finalized)
           0 charge)                 │ reconcile (analytics, ≥15 min, ≤7 days)
                                     │ operator resolution
                   outcome_unknown ──┘ (operator only when no attempt id)
```

`ringing`, `answered`, `in_progress` exist in the state machine but Sarvam's
instant-outbound webhook sends only one terminal event per attempt.

| Situation                            | What happens                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Queued / initiated                   | row `initiated` with locked cap+rate; number reserved; wallet worst case reserved                                               |
| Ringing / answered                   | not reported by Sarvam (single webhook)                                                                                         |
| Completed                            | `connected` → `completed`, duration → billed min(ceil, cap)                                                                     |
| Busy / rejected / no answer / failed | terminal, duration ignored, 0 charge                                                                                            |
| Provider timeout / 5xx / 429         | `outcome_unknown`; never retried; number blocked until resolved                                                                 |
| Webhook never arrives                | with attempt id: reconciled from Sarvam analytics after 15 min (≤ 7 days); without: flagged `outcome_unknown`, operator decides |
| Webhook twice                        | dedupe on `(provider, attempt_id)`; a second application is a no-op transition; finalization lease                              |
| Out of order                         | terminal states have no outgoing transitions; `UPDATE … WHERE status NOT terminal`                                              |
| Operator first, provider later       | provider report kept as `late_provider_report`, `resolution_conflict` flagged, never applied                                    |
| Stuck forever                        | see F1 and F10                                                                                                                  |

States that can become permanently inconsistent: F1 (webhook claimed but
never applied), F2 (real call on a `start_failure` row), F10 (beyond the 7-day
reconcile window or unresolved `outcome_unknown`).

## 6. Billing and wallet integrity

- **When**: only in finalization, after a terminal status; never at start.
- **Basis**: Sarvam's reported `duration` (seconds, ceil) for `connected`
  only; per started minute (60 s increment); capped at `billing_cap_minutes`
  locked at admission; rate locked at admission (`billing_rate_per_minute`).
- **Provider cost**: `pricing_rules.provider_cost` × all started minutes (an
  estimate ClickAI configures, not Sarvam's invoice). Past the cap, ClickAI
  absorbs the cost.
- **Retries / duplicate webhooks**: cannot charge twice. Lease (one holder),
  `billing_applied_at` checkpoint, and `debit_wallet_for_call` checks for an
  existing `call_usage` row under the org lock. Simulated: 3 concurrent
  finalizers + 2 concurrent direct debits → 1 ledger row, correct amount, 5/5.
- **Failed calls**: 0 minutes, no ledger row (debit skips amount 0).
- **Concurrent overspend**: admission reserves every open/unbilled outbound
  call's worst case under the org lock. Simulated: balance for exactly one
  call, two concurrent admissions → 1 admitted, 1 `insufficient_balance`, 5/5.
  Not covered: inbound usage and admin debits (F6).
- **Refunds / adjustments**: `adjustWallet` (admin) is append-only but not
  idempotent (F5). No automatic refunds exist.
- **Balance vs ledger**: `wallet_balances` is maintained only by triggers on
  `wallet_transactions` (insert and delete); updates/truncate are blocked.
  A service-role DELETE is allowed and silently changes the balance (Low).

## 7. Webhook reliability and idempotency

- **Authentication**: a static `verify_token` in the URL query (current or
  rotation-previous, constant-time). Not a signature over the body; fails
  closed when unset (`SARVAM_WEBHOOK_AUTH_VERIFIED = false`). Token is never
  logged (redacted). Risk F7.
- **Correlation**: by `provider_call_id` (= attempt id), else by ClickAI's own
  call UUID from `metadata.call_id`, with the org in metadata matched. A
  webhook can never create an outbound row or choose an org.
- **Dedupe**: unique `(provider, event_id)`; a failed processing (error
  recorded) is re-claimed on redelivery. **Gap F1**: a processing that dies
  without recording an error (isolate killed, CPU limit) leaves a row with
  `processed_at` and `error` both null; every redelivery answers
  `ok (duplicate)`, and the reconciler/operator resolution hit the same key
  and fail with "already recorded". The call stays `initiated`, holding its
  number and wallet reservation, until someone edits the database.
- **Undocumented statuses** are rejected (400), never guessed.
- **Retry duplication**: ClickAI never retries the POST. Whether Sarvam
  redials an instant call itself (`next_action_status = retry`) is unverified
  (L1); reconciliation treats it as pending.

## 8. Tests and simulations run (this audit)

| Run                                                                      | Result                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Outbound/telephony/billing/webhook suites (61 files + 3 pg files)        | 1,317 tests: 1,262 pass, 0 fail, 55 skipped (PostgreSQL-cluster tests; no binaries on Windows; CI runs them) |
| Full suite (this worktree, earlier today)                                | 5,478: 5,101 pass, 0 fail, 377 skipped                                                                       |
| Real PG, local QA: concurrent admission, wallet for one call, 2 requests | 5/5 rounds: 1 admitted, 1 `insufficient_balance`                                                             |
| Real PG, local QA: same idempotency key twice at once                    | 5/5: 1 admitted, 1 duplicate, 1 row                                                                          |
| Real PG, local QA: 3 concurrent finalizations + 2 duplicate debits       | 5/5: 1 lease, 1 ledger row (−1,200), charge 1,200                                                            |

Throwaway org deleted afterwards (0 rows remain). No production code changed.

## 9. Findings (new in this audit unless marked)

| ID  | Sev      | Finding                                                                                                                                                                                                                                          | Effect                                                                |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| F1  | **High** | Webhook dedupe row claimed but never applied (processing killed before success/error is written) blocks redelivery, reconciliation and operator resolution forever                                                                               | Call stuck `initiated`; number and wallet reserved; manual SQL needed |
| F2  | Medium   | A real result arriving for a `start_failure` row (Sarvam answered 4xx/404/422 but placed the call) is an illegal transition and is dropped without `late_provider_report`/`resolution_conflict` (that is only recorded for operator resolutions) | A real call unbilled and invisible                                    |
| F3  | Medium   | `connected` with a missing or non-numeric `duration` is billed 0 without any flag                                                                                                                                                                | Silent revenue leak                                                   |
| F4  | Medium   | No unique index on `wallet_transactions (organization_id, reference) WHERE kind='call_usage'`; per-call idempotency rests on the lock + check in one function                                                                                    | A future write path could double-charge                               |
| F5  | Medium   | `adjustWallet` has no idempotency key, takes `kind` from the client (could be `call_usage`), takes no org lock                                                                                                                                   | Double credit/debit on double submit                                  |
| F6  | Low      | Inbound usage and admin debits are outside the outbound reservation; `debit_wallet_for_call` has no floor                                                                                                                                        | Balance can go negative                                               |
| F7  | Low-Med  | Webhook auth is a shared URL token, no body signature; a leaked token lets a forger post a result for a known attempt/call id                                                                                                                    | Wrong outcome, charge up to the cap                                   |
| F8  | Low      | `sarvam_api:error` logs the request body (secrets redacted) including the full destination number and agent variables                                                                                                                            | PII in Worker logs                                                    |
| F9  | Low      | In-flight counts calls for 15 min only, but single-call max length may be up to 3,600 s                                                                                                                                                          | More than 3 concurrent long calls (wallet still reserved)             |
| F10 | Low      | Auto-reconcile covers 15 min–7 days and only rows with an attempt id; older or id-less rows need an operator                                                                                                                                     | Long-lived reservations if Needs review is not watched                |
| F11 | Info     | No provider hang-up: emergency stop and kill switch stop only new calls; max length depends on the Sarvam setting matching the recorded value                                                                                                    | Live call cannot be cut by ClickAI                                    |
| F12 | Low      | DNC and relationship are checked before admission, not re-checked right before the dial                                                                                                                                                          | ms window                                                             |
| F13 | Info     | Production still accepts +91 toll-free/premium destinations (fix is local, uncommitted)                                                                                                                                                          | Moot while the allowlist has 1 entry                                  |
| F14 | Low      | LiveKit path uses a non-atomic `canAfford` wallet check                                                                                                                                                                                          | Only if `VOICE_AGENT_OUTBOUND_ENABLED` is ever set                    |
| L1  | Low      | (known) Sarvam's own redial of an instant call is unverified                                                                                                                                                                                     | Possible second ring                                                  |

Not reproduced: duplicate paid calls from ClickAI retries, double charges,
cross-tenant writes, uncontrolled dialling with the current configuration.

## 10. Missing tests

1. Webhook route: an existing `webhook_events` row with `processed_at` and
   `error` both null on redelivery (documents/guards F1).
2. Late `connected` webhook on a `start_failure` row: expected flag (F2).
3. `connected` with missing duration: expected review flag (F3).
4. A PG test that a second `call_usage` row for the same call cannot be
   inserted by any path (after F4).
5. `adjustWallet` double submit (after F5).
6. Single call with `sarvam_outbound_max_call_seconds` > 900 and the 15-min
   in-flight window (F9).
7. The admission-race simulations above as CI PG tests if not already present.

## 11. Minimum before the next real call

The next call is supervised and allowlisted, so none of F1–F14 blocks it,
**provided**:

1. A recovery runbook entry for F1 exists (identify the stuck
   `webhook_events` row; clear it so the reconciler can apply the result).
2. Production state is re-read with `docs/outbound-readiness-status.sql`
   (read-only): stop off, dispatch off, LiveKit off, allowlist 1 entry,
   0 unresolved/unbilled calls, the agent's confirmed version and 300 s max.
3. The Sarvam console's "Max call length" on the outbound app version equals
   the recorded `sarvam_outbound_max_call_seconds`.

Before unsupervised or customer self-serve outbound: fix F1, F2, F3, F5, add
F4's index, decide on F7 (signature or per-call token), then re-audit.
Before campaigns: the above plus the campaign gates already in
`docs/outbound-production-rollout-runbook.md`.

## 12. Controlled real-call test plan

Free refusals first (no provider request is made in T0–T3):

| #   | Test                                                                                                     | Expected                                                                        |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| T0  | Read-only status SQL                                                                                     | all checks pass                                                                 |
| T1  | Destination not on the allowlist                                                                         | refused before any write                                                        |
| T2  | Emergency stop on, then Place call                                                                       | refused (`outbound_paused`), stop off again                                     |
| T3  | Outside 09:00–21:00 IST                                                                                  | refused                                                                         |
| T4  | Paid: allowlisted number, answer, short talk, agent ends                                                 | `completed`, minutes = ceil(duration/60) ≤ 5, one ledger row, transcript stored |
| T5  | Paid: same number, do not answer (after T4's 2/day limit check: at most 2 calls per destination per day) | `no_answer` (or `busy`), 0 charge                                               |
| T6  | Double-click / retry the dialog during T4                                                                | one call row, "Already calling"                                                 |

Per paid call: worst case 5 min × 400 = 2,000 paise customer charge. Turn the
number's outbound switch off after each session; record each call id, the
attempt id, the webhook event, finalization and ledger rows.

## 13. Approval gates before any paid provider call

| Gate      | Approval needed for                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0        | Read-only production status query (step 11.2)                                                                                                                  |
| G1        | The exact destination (the single allowlist entry), time window, operator                                                                                      |
| G2        | Turning `outbound_enabled` on for one named number (the only write)                                                                                            |
| G3        | Each paid call (T4, T5), one at a time, after the previous one is final and billed                                                                             |
| G4        | Turning outbound off again and the post-run status query                                                                                                       |
| G5        | Any change to the allowlist, the emergency stop, `CAMPAIGN_DISPATCH_ENABLED`, `VOICE_AGENT_OUTBOUND_ENABLED`, wallet or pricing: separate approval each        |
| Stop rule | Any unexpected state: activate the emergency stop (`docs/outbound-emergency-stop-runbook.md`), turn the number off, investigate; no retry without new approval |
