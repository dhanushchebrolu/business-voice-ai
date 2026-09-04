# PHASE B — FINAL REPORT

Scope: canonical entitlement system, admin-controlled customer provisioning,
dashboard handover, and setup-fee/payment gating, executed against the
existing repository per the Master Specification, ARCHITECTURE_AUDIT.md,
DATABASE_PLAN.md, SECURITY_AUDIT.md and CONFLICTS_AND_MIGRATION.md.

## 1. IMPLEMENTED

- Single source of truth for lifecycle: a DB trigger derives `account_status`
  from `lifecycle_status` on every insert/update, closing the drift bug
  flagged in Phase A's CONFLICTS_AND_MIGRATION.md item 1. All application
  code now writes only `lifecycle_status`.
- Central entitlement table (`organization_entitlements`) with source
  tracking (admin/subscription/trial/system) — admin grants and
  subscriptions coexist independently per feature; revoking one never
  touches another.
- Rewritten `feature_locked()` resolver with explicit precedence: customer
  lock → explicit per-feature admin lock → any active entitlement → legacy
  manual override → payment enforcement (global switch AND per-customer
  override) → platform default.
- Per-customer payment enforcement override (`organizations.payment_override`),
  independent of the global "Require Customer Payment" switch and of any
  specific service grant.
- Customer-level lock/unlock (`lockCustomerAccount`/`unlockCustomerAccount`)
  — blocks everything via `lifecycle_status = suspended`, restores the exact
  prior stage on unlock rather than forcing "active".
- Controlled handover (`handoverClient`) — the one path from READY to
  ACTIVE; validates setup payment or an explicit override and rejects with
  the real reason otherwise.
- Fixed `acceptInvitation`, which previously left every new customer stuck
  at `not_provisioned` forever after signing in (a real bug, not just
  cleanup) — now transitions to `setup_payment_pending`.
- Fixed the Razorpay webhook to advance lifecycle correctly instead of
  writing `account_status` directly and never touching lifecycle at all.
- Removed `setAccountStatus` (a second, conflicting lifecycle-control
  surface) and the admin UI block that used it.
- Dashboard access decoupled from service entitlement in `app.tsx`: setup
  payment gates individual services, not whether the customer can reach a
  workspace at all.
- Backend-authoritative "Dashboard" button on the public site (`PublicNav`),
  resolved from `workspaceQuery`, never from client-supplied state.
- Admin UI: `CustomerControlPanel` (lock/unlock, payment override, handover)
  and `EntitlementsPanel` (grant/revoke per source) added to the customer
  detail page.

### Two additional fixes found during acceptance testing (not part of the
### original plan, but required to make Phase B actually correct)

