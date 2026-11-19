# Outbound calling (single calls): how it works

Status: 2026-11-19. Covers single calls, placed by a customer from the Calls page or by a platform admin on a customer's behalf. Campaign dispatch exists in code but stays **off** (`CAMPAIGN_DISPATCH_ENABLED` is unset), and is not covered here beyond the kill switch.

Related: `docs/outbound-single-call-go-live.md` (rollout gates for Smile Dental), `docs/sarvam-one-agent-inbound-outbound.md` (agent design).

## 1. Architecture

```
Browser (Calls page dialog / admin panel)
  │  request id (idempotency key) per attempt
  ▼
Server function                       who may dial
  createSarvamInstantOutboundCall      owner/admin of the number's workspace
  placeAdminSarvamOutboundCall         platform admin (numbers.write), reason + approval, audited
  ▼
placeSarvamCallForOrganization         entitlement / account lock / payment, number active + outbound on
  ▼
sendSarvamInstantOutboundCall          the ONLY function that dials a single call
  1. canonical E.164, request-id format
  2. eligibility: kill switch, +91 only, 09:00–21:00 IST       (outbound-eligibility.server.ts)
  3. test allowlist (SARVAM_OUTBOUND_TEST_ALLOWLIST)
  4. number, connection and agent all belong to the workspace
  5. signed result-webhook URL can be built
  6. do-not-call (contacts.opted_out)
  7. prior relationship with the business
  8. agent version confirmed for outbound
  9. same request repeated while its call is open → that call, no dial
 10. admit_single_outbound_call (SQL, one transaction, customer row lock):
     idempotency, ownership, limits, wallet, reservation row
 11. Sarvam instant-outbound request
  ▼
Sarvam ── result webhook ──► /api/public/webhooks/telephony?provider=sarvam&verify_token=…
  ▼
processTelephonyEvent → status transition → finalization (billing + opt-out + lead), exactly once
```

Every rule runs server-side. The UI shows the same reasons in advance (`getOutboundCallingStatus`), but nothing depends on it.

## 2. Safety gate (every single call)

| Rule                                                                            | Where                    | Blocked message (shortened)                                     |
| ------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| Global kill switch `OUTBOUND_CALLING_DISABLED=true`                             | eligibility              | "Outbound calling is paused"                                    |
| Destination country (`OUTBOUND_ALLOWED_COUNTRY_CODES`, default `91`)            | eligibility              | "only to Indian (+91) numbers"                                  |
| Calling hours 09:00–21:00 India time (`OUTBOUND_CALLING_HOURS` can only narrow) | eligibility              | "between 9:00 AM and 9:00 PM"                                   |
| Supervised-test allowlist (`SARVAM_OUTBOUND_TEST_ALLOWLIST`)                    | dial function            | "limited to approved test numbers"                              |
| Phone feature unlocked (entitlement, account lock, payment)                     | gate                     | the feature gate's own reason                                   |
| Number active, outbound enabled, owned by the workspace                         | gate + admission         | "not assigned to this organization" / "disabled on this number" |
| Do-not-call                                                                     | dial function            | "on the do-not-call list"                                       |
| Prior relationship (contact, inbound call, lead or booking from that number)    | dial function            | "no history with your business"                                 |
| Agent version confirmed for outbound                                            | dial function            | "not been confirmed for outbound"                               |
| In-flight / hourly / daily / per-number limits, wallet                          | admission (SQL)          | see §4                                                          |
| One open call per number                                                        | admission (unique index) | "hasn't finished or has an unconfirmed outcome"                 |

Each check fails closed: a read error refuses the call. Refusals by the admission are logged as `sarvam_outbound:admission_refused` with the organization and reason, never the number.

## 3. Consent, do-not-call and the law

What ClickAI enforces (internal controls):

