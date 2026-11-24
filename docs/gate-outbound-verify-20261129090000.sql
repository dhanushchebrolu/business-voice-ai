-- Outbound gate: post-migration verification for 20261129090000 (campaign_dispatch_authorization).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261129090000'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '20261129090000') = '7319c983d7a34f7688f5f7ed511969ae'
    AND ((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations'
         AND column_name IN ('campaign_dispatch_enabled')) = 'campaign_dispatch_enabled:boolean:NO:false'
     AND (SELECT count(*) FROM public.organizations WHERE campaign_dispatch_enabled) = 0
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""']
            FROM pg_proc WHERE oid = to_regprocedure('public.guard_campaign_dispatch_enabled()'))
     AND NOT has_function_privilege('authenticated', 'public.guard_campaign_dispatch_enabled()', 'EXECUTE')
     AND (SELECT tgenabled = 'O' AND tgrelid = 'public.organizations'::regclass FROM pg_trigger WHERE tgname = 'trg_organizations_campaign_dispatch_guard'))
    AND ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', ((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations'
         AND column_name IN ('campaign_dispatch_enabled')) = 'campaign_dispatch_enabled:boolean:NO:false'
     AND (SELECT count(*) FROM public.organizations WHERE campaign_dispatch_enabled) = 0
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""']
            FROM pg_proc WHERE oid = to_regprocedure('public.guard_campaign_dispatch_enabled()'))
     AND NOT has_function_privilege('authenticated', 'public.guard_campaign_dispatch_enabled()', 'EXECUTE')
     AND (SELECT tgenabled = 'O' AND tgrelid = 'public.organizations'::regclass FROM pg_trigger WHERE tgname = 'trg_organizations_campaign_dispatch_guard')),
  'outbound_safety_unchanged', ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'transaction_read_only', current_setting('transaction_read_only')
) AS gate_outbound_verify;
rollback;
