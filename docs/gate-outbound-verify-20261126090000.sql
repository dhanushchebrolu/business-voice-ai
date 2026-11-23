-- Outbound gate: post-migration verification for 20261126090000 (webhook_event_claim_lease).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261126090000'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '20261126090000') = '7979494eb06c7fbb014448a8c3bafb6f'
    AND ((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'webhook_events'
         AND column_name IN ('claim_token', 'claimed_at', 'attempts'))
         = 'attempts:integer:NO:0,claim_token:uuid:YES:-,claimed_at:timestamp with time zone:YES:-'
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""']
            FROM pg_proc WHERE oid = to_regprocedure('public.claim_webhook_event(text, text, text, jsonb, integer, integer)'))
     AND has_function_privilege('service_role', to_regprocedure('public.claim_webhook_event(text, text, text, jsonb, integer, integer)'), 'EXECUTE')
     AND NOT has_function_privilege('anon', to_regprocedure('public.claim_webhook_event(text, text, text, jsonb, integer, integer)'), 'EXECUTE')
     AND NOT has_function_privilege('authenticated', to_regprocedure('public.claim_webhook_event(text, text, text, jsonb, integer, integer)'), 'EXECUTE')
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""'] AND NOT position('billing_hold' in (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'))) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'))
     AND has_function_privilege('service_role', to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'), 'EXECUTE')
     AND NOT has_function_privilege('anon', to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'), 'EXECUTE')
     AND NOT has_function_privilege('authenticated', to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'), 'EXECUTE'))
    AND ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', ((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'webhook_events'
         AND column_name IN ('claim_token', 'claimed_at', 'attempts'))
         = 'attempts:integer:NO:0,claim_token:uuid:YES:-,claimed_at:timestamp with time zone:YES:-'
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""']
            FROM pg_proc WHERE oid = to_regprocedure('public.claim_webhook_event(text, text, text, jsonb, integer, integer)'))
     AND has_function_privilege('service_role', to_regprocedure('public.claim_webhook_event(text, text, text, jsonb, integer, integer)'), 'EXECUTE')
     AND NOT has_function_privilege('anon', to_regprocedure('public.claim_webhook_event(text, text, text, jsonb, integer, integer)'), 'EXECUTE')
     AND NOT has_function_privilege('authenticated', to_regprocedure('public.claim_webhook_event(text, text, text, jsonb, integer, integer)'), 'EXECUTE')
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""'] AND NOT position('billing_hold' in (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'))) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'))
     AND has_function_privilege('service_role', to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'), 'EXECUTE')
     AND NOT has_function_privilege('anon', to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'), 'EXECUTE')
     AND NOT has_function_privilege('authenticated', to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'), 'EXECUTE')),
  'outbound_safety_unchanged', ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'transaction_read_only', current_setting('transaction_read_only')
) AS gate_outbound_verify;
rollback;
