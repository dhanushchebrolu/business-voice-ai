-- ============================================================
-- READ-ONLY production checks (no writes; safe to run in the SQL editor).
-- Wrapped in a read-only transaction that is rolled back: PostgreSQL
-- refuses any write inside it ("cannot execute ... in a read-only
-- transaction"). Run the whole file, or one section at a time.
--
-- Part A: is BYPASS_BILLING_GATES effectively on? (evidence from data)
-- Part B: what did 20261025090000_whatsapp_vobiz_onboarding change, and
--         does it collide with 20261027090000 / 20261028090000?
-- ============================================================

BEGIN READ ONLY;

-- ------------------------------------------------------------
-- A. Billing bypass evidence
--
-- Fact: has_function_privilege('service_role', feature_locked) = false.
-- So every server-side gate check (checkFeatureAccess via supabaseAdmin)
-- can ONLY pass when BYPASS_BILLING_GATES is exactly "true"; otherwise it
-- fails with "Could not evaluate <Feature> entitlement."
-- These rows show the state at the time of each event, not necessarily now.
-- ------------------------------------------------------------

-- A0. Confirm the privilege is still missing (the inference depends on it).
SELECT has_function_privilege('service_role', 'public.feature_locked(uuid,text)', 'EXECUTE')
  AS service_role_can_execute_feature_locked;

-- A1. Calls refused by the gate because it couldn't be evaluated
--     (Exotel/Sarvam webhook records gate.reason in failure_reason).
--     Any recent row => bypass was OFF at that time.
SELECT date_trunc('day', started_at) AS day, provider, direction, count(*) AS calls,
       max(started_at) AS latest
  FROM public.call_logs
 WHERE failure_reason ILIKE 'Could not evaluate%entitlement%'
   AND started_at > now() - interval '30 days'
 GROUP BY 1, 2, 3 ORDER BY 1 DESC;

-- A2. Calls that passed the gate (anything but a gate failure).
--     Any recent row => bypass was ON at that time (the gate cannot pass otherwise).
SELECT date_trunc('day', started_at) AS day, provider, direction, status, count(*) AS calls,
       max(started_at) AS latest
  FROM public.call_logs
 WHERE started_at > now() - interval '30 days'
   AND (failure_reason IS NULL OR failure_reason NOT ILIKE 'Could not evaluate%')
 GROUP BY 1, 2, 3, 4 ORDER BY 1 DESC
 LIMIT 50;

-- A3. Most recent single call either way (the closest data point to "now").
SELECT started_at, provider, direction, status,
       (failure_reason ILIKE 'Could not evaluate%') AS refused_by_unevaluable_gate
  FROM public.call_logs ORDER BY started_at DESC LIMIT 5;

-- ------------------------------------------------------------
-- B. Reconcile 20261025090000_whatsapp_vobiz_onboarding
-- ------------------------------------------------------------

-- B1. Full applied history (expect the 47 known versions + 20261025090000).
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;

-- B2. The exact SQL 20261025 executed, as recorded by the Supabase CLI
--     (null if it was applied another way, e.g. pasted into the SQL editor).
SELECT version, name, statements
  FROM supabase_migrations.schema_migrations WHERE version = '20261025090000';

-- B3. Columns 20261027/20261028 add, if they already exist (from 20261025).
--     Expect NO rows. Any row = same-named column whose type/default/nullability
--     must match 20261027/28 exactly, or their ADD COLUMN IF NOT EXISTS keeps it as is.
SELECT table_name, column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name = 'whatsapp_connections' AND column_name IN
          ('provider', 'vobiz_channel_id', 'number_onboarding_mode',
           'vobiz_number_order_id', 'inventory_number_id'))
     OR (table_name = 'phone_numbers' AND column_name IN ('voice_capable', 'whatsapp_capable'))
     OR (table_name = 'whatsapp_number_orders'))
 ORDER BY table_name, column_name;

-- B4. Every Vobiz/WhatsApp column and table that exists now (to see what 20261025 added).
SELECT table_name, column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND (table_name ILIKE '%vobiz%' OR column_name ILIKE '%vobiz%'
        OR table_name ILIKE 'whatsapp%')
 ORDER BY table_name, ordinal_position;

