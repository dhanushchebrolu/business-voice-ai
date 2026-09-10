-- ============================================================================
-- Klyro AI — Live Database Verification Script (READ-ONLY)
-- ============================================================================
-- Target: the NEW canonical Klyro Ai Supabase project ONLY
--         (project ref: eorazvlmqwunmhwiocn)
--
-- Do NOT run this against any other Supabase project.
--
-- SAFETY:
--   - This script contains ONLY read queries: SELECT and catalog/introspection
--     functions (pg_get_functiondef, pg_get_indexdef, etc).
--   - It contains NO INSERT, UPDATE, DELETE, ALTER, DROP, CREATE, TRUNCATE,
--     GRANT, or REVOKE statements anywhere.
--   - It creates no test users, no test rows, and makes no schema changes.
--   - It is safe to run against a live/production database as-is.
--
-- SCOPE / LIMITATION — READ THIS BEFORE INTERPRETING RESULTS:
--   Everything in this script is STATIC / CATALOG verification. It reads
--   Postgres's own system catalogs (information_schema, pg_catalog) to show
--   what tables, columns, grants, policies, functions, and triggers actually
--   exist in the live database, and it prints policy/function DEFINITIONS as
--   text so they can be read and compared against the migration source.
--
--   It CANNOT prove runtime behavior. In particular it does NOT prove:
--     - that customer A's authenticated session actually cannot read/write
--       customer B's data (that requires running real queries AS an
--       authenticated user against real rows in two different orgs)
--     - that a real signup actually results in only a profile row and no
--       organization/membership/subscription (that requires performing a
--       real signup and checking the resulting rows)
--     - that a customer session actually gets rejected when attempting to
--       write a protected column (that requires attempting the write as an
--       authenticated, non-service-role session)
--     - that a customer cannot self-escalate to platform_admin (same —
--       requires an authenticated attempt, not just reading the policy text)
--   Every section below is labeled [STATIC] or [RUNTIME REQUIRED]. Sections
--   labeled [RUNTIME REQUIRED] only show you the policy/grant that is
--   *supposed* to enforce the behavior — confirming the enforcement itself
--   needs an actual authenticated-role test, not just reading its definition.
--
-- HOW TO USE:
--   Run the whole script at once, or section by section. Copy the full
--   result set (or a screenshot per section) back for review.
-- ============================================================================


-- ============================================================================
-- 0. WHICH DATABASE AM I ACTUALLY CONNECTED TO?
-- ============================================================================
-- [STATIC] Sanity check — confirms you're looking at the database you think
-- you are before trusting anything else below.
SELECT current_database() AS database_name,
       current_user       AS connected_as,
       now()               AS checked_at;


