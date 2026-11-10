# First supervised Sarvam outbound test call

One real outbound call, to one test number, with someone watching. Nothing
here is automatic: no campaign dispatch, no retries, no sweeper. Every step
that changes production needs explicit approval first.

## 1. Required before the migrations (read-only)

Run these against **production** with a read-only role. Do not run any
migration until each result is reviewed.

| #   | Query                                                                                                                                                                                                                                                             | Expected                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Q1  | `SELECT call_id, count(*) FROM public.leads WHERE source = 'campaign' AND call_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;`                                                                                                                                    | 0 rows (otherwise `20261110090000` stops on its pre-check)                   |
| Q2  | `SELECT organization_id, reference, count(*) FROM public.wallet_transactions WHERE kind = 'call_usage' GROUP BY 1, 2 HAVING count(*) > 1;`                                                                                                                        | 0 rows (the existing `idx_wallet_tx_call_usage_ref` guarantees this)         |
| Q3  | `SELECT id, organization_id, status, campaign_contact_id, destination_number FROM public.call_logs WHERE provider = 'sarvam' AND status NOT IN ('completed','failed','busy','no_answer','cancelled');`                                                            | Ideally 0 rows. Duplicates per organization and number stop `20261109090000` |
| Q4  | `SELECT id, status FROM public.campaigns WHERE status = 'running';` and `SELECT count(*) FROM public.campaign_contacts WHERE status IN ('calling','outcome_unknown');`                                                                                            | Ideally 0 and 0                                                              |
| Q5  | `SELECT count(*) FROM public.call_logs c WHERE c.provider = 'sarvam' AND c.status IN ('completed','failed','busy','no_answer','cancelled') AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions w WHERE w.kind = 'call_usage' AND w.reference = c.id::text);` | For information (zero-charge calls are counted too)                          |

Migration order: `20261109090000_outbound_call_outcome_unknown.sql`, then
`20261110090000_sarvam_outbound_call_finalization.sql`.

## 2. Configuration (each needs approval)

- `SARVAM_OUTBOUND_TEST_ALLOWLIST` = the one test number (with country code).
  Every Sarvam outbound path refuses any other number before writing anything.
- The Sarvam outbound settings and `SARVAM_WEBHOOK_SECRET` (webhook URL with
  `verify_token`).
- Do **not** schedule `/api/public/cron/dispatch-campaigns`. Confirm Q4 shows
  no running campaign.

## 3. Placing the call

Admin → Customers → the demo/test organization (`businesses.is_demo`) →
**Test outbound call** to the allowlisted number, with a reason. This uses
`testSarvamOutboundCall` (platform admin, `confirmTest`, demo organization
only, audited). No customer call, no campaign.

## 4. Audit (replace `:call` with the call id from the audit log)

```sql
-- The call and its finalization
SELECT status, provider_call_id, resolution_source, resolved_by, resolution_conflict,
       finalization_state, finalization_attempts, finalization_error,
       billing_applied_at, campaign_applied_at, duration_seconds,
       customer_charge, provider_cost, currency
FROM public.call_logs WHERE id = ':call';

-- Webhook deliveries for its attempt
SELECT event_id, event_type, processed_at, error, created_at
FROM public.webhook_events
WHERE provider = 'sarvam'
  AND event_id = (SELECT provider_call_id FROM public.call_logs WHERE id = ':call');

-- Billing: at most one debit and one usage record
SELECT amount, description, created_at FROM public.wallet_transactions
WHERE kind = 'call_usage' AND reference = ':call';
SELECT quantity, unit, provider_cost, billable_cost FROM public.usage_records WHERE call_id = ':call';

-- Campaign effects: none for a test call
SELECT count(*) FROM public.leads WHERE call_id = ':call';
SELECT count(*) FROM public.campaign_contacts WHERE current_call_id = ':call';

-- Who did what
SELECT action, admin_user_id, new_value, reason, created_at
FROM public.audit_logs WHERE entity_id = ':call' ORDER BY created_at;
```

Expected for a connected call of `d` seconds at a rate of `r` per minute:
`status = completed`, `resolution_source = provider`,
`finalization_state = done`, both checkpoints set,
`customer_charge = ceil(d / 60) * r`, exactly one `call_usage` debit of
`-customer_charge` (none when it is 0), one usage record (none for 0 minutes),
no lead and no campaign contact.

Expected for an unanswered, busy or failed call: that status,
`finalization_state = done`, charge 0, no debit, no usage record.

## 5. If something doesn't finish

- **Status stays `initiated` or becomes `outcome_unknown`**: admin → Calls →
  Needs review → **Resolve**, after checking the call in Sarvam's dashboard.
  It is never retried automatically.
- **Billing/campaign update pending or failed** (`finalization_state`
  `pending`/`failed`): admin → Calls → Needs review → **Retry**. Each step runs
  at most once, so retrying never charges or applies anything twice. The
  error is stored in `finalization_error`.
- **"Sarvam reported a different outcome"** (`resolution_conflict`): an
  operator resolved the call before Sarvam's report arrived. The report is
  kept in `provider_metadata.late_provider_report` and is never applied;
  compare it and correct by hand if needed.

## 6. After the test

Remove `SARVAM_OUTBOUND_TEST_ALLOWLIST` only as part of the production
rollout (Phase 2: event inbox, sweeper and its schedule), not before.
