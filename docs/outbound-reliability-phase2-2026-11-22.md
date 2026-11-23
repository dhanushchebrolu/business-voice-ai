# Outbound reliability phase 2 (F2–F5), 2026-11-22 — local only

Local worktree `claude/h3-emergency-stop`, local QA database `clickai-campaign-qa`
(127.0.0.1:55322) only. Nothing committed, pushed or deployed; no provider request.

## Done

| Finding | Change                                                                                                                                                                                                                                                                                                        | Billing semantics                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| F2      | A provider result that arrives for a call recorded as a start failure (Sarvam rejected the start with 4xx) is now kept (`provider_metadata.late_provider_report`) and flagged (`resolution_conflict`, listed in Calls → Needs review), like a late report after an operator decision. Before, it was dropped. | Unchanged: never billed automatically, outcome not rewritten |
| F4      | Audit correction: a database unique index (`idx_wallet_tx_call_usage_ref`, 2026-09-04) already allows one `call_usage` row per call. Closed its gap: a `call_usage` row must name its call (CHECK). Admin adjustments can no longer be `call_usage`.                                                          | Unchanged                                                    |
| F5      | Admin wallet adjustments carry a request id, unique in the ledger; a retry returns "already posted", a different adjustment under the same id is refused, audit written once.                                                                                                                                 | Unchanged                                                    |

Migration `20261127090000_wallet_ledger_integrity.sql`, rollback
`docs/production-rollback-20261127090000-wallet-ledger-integrity.sql`, read-only
precheck `docs/wallet-ledger-integrity-precheck.sql` (all counts 0 and the index
present, before applying in any environment).

## Approved 2026-11-22 and implemented locally (as below, except where noted)

- F2: late report kept and flagged; the campaign contact is held in
  `outcome_unknown` (no automatic retry) when the report contradicts the start
  failure, whichever lands first. Not built: an operator "bill from provider
  report" action, and an action to release a held contact (until then, an
  operator resolves it in the database; the campaign stays running).
- F3: `call_logs.billing_hold`, migration `20261128090000_call_billing_hold.sql`
  (rollback `docs/production-rollback-20261128090000-call-billing-hold.sql`,
  which refuses while any call is held). Recovery by the reconciler (Sarvam
  analytics) or the operator form in Calls → call details. The customer sees
  "Duration: Being verified" and "Charge: Pending" until billed.

### Original proposal

### F2 — billing a call Sarvam placed after rejecting its start

Today a start rejected with 400/401/403/404/422 is `failed`, finalized at ₹0, and
the number is free again. The realistic case (a 4xx while the call was placed) is
very unlikely, and no attempt id comes back, so reconciliation has nothing to
query; a later webhook is the only signal, and it is now kept and flagged.

Proposed:

1. Keep 4xx = `failed` (treating every validation error as `outcome_unknown`
   would block the number for an operator on each typo).
2. A flagged late `completed` report on a start-failure call is billed only by an
   operator action ("bill from provider report": min(ceil(duration/60), the
   admission cap) at the locked rate, through the normal finalization path, so
   once). Customer sees the call as completed with its charge after that.
3. Campaigns: a 4xx start failure does not count as a retryable attempt
   automatically (today the retry policy may redial it); it waits for operator
   review instead. Single calls never redial automatically today.

### F3 — connected call with missing or invalid duration

Today: `connected` without a usable `duration` bills 0 minutes, silently.

Proposed (no invented duration, no silent ₹0, bounded):

1. Store the fact: the webhook records `duration_unknown` on the call instead of
   writing 0.
2. Finalization does not bill such a call; it stays `finalization_state =
'needs_duration'` (not done), so its admission reservation (cap × locked rate)
   keeps blocking the wallet — the customer cannot overspend meanwhile.
3. Recovery: the reconciler reads the attempt's duration from Sarvam analytics
   (`findAttempt` already returns it) or an operator enters it; billing then runs
   once via the normal path: min(ceil(duration/60), cap) × locked rate.
4. After 7 days without a duration, the call is listed in Needs review; nothing
   is billed until a person decides.
5. Customer sees "Completed · charge pending" until billed.
   Alternative (simpler, worse for customers): bill the full admission cap and
   refund the difference later.