- **Signup no longer auto-provisions a workspace.** The pre-existing
  `handle_new_user()` trigger created an organization, an owner membership,
  and a 14-day trial subscription for every signup — a self-serve trial
  flow that directly contradicts Phase B §1 ("creating an account must NOT
  automatically create a customer") and failed acceptance Test A outright.
  This is a genuine, deliberate behavior change: self-serve trial signup no
  longer exists. If that product behavior is actually wanted alongside
  admin-provisioned customers, it needs to be reintroduced as an explicit,
  separate decision — not silently.
- **Customers could bypass payment/lifecycle gating directly from the
  browser.** A pre-existing RLS policy (`admins update org`) let an org
  owner/admin UPDATE their own `organizations` row with no column
  restriction — meaning a customer could call
  `supabase.from('organizations').update({ lifecycle_status: 'active',
  payment_override: true })` directly and bypass setup payment,
  entitlements and admin locks entirely. This predates Phase B, but Phase
  B's new fields made it directly exploitable. Fixed with a column-level
  grant restricting `authenticated` UPDATE to ~15 legitimate self-service
  profile fields (name, timezone, contact info, etc.) — confirmed against
  the actual two customer-facing write sites in the codebase
  (`app.settings.tsx`, `app.onboarding.tsx`).

## 2. CUSTOMER PROVISIONING

Unchanged from Phase A/earlier: `createClientAccount` (admin creates
org + immutable `client_id` + invitation), `createInvitation`/
`acceptInvitation` (hashed token, expiring, rate-limited). What Phase B
added: `acceptInvitation` now correctly advances lifecycle on accept instead
of leaving the customer stuck, and signup alone (no admin involvement) no
longer creates any workspace.

## 3. DASHBOARD ACCESS MODEL

`app.tsx` now resolves three distinct states from `lifecycle_status`, not a
payment boolean:

- **No organization at all** → `NoWorkspace` (new component; this is now a
  real, reachable state since signup doesn't auto-provision).
- **`not_provisioned` / `setup_payment_pending`** → `AccountLocked` shows the
  setup/payment screen — this *is* dashboard access, just not service access.
- **`suspended` / `cancelled` / `archived`**, or an explicit admin
  `dashboard` feature-lock → `AccountLocked` shows the suspended message.
- **Everything else** (`setup_paid`, `provisioning`, `ready`, `active`) →
  full `Shell`. Individual services within it remain gated per-feature by
  `feature_locked()`.

The public site's "Dashboard" button (`PublicNav`) is resolved the same way,
server-side, via `workspaceQuery` — never from localStorage or a
client-supplied organization id.

## 4. SETUP PAYMENT FLOW

Unchanged mechanics (Razorpay order → webhook → signature verification →
idempotent payment record), corrected to write `lifecycle_status` instead of
`account_status`, and to only ever advance lifecycle forward (a stray
webhook retry on an already-further-along customer is a no-op, not a
regression). Setup payment no longer implicitly unlocks the dashboard (it
was never actually gating the dashboard correctly before — see the bug
under §1) and does not auto-activate any service; only `setup_paid_at` is
recorded, and each service still needs its own entitlement.

## 5. ENTITLEMENT SYSTEM

`organization_entitlements(organization_id, feature, source, active, ...)`,
UNIQUE per `(org, feature, source)`. `feature_locked()` treats any active row
as an unlock. Confirmed independent of `organization_feature_locks`, which
still wins when it explicitly locks a feature (admin override beats any
grant).

## 6. ADMIN GRANTS

`grantEntitlement`/`revokeEntitlement` — restricted to `admin`/`subscription`
sources from this action (`trial`/`system` reserved for automated code).
Every grant/revoke is audited with actor, reason, and timestamp. No payment,
invoice, or subscription record is ever fabricated by a grant.

## 7. CUSTOMER LOCK/UNLOCK

`lockCustomerAccount` moves `lifecycle_status` to `suspended`, storing the
prior stage in `pre_suspension_status`. `unlockCustomerAccount` restores
that exact stage — never forces `active`. Confirmed: locking blocks even an
actively-entitled service (WhatsApp with a live subscription-source
entitlement) and the dashboard itself; no data is touched (org row,
entitlements, members all preserved).

## 8. SERVICE LOCK/UNLOCK

Unchanged mechanism (`organization_feature_locks`, `setFeatureLock`),
integrated into the new resolver precedence — confirmed to override an
active entitlement when locked, and to correctly fall through to the
entitlement/payment-driven default (not a forced "active") when unlocked.

## 9. PAYMENT CONTROL

`setPaymentOverride` toggles `organizations.payment_override`, independent
of every other customer. Confirmed: overriding Customer B does not affect
Customer A's gating in any way (separate row, separate resolver call).

## 10. HANDOVER

`handoverClient` requires `lifecycle_status = 'ready'` AND
(`setup_paid_at` set OR `payment_override = true`). Rejects with the actual
missing requirement(s) otherwise and leaves lifecycle untouched. Confirmed
both the reject and the success path, including the admin-override variant
(handover without a real payment, when explicitly authorized).

## 11. DATABASE CHANGES

Three new migrations, applied in order after Phase A's 9:

1. `20260902080000_phase_b_entitlements_and_payment_control.sql` —
   lifecycle/account_status sync trigger, `payment_override` +
   `pre_suspension_status` + lock columns on `organizations`,
   `organization_entitlements` table, rewritten `feature_locked()`,
   `features.defaults.dashboard` flipped to unlocked-by-default.
2. `20260902090000_restrict_organizations_customer_update_columns.sql` —
   closes the customer payment-bypass RLS gap described in §1.
3. `20260902091500_signup_no_longer_auto_provisions_workspace.sql` — removes
   auto-provisioning from `handle_new_user()`.

All 12 migrations (9 from Phase A + these 3) apply cleanly, in order,
against a fresh Postgres 16 instance — confirmed by full replay immediately
before writing this report.

## 12. RLS/SECURITY

- `organization_entitlements`: `authenticated` has SELECT only (own org or
  platform admin); all writes are `service_role`-only through the audited
  server functions. Confirmed: a customer cannot INSERT their own grant
  (`permission denied`).
- `organizations`: `authenticated` UPDATE restricted to a fixed column list
  (§1). Confirmed: `lifecycle_status`/`payment_override` writes from a
  customer session are rejected; the two legitimate self-service writes
  (`name`/`timezone` from settings, `onboarding_completed`) still work.
- Tenant isolation reconfirmed on the new table: Customer A sees zero rows
  when querying Customer B's `organization_entitlements`.
- `platform_admins` unaffected by Phase B — still `authenticated`-SELECT-only,
  confirmed a customer cannot self-insert a super_admin row.
- No duplicate lifecycle, billing, pricing, entitlement or authorization
  system was introduced. `organization_entitlements` extends the existing
  `organization_feature_locks`/`feature_locked()` mechanism rather than
  replacing it; pricing/billing untouched from Phase A.

## 13. TESTS

Acceptance tests A–Q from the Phase B brief, run against a local Postgres
16 replica built from the actual migration files (schema/grants/RLS/trigger
behavior genuinely executed, not just read) plus direct execution of
extracted TypeScript validation logic (`handoverClient`'s guard, matching
Phase A's approach for the admin-bootstrap logic):

| Test | Result |
|---|---|
| A — normal user, no workspace | **Pass** (after the auto-provisioning fix) |
| B — admin creates customer | Not independently re-tested this phase (unchanged from Phase A: `createClientAccount` still creates org + client_id + invitation) |
| C — customer registers | **Pass** — `not_provisioned → setup_payment_pending` on accept |
| D — unpaid setup | **Pass** — dashboard reachable, `voice_agent` locked |
| E — setup payment | **Pass** — `setup_paid_at` set, lifecycle advances, service still not auto-activated |
| F — admin setup override | **Pass** — override unlocks, zero fake payment/invoice rows |
| G — admin service grant | **Pass** — entitlement unlocks, zero fake subscription |
| H — subscription + grant coexist | **Pass** — independently verified, including revoke-one-keep-other |
| I — customer lock | **Pass** — blocks an actively-entitled service and dashboard; data preserved; unlock restores prior stage |
| J — service lock | **Pass** — overrides active entitlement; unrelated feature unaffected |
| K — service unlock | **Pass** — falls through to entitlement/default, not forced "active"; confirmed both with and without an underlying entitlement |
| L — payment override (per customer) | **Pass** — Customer B's override doesn't affect Customer A |
| M — handover | **Pass** — ready + paid → active |
| N — invalid handover | **Pass** — rejects with real reason, lifecycle unchanged |
| O — tenant isolation | **Pass** — 0 rows cross-tenant on org + entitlements |
| P — payment bypass | **Pass** (after the RLS fix) — direct lifecycle/override writes rejected; legitimate settings writes still work |
| Q — admin escalation | **Pass** — self-grant, self-unlock, self-admin all rejected at the grant layer |

## 14. TYPECHECK

`npx tsc --noEmit` — **PASS**, 0 errors, final state.

## 15. LINT

`npx eslint` scoped to every file touched this phase — **PASS**, 0 errors
(one pre-existing-style warning on `PublicNav.tsx`,
`react-refresh/only-export-components`, non-blocking, same class as an
existing warning from Phase A's `admin.tsx`). Repo-wide `eslint .` still
carries the large pre-existing formatting backlog documented in Phase A —
untouched, out of scope.

## 16. BUILD

`npx vite build` — **PASS**, final state, after all fixes above.

## 17. FILES CHANGED

New:
- `supabase/migrations/20260902080000_phase_b_entitlements_and_payment_control.sql`
- `supabase/migrations/20260902090000_restrict_organizations_customer_update_columns.sql`
- `supabase/migrations/20260902091500_signup_no_longer_auto_provisions_workspace.sql`
- `src/components/admin/CustomerControlPanel.tsx`
- `src/components/admin/EntitlementsPanel.tsx`
- `src/components/app/PublicNav.tsx`
- `src/components/app/NoWorkspace.tsx`

Edited:
- `src/lib/admin-clients.functions.ts` — fixed `acceptInvitation`; removed
  manual `account_status` writes; added `handoverClient`,
  `lockCustomerAccount`, `unlockCustomerAccount`, `setPaymentOverride`,
  `grantEntitlement`, `revokeEntitlement`.
- `src/lib/admin.functions.ts` — removed `setAccountStatus`; added
  entitlements to `getCustomerDetail`.
- `src/routes/api/public/webhooks/razorpay.ts` — fixed lifecycle-write bug.
- `src/routes/app.tsx` — rewritten gating logic (dashboard vs service
  access vs no-workspace).
- `src/components/app/AccountLocked.tsx` — rewritten for
  lifecycle-based state, shows Client ID.
- `src/routes/index.tsx` — wired in `PublicNav`.
- `src/routes/admin.customers.$orgId.tsx` — removed the old account-status
  UI block; wired in `CustomerControlPanel`/`EntitlementsPanel`.
- `src/integrations/supabase/types.ts` — manually updated (no live Supabase
  to regenerate from): `organization_entitlements` table type, new
  `organizations` columns, `entitlement_source` enum.

## 18. REQUIRED ENVIRONMENT VARIABLES

None new for Phase B. `PLATFORM_ADMIN_BOOTSTRAP_SECRET` from Phase A is
unaffected and still required.

## 19. REQUIRED DEPLOYMENT STEPS

1. Apply the three new migrations, in order, to the actual project.
2. **Read §1's two "found during testing" fixes carefully before deploying**
   — one removes a live feature (self-serve trial signup), the other closes
   a real payment-bypass hole. Confirm both are what you want before this
   goes to production.
3. After deploying, verify directly against the real database (I don't have
   credentials to do this myself — same constraint as Phase A):
   ```sql
   SELECT grantee, privilege_type, column_name
   FROM information_schema.column_privileges
   WHERE table_name = 'organizations' AND grantee = 'authenticated' AND privilege_type = 'UPDATE';
   ```
   Expect exactly the 15 profile columns listed in the migration, not the
   full table.
4. Spot-check one real signup end-to-end: confirm no organization row is
   created until an admin explicitly provisions one.
5. If self-serve trial signup is actually a wanted product path, treat that
   as a new, explicit decision — not a silent revert of this fix.

## 20. REMAINING RISKS

- **Production verification gap** — same as Phase A: everything above is
  verified against a faithful local Postgres replica and direct execution
  of extracted logic, not against the actual project database. I don't have
  credentials to change that.
- The admin UI added this phase (`CustomerControlPanel`, `EntitlementsPanel`)
  covers the core actions from the Phase B brief but not the full "Feature
  Access" table layout described in the Admin Dashboard spec (all the
  columns: Setup Status, Wallet Status, Last Changed, Changed By, etc. as
  one unified view) — that's a UI-completeness gap, not a security or
  correctness one; the underlying data and actions all exist and are
  audited.
- Feature-level (sub-service) locks — e.g. "Phone AI → Recording locked,
  Transcription active" — are not built. The resolver and schema support it
  (any string is a valid `feature` key), but no admin UI exposes it yet.
- `organization_feature_locks` and `organization_entitlements` are two
  tables cooperating through one resolver, which is correct per the "one
  canonical resolver" rule, but is still two tables to reason about. If a
  future phase adds a third access-control table, that would be worth
  resisting — the resolver, not the table count, should stay singular.
- Test B was not independently re-verified this phase (relied on Phase A's
  read of `createClientAccount`, which Phase B didn't modify).

## 21. PHASE B STATUS

**PHASE B COMPLETE**

All four objectives implemented and modified in the actual repository (not
just planned). Typecheck, lint (scoped to every touched file), and build all
pass. All 17 acceptance tests from the brief that were re-testable this
phase passed against a local Postgres replica or direct logic execution,
including two real bugs found only during that testing (self-serve
auto-provisioning contradicting §1, and a customer payment-bypass RLS gap)
that were fixed before being called done, not glossed over. Production-
environment confirmation remains outstanding and requires credentials I
don't have (§19 lists exactly what to check). Not starting Phase C.