- **Do-not-call is permanent per workspace.** A person who opts out on any call (agent variables `opted_out` / `do_not_call`) is added to `contacts.opted_out`, by campaign finalization or, for single calls, by `suppressSingleCallOptOut`. Only an owner/admin can reverse it, with a reason, through `reverse_contact_opt_out` (audited; the database refuses any other clear).
- **No cold calls.** A single call is allowed only to a number that already dealt with the business: a saved contact, an inbound call, a lead or a booking. Adding a contact is the customer's own statement that the person expects contact; ClickAI does **not** treat it as recorded legal consent.
- **Calling hours, per-number frequency** (2 calls per number per 24 h), **Indian numbers only.**
- **Wrong number:** no lead is created, and campaign contacts are marked `wrong_number`. A single call's wrong number is not added to do-not-call (the person did not ask), but the per-number limit applies.

What is **not** resolved (needs legal counsel and the provider; nothing here is a compliance claim):

1. **TRAI TCCCPR 2018 (as amended).** Whether these calls are "commercial communication" (promotional, or service/transactional), and so whether they must come from a registered telemarketer, a designated number series, with DLT registration and consent records, instead of an ordinary 10-digit number. Answer this before any customer use beyond supervised tests.
2. **NCPR / DND scrubbing.** ClickAI has no NCPR lookup. If calls are promotional, numbers on DND must be filtered by the telemarketer or provider.
3. **DPDP Act 2023.** Phone numbers and call transcripts are personal data. A notice/consent or legitimate-use basis for each customer's contacts, and retention rules, are not defined product-wide (call variables already expire; see `call-variable-retention`).
4. **What Sarvam (as the number's provider) does on its side** for registration, scrubbing and caller ID.

Until these are answered, `SARVAM_OUTBOUND_TEST_ALLOWLIST` must stay set, so only approved test numbers can be called.

## 4. Limits and concurrency

`admit_single_outbound_call` (migration `20261119090000`) runs every check and inserts the call row in one transaction while holding the customer's `organizations` row lock, the same lock wallet debits take. Admissions for one customer are therefore serialized across all Worker instances; there are no in-memory locks.

| Limit (single calls only; campaigns never count)                                           | Value | Window                  |
| ------------------------------------------------------------------------------------------ | ----- | ----------------------- |
| Calls not final yet (`initiated`, `ringing`, `answered`, `in_progress`, `outcome_unknown`) | 3     | started in last 24 h    |
| Calls started                                                                              | 30    | last hour               |
| Calls started                                                                              | 100   | last 24 h               |
| Calls to one number                                                                        | 2     | last 24 h               |
| Open calls to one number                                                                   | 1     | any time (unique index) |

Starts that failed before dialling (`resolution_source = 'start_failure'`) do not count. Values live in `SINGLE_CALL_LIMITS` (sarvam-outbound-call.server.ts).

**Idempotency.** Each attempt carries a request id (`call_logs.idempotency_key`, unique per customer). The browser keeps it for retries of the same number and renews it after a success. A repeat returns the first call (`duplicate: true`) and never dials; a repeat of an attempt that was not placed says so; the same id for a different number is refused. Requests without an id (the admin demo test) get a server-generated one.

**Tested:** `supabase/migrations/outbound_call_admission.pg.test.ts` fires genuinely concurrent requests at real PostgreSQL (8 at a limit of 3 → 3 admitted; 6 with one id → one call; a 2-minute wallet → 2 admitted; 5 to one number → 1).

## 5. Billing rules (unchanged product contract)

- Price: `outbound_minute` customer amount (customer override, else platform rule; ₹4 today), per **started minute**: `ceil(duration_seconds / 60) × rate`. A connected 1-second call is 1 minute.
- Unanswered, busy, failed and never-placed calls have duration 0 and cost nothing.
- **Before dialling** the wallet must hold one minute for this call plus one per call still open (checked inside the admission lock, so simultaneous requests cannot all pass). This is an admission check, not a hold: no money moves until the call ends.
- **After the call** finalization debits once (`debit_wallet_for_call`: one `call_usage` row per call, unique), records one usage record, under a lease (`claim_call_finalization`), so concurrent or repeated finalization, duplicate webhooks and reconciliation can never charge twice.
- `outcome_unknown` calls are never billed until a real outcome arrives. A late webhook or reconciliation applies the real duration once.
- A connected call whose result has no duration is billed 0 (never guessed).
- **Known limit:** a call longer than the minutes covered at admission can take the wallet below zero, because Sarvam bills by actual duration. Set the agent's maximum call duration in Sarvam (see §9) to bound it.
- **Provider cost reconciliation** (Sarvam's charge vs ClickAI's) is not automated; compare Sarvam's credit usage with `usage_records` monthly.

## 6. Call lifecycle

| Status                                                  | Meaning                                                        | Allowed next                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `initiated`                                             | Reserved; start request sent or in flight                      | ringing, answered, in_progress, completed, failed, busy, no_answer, cancelled; `outcome_unknown` (stuck-start sweep) |
| `ringing` / `answered` / `in_progress`                  | Provider progress (Sarvam usually sends only the final result) | forward only                                                                                                         |
| `completed`, `failed`, `busy`, `no_answer`, `cancelled` | Final; triggers finalization once                              | none                                                                                                                 |
| `outcome_unknown`                                       | Start was ambiguous, or Sarvam never confirmed it              | only a final status (late webhook, reconciliation, operator)                                                         |

Transitions are checked by `checkCallTransition` (same state = no-op; illegal = rejected and logged). Finalization starts from a database trigger the first time a call becomes final, so no path can skip it.

**Provider ambiguity.**

| Situation                                     | Result                                                                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refused before the request (validation, gate) | nothing written                                                                                                                                                                        |
| Definite rejection (4xx)                      | `failed`, zero-charge finalization, error shown                                                                                                                                        |
| Timeout, network error, 5xx, 429              | `outcome_unknown`; **never retried automatically** (it may have rung)                                                                                                                  |
| Accepted without attempt id                   | stays `initiated`; the webhook finds it by `metadata.call_id`                                                                                                                          |
| Webhook before the start response is saved    | the webhook wins; the late save does not regress it                                                                                                                                    |
| No webhook ever                               | `initiated` + attempt id: reconciled from Sarvam's attempt record after 15 min (hourly per call, up to 7 days). `initiated` without attempt id: becomes `outcome_unknown` after 30 min |
| Worker dies mid-start                         | the row stays `initiated` without attempt id → flagged after 30 min; the number stays reserved until resolved                                                                          |

Operators resolve `outcome_unknown` calls from admin → Calls → Needs review (audited, `resolved_by`).

## 7. Webhooks

- Authentication: `verify_token` query parameter compared in constant time (current and, during rotation, previous secret). Invalid → 401, nothing stored.
- Payload validated by the Sarvam adapter; malformed → 400.
- Dedupe: `webhook_events (provider, event_id)` unique; stores identifiers only, never the raw body or token. A replay of a processed event is ignored; a replay of a failed one is re-claimed once and retried.
- Call resolution: by provider attempt id, interaction id, then `metadata.call_id` (validated UUID, same organization); unknown calls are logged and ignored.
- Out-of-order and duplicate statuses are safe (transition rules + idempotent finalization).
- Gap: an event stored but never processed (crash between the two) is not re-run by a replay; for outbound calls the reconcile sweep resolves the call from Sarvam's records instead.

## 8. Monitoring and operations

| What                        | How                                                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop all new outbound calls | set `OUTBOUND_CALLING_DISABLED=true` (Worker secret/var). Calls in progress, webhooks and billing continue. Also stops campaign dispatch.                                                                                                                                                    |
| Stop one customer           | admin: turn outbound off on their number, or lock the phone feature                                                                                                                                                                                                                          |
| Calls needing review        | admin → Calls → Needs review (`outcome_unknown`, stuck `initiated`, finalization failed)                                                                                                                                                                                                     |
| Logs                        | `sarvam_outbound:admission_refused`, `sarvam_outbound:start_not_confirmed`, `sarvam_outbound:start_result_not_saved`, `call_finalization:failed`, `telephony:webhook_signature_invalid`, `telephony:webhook_processing_failed`, `jobs:sarvam_call_reconciled`. Numbers are masked or absent. |
| Job health                  | the scheduler raises an alert for dead-lettered jobs                                                                                                                                                                                                                                         |

Daily check (read-only SQL):

```sql
-- open or unconfirmed single calls older than 30 minutes
SELECT id, organization_id, status, started_at FROM call_logs
 WHERE provider = 'sarvam' AND direction = 'outbound' AND campaign_id IS NULL
   AND status IN ('initiated', 'outcome_unknown') AND started_at < now() - interval '30 minutes';
-- finished calls whose billing is not done
SELECT id, finalization_state, finalization_error FROM call_logs
 WHERE finalization_state IN ('pending', 'failed') AND updated_at < now() - interval '15 minutes';
-- charge vs duration mismatch
SELECT c.id, c.duration_seconds, c.customer_charge, -w.amount AS debited
  FROM call_logs c LEFT JOIN wallet_transactions w ON w.kind = 'call_usage' AND w.reference = c.id::text
 WHERE c.direction = 'outbound' AND c.billing_applied_at IS NOT NULL
   AND coalesce(-w.amount, 0) <> coalesce(c.customer_charge, 0);
```

## 9. Sarvam agent contract (outbound)

ClickAI sets per call (spread last, so nothing else can override them): `call_direction=outbound`, `clickai_call_id`, `campaign_objective` (≤300 chars, sanitized), `campaign_instructions` (≤1500), plus the opening-line override. Inbound calls pass nothing, so the agent's declared default `call_direction=inbound` applies, and a caller cannot change it.

Manual Sarvam configuration still needed on the v6 draft (not done; needs approval):

1. `book_appointment` and `request_callback` tool bodies: add `clickai_call_id` = `@clickai_call_id`. On an outbound call the server then refuses both (`OUTBOUND_BOOKING_NOT_ALLOWED`, `OUTBOUND_USE_CALL_RESULT`): the agent sends the person to the clinic to book, and a callback is saved once at finalization from `outbound_result`, on the dialled number. `check_availability` stays allowed.
2. Set the agent's maximum call duration (bounds the wallet overrun in §5).
3. Keep `record_call_outcome` at its 8 fields (its outbound leads are already dropped by exact direction matching).

Verification after the change (text playground, no calls): the generated brief (`getSarvamAgentBrief`) matches the tool bodies; an outbound test conversation's booking audit row shows `outbound_call: true`.

## 10. Configuration

| Setting                          | Default           | Effect                                                      |
| -------------------------------- | ----------------- | ----------------------------------------------------------- |
| `OUTBOUND_CALLING_DISABLED`      | unset             | `true` stops all new outbound calls                         |
| `OUTBOUND_ALLOWED_COUNTRY_CODES` | `91`              | comma list of country codes                                 |
| `OUTBOUND_CALLING_HOURS`         | `9-21`            | narrower whole-hour window, India time                      |
| `SARVAM_OUTBOUND_TEST_ALLOWLIST` | set in production | only these numbers can be called; keep until §3 is resolved |
| `CAMPAIGN_DISPATCH_ENABLED`      | unset             | campaigns stay off                                          |

## 11. Rollout and rollback

Before production (each step needs approval): apply migration `20261119090000_outbound_call_admission.sql` **before** deploying the Worker that calls it (the old Worker ignores the new column and function). Then deploy, then follow `docs/outbound-single-call-go-live.md`.

Rollback: deploy the previous Worker version first, then (only if needed) run `docs/production-rollback-20261119090000-outbound-call-admission.sql`. Contacts marked opted out stay opted out.

## 12. Known limitations

- Legal items in §3 are open; the allowlist is the control until they are answered.
- Wallet can go negative on calls longer than the admitted minutes (§5).
- Limits are per customer, not per user; there is no per-user rate limit beyond them.
- No automated provider-cost reconciliation or paging alerts; monitoring is the logs and daily SQL above.
- A webhook stored but never processed relies on the reconcile sweep (§7).
