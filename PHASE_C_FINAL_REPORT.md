# PHASE C — FINAL REPORT

Scope: admin billing/payments/wallet screens — billing transaction table,
wallet balances, refunds, and the profit/margin dashboard — executed
against the existing repository per the Master Specification and prior
audit/conflicts documents.

## 1. IMPLEMENTED

- **Refunds, end to end.** New `refunds` table; `createRazorpayRefund` in
  `razorpay.server.ts` (mirrors `createRazorpayOrder`'s pattern: reports
  not-configured rather than faking success); `requestRefund` server
  function (validates the payment is captured, enforces that the sum of
  processed+pending refunds never exceeds the original amount, calls
  Razorpay, records exactly the status Razorpay returns); webhook extended
  to handle `refund.processed`/`refund.failed` events, since a refund is
  only ever marked "processed" on genuine provider confirmation, never on
  the create-call's 2xx alone.
- **Billing transaction table** (`admin.billing.tsx` / `listBillingTransactions`)
  — every payment platform-wide, joined with its invoice and refund status,
  filterable by status and free-text search, with a refund action per
  eligible row.
- **Wallets screen** (`admin.wallets.tsx` / `listWallets`) — every
  customer's live balance (computed from the same immutable ledger, not a
  cached field), sorted, searchable, linking into the existing per-customer
  ledger/manual-adjustment view built in an earlier phase rather than
  duplicating it.
- **Refunds screen** (`admin.refunds.tsx` / `listRefunds`) — full refund
  history with provider status.
- **Profit/margin dashboard** (`admin.margins.tsx`) — this is new *UI* for
  `getProfitAnalytics`, which already existed in `admin-finance.functions.ts`
  from an earlier phase but had zero consumers anywhere in the app. The
  server-side math was already correct; Phase C's contribution was
  surfacing it and verifying it.
- Admin nav (`AdminShell.tsx`) updated with all four new screens.

## 2. FOUND BUT NOT FIXED — flagged for your decision

`admin.pricing.tsx` still edits the legacy `platform_settings['pricing.*']`
mechanism (flat amounts, no customer/provider split), not `pricing_rules`
(the table with the correct `customer_amount`/`provider_cost` split that the
margin dashboard actually reads). This is the pricing-mechanism duplication
flagged back in Phase A's CONFLICTS_AND_MIGRATION.md item 2, and it's still
unresolved. Practical effect: there is currently **no admin UI to edit
`pricing_rules.provider_cost`** at all — `upsertPricingRule` exists and is
correct, but nothing in the UI calls it. The margin dashboard will show
real, correctly-computed numbers for whatever's in `pricing_rules` today,
but nobody can update those provider-cost figures through the product.

I did not fix this. It's a real gap, but consolidating two pricing
mechanisms is a materially different, larger change than "billing/payments/
wallet admin screens" — the scope you asked for — so I'm flagging it rather
than expanding scope unilaterally. Worth an explicit go-ahead if you want it
done next.

## 3. DATABASE CHANGES

One new migration:
`20260903100000_phase_c_refunds.sql` — `refunds` table (organization_id,
payment_id, provider_refund_id, amount, currency, status, reason,
requested_by, processed_at), RLS matching the existing pattern
(`authenticated` SELECT own-org-or-admin, `service_role` full access),
indexes on `(organization_id, created_at)` and `(payment_id)`.

All 13 migrations (12 from Phases A/B + this one) apply cleanly, in order,
against a fresh Postgres 16 instance — confirmed by full replay immediately
before writing this report.

## 4. VERIFICATION PERFORMED

Same two-track approach as Phases A/B: real writes/reads against a local
Postgres replica for anything RLS/grant-shaped, and real Node execution of
extracted aggregation/validation logic against realistic seeded data for
anything that's pure computation.

**Against the local replica:**
- Seeded two customers (A, B), a captured setup-fee payment for A, and a
  processed ₹5,000 refund against it.
- Customer A reading their own refund → 1 row returned correctly.
- Customer B reading Customer A's refund → 0 rows (tenant isolation holds
  on the new table).
- Customer A attempting to INSERT a refund directly (self-approve, bypass
  the admin/Razorpay flow) → `permission denied for table refunds`.
- `service_role` reading refunds → full access, unrestricted (confirms the
  admin path works).