-- B5. Same-named constraints (expect none of these names before 20261027/28).
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conname IN ('whatsapp_connections_provider_check',
                   'whatsapp_connections_vobiz_channel_check',
                   'whatsapp_connections_onboarding_mode_check',
                   'phone_numbers_capability_check',
                   'phone_numbers_whatsapp_only_assigned_check')
    OR conrelid = 'public.whatsapp_connections'::regclass;

-- B6. Same-named or Vobiz indexes.
SELECT tablename, indexname, indexdef FROM pg_indexes
 WHERE schemaname = 'public'
   AND (indexname IN ('idx_whatsapp_connections_vobiz_channel_live',
                      'idx_whatsapp_number_orders_one_live',
                      'idx_whatsapp_number_orders_org',
                      'idx_whatsapp_number_orders_one_live_number',
                      'idx_whatsapp_number_orders_inventory',
                      'idx_whatsapp_connections_inventory_live',
                      'idx_whatsapp_connections_number_key_live',
                      'idx_phone_numbers_whatsapp_e164_held',
                      'idx_phone_numbers_number_key')
        OR indexdef ILIKE '%vobiz%');

-- B7. Same-named or Vobiz/WhatsApp functions, triggers and policies.
SELECT 'function' AS kind, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND (p.proname IN ('phone_number_key', 'enforce_whatsapp_connection_number_owner',
                      'enforce_phone_number_whatsapp_owner', 'record_whatsapp_number_purchase')
        OR p.proname ILIKE '%vobiz%')
UNION ALL
SELECT 'trigger', tgrelid::regclass || '.' || tgname
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgrelid IN ('public.whatsapp_connections'::regclass, 'public.phone_numbers'::regclass)
UNION ALL
SELECT 'policy', tablename || '.' || policyname
  FROM pg_policies
 WHERE schemaname = 'public' AND (tablename ILIKE 'whatsapp%' OR tablename ILIKE '%vobiz%')
 ORDER BY 1, 2;

-- B8. Column-level grants browsers have on whatsapp_connections (20261027 adds
--     provider, number_onboarding_mode; 20261028 adds inventory_number_id).
SELECT grantee, column_name, privilege_type
  FROM information_schema.column_privileges
 WHERE table_schema = 'public' AND table_name = 'whatsapp_connections'
   AND grantee IN ('authenticated', 'anon')
 ORDER BY grantee, column_name;

-- B9. Existing WhatsApp connections (is the Vobiz Console's channel recorded?).
--     Uses only columns that exist since 20260923090000.
SELECT id, organization_id, status, waba_id, phone_number_id, display_phone_number,
       created_at, metadata ? 'vobiz_channel_id' AS metadata_has_vobiz_channel_id
  FROM public.whatsapp_connections ORDER BY created_at DESC;

-- B10. Pre-check for 20261028's ownership rules (expect no rows).
SELECT p.e164, p.organization_id AS inventory_org, c.organization_id AS whatsapp_org
  FROM public.phone_numbers p
  JOIN public.whatsapp_connections c
    ON regexp_replace(coalesce(c.display_phone_number, ''), '[^0-9]', '', 'g')
     = regexp_replace(p.e164, '[^0-9]', '', 'g')
 WHERE c.status <> 'disconnected'
   AND p.status NOT IN ('released', 'failed')
   AND p.organization_id IS DISTINCT FROM c.organization_id;

-- B11. Pre-check for 20261028's one-live-order-per-NUMBER index (expect an
--      empty result). 20261027 allows one live order per organization and
--      number; 20261028 adds idx_whatsapp_number_orders_one_live_number (one
--      per number across all organizations), which FAILS TO APPLY while two
--      organizations hold live orders for the same number. Resolve any row
--      listed here before applying 20261028. NULL when
--      whatsapp_number_orders doesn't exist yet (20261027 not applied):
--      there is nothing to check.
SELECT CASE WHEN to_regclass('public.whatsapp_number_orders') IS NOT NULL THEN
  query_to_xml(
    $q$SELECT phone_number,
              count(*) AS live_orders,
              count(DISTINCT organization_id) AS organizations
         FROM public.whatsapp_number_orders
        WHERE status IN ('requested', 'pending', 'completed', 'unknown')
        GROUP BY phone_number
       HAVING count(*) > 1$q$,
    true, false, '')
END AS duplicate_live_orders_per_number;

ROLLBACK;