-- ============================================================================
-- 1. EXPECTED TABLES (all 37 tables introduced/used by the 17 migrations)
-- ============================================================================
-- [STATIC] Lists every table the migrations are expected to have created in
-- the public schema, and whether it actually exists, has RLS enabled, and
-- its row count is (informationally — do not expect 0 rows to mean broken;
-- an empty fresh database is fine here, that's expected on a fresh init).
WITH expected(table_name) AS (
  VALUES
    ('admin_support_sessions'), ('agent_configs'), ('agent_versions'),
    ('audit_logs'), ('business_hours'), ('business_rules'), ('businesses'),
    ('call_logs'), ('crm_notes'), ('customer_events'), ('demo_requests'),
    ('faqs'), ('invoices'), ('knowledge_documents'), ('leads'),
    ('notifications'), ('organization_entitlements'),
    ('organization_feature_locks'), ('organization_invitations'),
    ('organization_members'), ('organization_pricing_overrides'),
    ('organizations'), ('payment_orders'), ('payments'), ('phone_numbers'),
    ('platform_admins'), ('platform_settings'), ('pricing_rules'),
    ('profiles'), ('public_assistant_rate_limits'),
    ('public_knowledge_base'), ('refunds'), ('services'), ('subscriptions'),
    ('telephony_connections'), ('usage_records'), ('wallet_transactions'),
    ('webhook_events')
)
SELECT
  e.table_name,
  (c.relname IS NOT NULL) AS exists_in_db,
  c.relrowsecurity        AS rls_enabled,
  c.relforcerowsecurity   AS rls_forced
FROM expected e
LEFT JOIN pg_class c
  ON c.relname = e.table_name
 AND c.relnamespace = 'public'::regnamespace
 AND c.relkind = 'r'
ORDER BY exists_in_db ASC, e.table_name;


-- ============================================================================
-- 2. EXPECTED ENUM TYPES
-- ============================================================================
-- [STATIC]
WITH expected(type_name) AS (
  VALUES ('account_status'), ('entitlement_source'), ('lifecycle_status'),
         ('member_role'), ('platform_role'), ('subscription_status')
)
SELECT
  e.type_name,
  (t.typname IS NOT NULL) AS exists_in_db,
  string_agg(en.enumlabel, ', ' ORDER BY en.enumsortorder) AS enum_values
FROM expected e
LEFT JOIN pg_type t
  ON t.typname = e.type_name
 AND t.typnamespace = 'public'::regnamespace
LEFT JOIN pg_enum en ON en.enumtypid = t.oid
GROUP BY e.type_name, t.typname
ORDER BY e.type_name;


-- ============================================================================
-- 3. ALL COLUMNS FOR EVERY public TABLE (full schema dump for cross-checking)
-- ============================================================================
-- [STATIC] Large output by design — this is the ground truth to diff against
-- the migration files' CREATE TABLE / ALTER TABLE statements column-by-column.
SELECT
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.is_nullable,
  c.column_default
FROM information_schema.columns c
WHERE c.table_schema = 'public'
ORDER BY c.table_name, c.ordinal_position;


-- ============================================================================
-- 4. INDEXES AND UNIQUE CONSTRAINTS
-- ============================================================================
-- [STATIC] Includes the security/idempotency-critical unique indexes:
--   idx_phone_numbers_e164_active_global (one active number per e164, ever)
--   idx_call_logs_provider_call_id (webhook retry idempotency)
--   idx_wallet_tx_call_usage_ref (one wallet debit per call)
--   idx_usage_records_call_kind (one usage row per call+kind)
--   public_knowledge_base.title UNIQUE (seed idempotency)
SELECT
  schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;

-- Named CHECK/UNIQUE/PK/FK constraints (separate from indexes above)
SELECT
  tc.table_name,
  tc.constraint_name,
  tc.constraint_type
FROM information_schema.table_constraints tc
WHERE tc.table_schema = 'public'
ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name;


-- ============================================================================
-- 5. EXPECTED FUNCTIONS — existence + full definition
-- ============================================================================
-- [STATIC] Prints the actual live function body so it can be diffed against
-- the migration source. Pay particular attention to #9 (handle_new_user)
-- and #10 (security-sensitive functions) below — this only shows you what
-- the function *says* it does; it does not execute it.
WITH expected(func_name) AS (
  VALUES
    ('customer_rate'), ('debit_wallet_for_call'), ('feature_locked'),
    ('handle_new_user'), ('has_org_role'), ('increment_rate_limit'),
    ('is_org_member'), ('is_platform_admin'), ('platform_admin_role'),
    ('protect_client_id'), ('sync_account_status_from_lifecycle'),
    ('update_updated_at_column'), ('wallet_balance'), ('wallet_can_afford')
)
SELECT
  e.func_name,
  (p.oid IS NOT NULL)                       AS exists_in_db,
  p.prosecdef                               AS is_security_definer,
  pg_get_functiondef(p.oid)                 AS full_definition
FROM expected e
LEFT JOIN pg_proc p
  ON p.proname = e.func_name
 AND p.pronamespace = 'public'::regnamespace
ORDER BY e.func_name;


-- ============================================================================
-- 6. EXPECTED TRIGGERS
-- ============================================================================
-- [STATIC]
WITH expected(trigger_name) AS (
  VALUES
    ('on_auth_user_created'), ('trg_agent_updated'), ('trg_biz_updated'),
    ('trg_call_logs_updated'), ('trg_entitlements_updated'),
    ('trg_faqs_updated'), ('trg_feature_locks_updated'), ('trg_hours_updated'),
    ('trg_invites_updated'), ('trg_knowledge_updated'), ('trg_leads_updated'),
    ('trg_orgs_client_id_immutable'), ('trg_orgs_updated'),
    ('trg_payment_orders_updated'), ('trg_phone_numbers_updated'),
    ('trg_platform_admins_updated'), ('trg_platform_settings_updated'),
    ('trg_pricing_overrides_updated'), ('trg_pricing_rules_updated'),
    ('trg_profiles_updated'), ('trg_public_knowledge_base_updated'),
    ('trg_refunds_updated'), ('trg_rules_updated'), ('trg_services_updated'),
    ('trg_subs_updated'), ('trg_sync_account_status')
)
SELECT
  e.trigger_name,
  t.event_object_table AS on_table,
  t.action_timing,
  t.event_manipulation,
  (t.trigger_name IS NOT NULL) AS exists_in_db
FROM expected e
LEFT JOIN information_schema.triggers t
  ON t.trigger_name = e.trigger_name
 AND t.trigger_schema = 'public'
ORDER BY e.trigger_name;

-- Special case: on_auth_user_created lives on auth.users, not a public table.
SELECT tgname, tgrelid::regclass AS on_table, tgenabled
FROM pg_trigger
WHERE tgname = 'on_auth_user_created';


-- ============================================================================
-- 7. RLS ENABLED STATUS — every security-sensitive table
-- ============================================================================
-- [STATIC] Every one of these should show rls_enabled = true. Any 'f' here
-- is an immediate red flag — a table with no RLS and any authenticated-role
-- grant is fully exposed to every logged-in customer.
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced_even_for_owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname;


-- ============================================================================
-- 8. ALL RLS POLICIES — full definitions
-- ============================================================================
-- [STATIC] This is the actual, live policy text. [RUNTIME REQUIRED] to prove
-- these are actually enforced as written for a real authenticated session —
-- reading this only proves the policy exists and what it says.
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd            AS applies_to_command,
  qual           AS using_expression,
  with_check     AS with_check_expression
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;


-- ============================================================================
-- 9. TABLE/COLUMN-LEVEL GRANTS — what `authenticated` and `anon` can actually
--    SELECT/INSERT/UPDATE/DELETE, column by column
-- ============================================================================
-- [STATIC] This is the layer RLS does NOT cover (RLS restricts rows, not
-- columns). Specifically check here that:
--   - usage_records: `authenticated` has SELECT on a column list that
--     EXCLUDES provider_cost (see fix migration
--     20260902070000_fix_usage_records_provider_cost_leak.sql)
--   - call_logs: `authenticated` has SELECT on a column list that EXCLUDES
--     provider_cost, gross_profit, provider_metadata (customer_charge IS
--     expected to be included — customers may see their own charges)
--   - organizations: `authenticated` has UPDATE only on the narrow column
--     list (name, timezone, onboarding_completed, contact_*, address, city,
--     country, industry, website, business_type, currency, gst_number,
--     pan_number) — NOT lifecycle_status, account_status, client_id,
--     payment_override*, locked_*, setup_paid_at, crm_stage,
--     internal_notes, assigned_admin_id, owner_id, etc.
--   - platform_admins: `authenticated` should have no INSERT/UPDATE grant
--     at all (admin creation must go through service_role only)
SELECT
  table_name,
  grantee,
  privilege_type,
  string_agg(column_name, ', ' ORDER BY column_name) AS columns_granted
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND grantee IN ('authenticated', 'anon')
GROUP BY table_name, grantee, privilege_type
ORDER BY table_name, grantee, privilege_type;

-- Table-level (whole-table, no column list) grants, for comparison —
-- a table-level grant here for authenticated/anon on a financial table
-- would mean the column-level restriction above isn't actually narrowing
-- anything.
SELECT
  table_name, grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee IN ('authenticated', 'anon')
ORDER BY table_name, grantee, privilege_type;


-- ============================================================================
-- 10. handle_new_user — confirm it no longer auto-provisions a workspace
-- ============================================================================
-- [STATIC — text inspection] [RUNTIME REQUIRED — to prove actual signup
-- behavior] Read the printed definition below: the intended, current version
-- (per 20260902091500_signup_no_longer_auto_provisions_workspace.sql) ONLY
-- inserts into public.profiles. It must NOT reference organizations,
-- organization_members, or subscriptions anywhere in its body. If any of
-- those three words appear in the definition text, auto-provisioning is
-- still active and this is a critical finding.
SELECT pg_get_functiondef(p.oid) AS handle_new_user_definition
FROM pg_proc p
WHERE p.proname = 'handle_new_user'
  AND p.pronamespace = 'public'::regnamespace;

-- Cheap automated flag: does the live function body still mention any of
-- the three auto-provisioning targets it must NOT touch?
SELECT
  pg_get_functiondef(p.oid) ILIKE '%organization_members%' AS still_touches_membership,
  pg_get_functiondef(p.oid) ILIKE '%subscriptions%'         AS still_touches_subscriptions,
  (pg_get_functiondef(p.oid) ILIKE '%INSERT INTO public.organizations%'
   OR pg_get_functiondef(p.oid) ILIKE '%insert into organizations%')
                                                             AS still_creates_organization
FROM pg_proc p
WHERE p.proname = 'handle_new_user'
  AND p.pronamespace = 'public'::regnamespace;


-- ============================================================================
-- 11. platform_admins — protections
-- ============================================================================
-- [STATIC] Policies + grants for platform_admins. Expect: no authenticated
-- INSERT/UPDATE grant, and any policy governing writes should require
-- is_platform_admin()/service_role, never a self-referential "id = auth.uid()"
-- style check that would let a user grant themselves admin.
SELECT policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname='public' AND tablename='platform_admins';

SELECT grantee, privilege_type, string_agg(column_name, ', ') AS columns
FROM information_schema.column_privileges
WHERE table_schema='public' AND table_name='platform_admins'
  AND grantee IN ('authenticated','anon')
GROUP BY grantee, privilege_type;

SELECT pg_get_functiondef(p.oid) AS is_platform_admin_definition
FROM pg_proc p WHERE p.proname='is_platform_admin' AND p.pronamespace='public'::regnamespace;

SELECT pg_get_functiondef(p.oid) AS platform_admin_role_definition
FROM pg_proc p WHERE p.proname='platform_admin_role' AND p.pronamespace='public'::regnamespace;


-- ============================================================================
-- 12. WALLET / PAYMENT / REFUND — structures and protections
-- ============================================================================
-- [STATIC definitions] [RUNTIME REQUIRED to prove enforcement]
SELECT pg_get_functiondef(p.oid) AS wallet_balance_definition
FROM pg_proc p WHERE p.proname='wallet_balance' AND p.pronamespace='public'::regnamespace;

SELECT pg_get_functiondef(p.oid) AS wallet_can_afford_definition
FROM pg_proc p WHERE p.proname='wallet_can_afford' AND p.pronamespace='public'::regnamespace;

SELECT pg_get_functiondef(p.oid) AS debit_wallet_for_call_definition
FROM pg_proc p WHERE p.proname='debit_wallet_for_call' AND p.pronamespace='public'::regnamespace;

-- Idempotency guards relevant to billing correctness
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname='public'
  AND indexname IN ('idx_wallet_tx_call_usage_ref', 'idx_usage_records_call_kind',
                     'idx_call_logs_provider_call_id', 'idx_phone_numbers_e164_active_global');

-- Policies on the financial tables
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN ('wallet_transactions','payment_orders','payments','refunds','invoices')
ORDER BY tablename, policyname;

-- Grants on the financial tables (confirm no direct authenticated write path)
SELECT table_name, grantee, privilege_type, string_agg(column_name, ', ') AS columns
FROM information_schema.column_privileges
WHERE table_schema='public'
  AND table_name IN ('wallet_transactions','payment_orders','payments','refunds','invoices')
  AND grantee IN ('authenticated','anon')
GROUP BY table_name, grantee, privilege_type
ORDER BY table_name, grantee, privilege_type;


-- ============================================================================
-- 13. ENTITLEMENTS / FEATURE LOCKS
-- ============================================================================
-- [STATIC definitions] [RUNTIME REQUIRED to prove enforcement]
SELECT pg_get_functiondef(p.oid) AS feature_locked_definition
FROM pg_proc p WHERE p.proname='feature_locked' AND p.pronamespace='public'::regnamespace;

SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN ('organization_entitlements','organization_feature_locks')
ORDER BY tablename, policyname;

SELECT table_name, grantee, privilege_type, string_agg(column_name, ', ') AS columns
FROM information_schema.column_privileges
WHERE table_schema='public'
  AND table_name IN ('organization_entitlements','organization_feature_locks')
  AND grantee IN ('authenticated','anon')
GROUP BY table_name, grantee, privilege_type
ORDER BY table_name, grantee, privilege_type;


-- ============================================================================
-- 14. TELEPHONY — phone_numbers / call_logs security structures
-- ============================================================================
-- [STATIC]
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname='public' AND tablename IN ('phone_numbers','call_logs')
ORDER BY tablename, policyname;

SELECT table_name, grantee, privilege_type, string_agg(column_name, ', ' ORDER BY column_name) AS columns
FROM information_schema.column_privileges
WHERE table_schema='public'
  AND table_name IN ('phone_numbers','call_logs')
  AND grantee IN ('authenticated','anon')
GROUP BY table_name, grantee, privilege_type
ORDER BY table_name, grantee, privilege_type;

-- The two global uniqueness/idempotency guards specific to telephony
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname='public'
  AND indexname IN ('idx_phone_numbers_e164_active_global', 'idx_call_logs_provider_call_id');


-- ============================================================================
-- 15. PUBLIC AI — public_knowledge_base
-- ============================================================================
-- [STATIC] Policies/grants + a look at the actual seeded rows to confirm
-- Klyro AI branding (not old "Vaani" branding) and that no organization_id
-- or any tenant-scoped column exists on this table at all.
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname='public' AND tablename='public_knowledge_base';

SELECT table_name, grantee, privilege_type, string_agg(column_name, ', ' ORDER BY column_name) AS columns
FROM information_schema.column_privileges
WHERE table_schema='public' AND table_name='public_knowledge_base'
  AND grantee IN ('authenticated','anon')
GROUP BY table_name, grantee, privilege_type
ORDER BY grantee, privilege_type;

-- Confirm no tenant-scoping column exists on this table (it must be
-- impossible to join this table against anything organization-scoped).
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='public_knowledge_base'
ORDER BY ordinal_position;

-- Seeded content + branding check (read-only SELECT, no writes)
SELECT title, category, is_active, sort_order,
       (content ILIKE '%Vaani%')     AS still_has_vaani_branding,
       (content ILIKE '%Klyro AI%')  AS has_klyro_branding
FROM public.public_knowledge_base
ORDER BY sort_order;


-- ============================================================================
-- 16. PUBLIC AI — public_assistant_rate_limits
-- ============================================================================
-- [STATIC definitions] [RUNTIME REQUIRED to prove enforcement] Confirm
-- `authenticated`/`anon` have NO direct grant on this table at all (all
-- access must go through the SECURITY DEFINER increment_rate_limit()
-- function called from server code using service_role, never directly from
-- a browser client).
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname='public' AND tablename='public_assistant_rate_limits';

SELECT table_name, grantee, privilege_type, string_agg(column_name, ', ' ORDER BY column_name) AS columns
FROM information_schema.column_privileges
WHERE table_schema='public' AND table_name='public_assistant_rate_limits'
  AND grantee IN ('authenticated','anon')
GROUP BY table_name, grantee, privilege_type;

SELECT table_name, grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema='public' AND table_name='public_assistant_rate_limits'
  AND grantee IN ('authenticated','anon');

SELECT pg_get_functiondef(p.oid) AS increment_rate_limit_definition,
       p.prosecdef AS is_security_definer
FROM pg_proc p WHERE p.proname='increment_rate_limit' AND p.pronamespace='public'::regnamespace;


-- ============================================================================
-- 17. demo_requests / profile_preferences (profile_preferences columns live
--     on public.profiles per the migration — check policies on both)
-- ============================================================================
-- [STATIC]
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname='public' AND tablename IN ('demo_requests','profiles')
ORDER BY tablename, policyname;

SELECT table_name, grantee, privilege_type, string_agg(column_name, ', ' ORDER BY column_name) AS columns
FROM information_schema.column_privileges
WHERE table_schema='public' AND table_name IN ('demo_requests','profiles')
  AND grantee IN ('authenticated','anon')
GROUP BY table_name, grantee, privilege_type
ORDER BY table_name, grantee, privilege_type;


-- ============================================================================
-- 18. MIGRATION HISTORY — supabase_migrations.schema_migrations
-- ============================================================================
-- [STATIC] Confirms which migration versions Postgres/the Supabase CLI
-- bookkeeping thinks have been applied, and in what order. Compare the
-- `version` values below (they are the leading timestamp of each migration
-- filename) against the 17 filenames in supabase/migrations/ in the repo.
SELECT version, name, statements IS NOT NULL AS has_statements
FROM supabase_migrations.schema_migrations
ORDER BY version;

-- Simple count check
SELECT count(*) AS applied_migration_count
FROM supabase_migrations.schema_migrations;


-- ============================================================================
-- 19. ORGANIZATIONS — protected-column grant (customer self-edit surface)
-- ============================================================================
-- [STATIC] Confirms `authenticated` UPDATE is restricted to the narrow,
-- customer-editable column list only (see migration
-- 20260902090000_restrict_organizations_customer_update_columns.sql).
-- lifecycle_status, payment_override, client_id, account_status, crm_stage,
-- internal_notes, assigned_admin_id, owner_id, setup_paid_at, activated_at,
-- archived_at, next_billing_at, created_by_admin, locked_* must NOT appear
-- in the columns list below.
SELECT grantee, privilege_type, string_agg(column_name, ', ' ORDER BY column_name) AS updatable_columns
FROM information_schema.column_privileges
WHERE table_schema='public' AND table_name='organizations'
  AND grantee='authenticated' AND privilege_type='UPDATE'
GROUP BY grantee, privilege_type;

SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname='public' AND tablename='organizations'
ORDER BY policyname;

-- ============================================================================
-- END OF SCRIPT
-- ============================================================================