- `wallet_balance()` under proper auth context (`SET ROLE authenticated` +
  the org owner's uid) → returned ₹960 exactly, matching a hand-computed
  raw SQL sum over the same seeded ledger rows (₹1,000 credit, ₹40 debit).

**Against extracted logic (Node), using the real seeded rows as input:**
- `getProfitAnalytics`'s per-customer and totals math — for a ₹40 call with
  ₹35 provider cost: revenue=₹40, providerCost=₹35, grossProfit=₹5,
  marginPct=12.5%, all correct. This is the exact example you gave at the
  start of this thread — confirmed the dashboard would show precisely
  that.
- `listWallets`'s balance/last-activity aggregation — ₹960 balance, correct
  most-recent-transaction timestamp, zero-balance customer handled.
- `listBillingTransactions`'s refund-status classification (`none` /
  `partial` / `full` / `pending`) — five scenarios checked, including the
  processed+pending-mixed case (pending correctly takes display priority
  since the money isn't confirmed moved yet).
- `requestRefund`'s over-refund guard, run against the *actual* seeded
  state (₹9,999 payment, ₹5,000 already refunded): requesting exactly the
  ₹4,999 remainder succeeds, requesting one paisa more is rejected with the
  correct remaining-amount message.

## 5. NOT VERIFIED AGAINST PRODUCTION

Same standing constraint as Phases A and B: I don't have credentials to the
actual Supabase/Lovable Cloud project (only the anon key is in `.env`), so
none of the above was run against the live database — only a faithful local
replica built from the real migration files. Also not exercised: an actual
live Razorpay refund call (no live credentials in this environment) — the
webhook-handling code path for `refund.processed`/`refund.failed` is
reviewed and typed correctly but not fired against a real event.

## 6. TYPECHECK

`npx tsc --noEmit` — **PASS**, 0 errors, final state (includes fixing the
`refunds` table type and the `organizations` route-tree entries, both of
which needed manual/build-triggered updates since there's no live Supabase
to regenerate `types.ts` from).

## 7. LINT

`npx eslint` scoped to every file touched this phase — **PASS**, 0 errors
after `--fix` (formatting-only fixes, consistent with Phases A/B).

## 8. BUILD

`npx vite build` — **PASS**, final state. The TanStack Start plugin
regenerated the route tree to include the four new admin pages.

## 9. FILES CHANGED

New:
- `supabase/migrations/20260903100000_phase_c_refunds.sql`
- `src/routes/admin.billing.tsx`
- `src/routes/admin.wallets.tsx`
- `src/routes/admin.refunds.tsx`
- `src/routes/admin.margins.tsx`

Edited:
- `src/lib/razorpay.server.ts` — added `createRazorpayRefund`.
- `src/lib/admin-finance.functions.ts` — added `listBillingTransactions`,
  `listWallets`, `requestRefund`, `listRefunds`.
- `src/routes/api/public/webhooks/razorpay.ts` — added refund event
  handling.
- `src/components/admin/AdminShell.tsx` — nav entries for the four new
  screens.
- `src/integrations/supabase/types.ts` — manually added `refunds` table
  type (no live Supabase to regenerate from, same constraint as Phases A/B).

## 10. REQUIRED ENVIRONMENT VARIABLES

None new. Refunds reuse the existing `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/
`RAZORPAY_WEBHOOK_SECRET` from earlier phases.

## 11. REQUIRED DEPLOYMENT STEPS

1. Apply `20260903100000_phase_c_refunds.sql` to the actual project.
2. If your Razorpay webhook subscription doesn't already include
   `refund.processed` and `refund.failed` events, add them in the Razorpay
   dashboard — without them, a non-instant refund will stay `pending`
   forever in the app even after it actually settles.
3. Confirm directly against the real database (same constraint as before —
   I can't do this myself):
   ```sql
   SELECT grantee, privilege_type FROM information_schema.table_privileges
   WHERE table_name = 'refunds' AND grantee = 'authenticated';
   ```
   Expect `SELECT` only, no `INSERT`/`UPDATE`/`DELETE`.
4. Decide on §2 (pricing mechanism consolidation) — not blocking for this
   phase's screens to work correctly, but blocking for anyone to actually
   edit provider cost going forward.

## 12. REMAINING RISKS

- §2 above — the pricing duplication is now more consequential than when
  Phase A flagged it, since the margin dashboard is live and reading from
  the side of that duplication nobody can currently edit.
- No wallet top-up payment purpose exists yet (checked: `billing.functions.ts`
  only knows `setup_fee`/`monthly_plan`/`phone_service_fee`), so refunds
  never need to touch `wallet_transactions` today. When Phase D adds
  wallet top-ups via Razorpay, refunding one of those payments will need a
  corresponding wallet debit ledger entry — the current `requestRefund`
  doesn't create one, because no payment purpose that would need it exists
  yet. Flagging so it isn't forgotten when that purpose is added.
- The billing transaction table fetches up to 500 rows and filters
  client-side; fine at current scale, will need server-side pagination
  before that stops being true.
- No refund UI exists on the *customer* side (spec doesn't require one —
  refunds are admin-initiated per §40 — but customers currently have no way
  to see a refund's status on their own billing page, only in the admin
  screens). Not a security gap, just an incomplete customer experience.

## 13. PHASE C STATUS

**PHASE C COMPLETE** (billing/payments/wallet admin screens, as scoped).

Refunds, billing transaction table, wallets screen, and the profit/margin
dashboard are all implemented, wired into the actual admin navigation, and
verified — both at the database/RLS layer (local replica) and at the
computation layer (extracted logic against real seeded rows, including the
exact ₹40/₹35/₹5/12.5% example from the start of this thread). Typecheck,
lint, and build all pass. One pre-existing design gap (pricing mechanism
duplication) was found and flagged rather than fixed, since resolving it is
outside what was asked for this phase. Production-environment confirmation
remains outstanding, as in every prior phase, due to lack of credentials.
