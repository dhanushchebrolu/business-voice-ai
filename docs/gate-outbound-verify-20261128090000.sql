-- Outbound gate: post-migration verification for 20261128090000 (call_billing_hold).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261128090000'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '20261128090000') = '9b6a7117a6b146ad3dcf9443f61ea1f7'
    AND ((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'call_logs'
         AND column_name IN ('billing_hold')) = 'billing_hold:text:YES:-'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.call_logs'::regclass AND conname = 'call_logs_billing_hold_check' AND convalidated)
         = 'CHECK (((billing_hold IS NULL) OR (billing_hold = ''duration_unknown''::text)))'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_call_logs_billing_hold')
         = 'CREATE INDEX idx_call_logs_billing_hold ON public.call_logs USING btree (started_at) WHERE (billing_hold IS NOT NULL)'
     AND has_column_privilege('authenticated', 'public.call_logs', 'billing_hold', 'SELECT')
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""']
            FROM pg_proc WHERE oid = to_regprocedure('public.verify_call_duration(uuid, integer)'))
     AND has_function_privilege('service_role', to_regprocedure('public.verify_call_duration(uuid, integer)'), 'EXECUTE')
     AND NOT has_function_privilege('anon', to_regprocedure('public.verify_call_duration(uuid, integer)'), 'EXECUTE')
     AND NOT has_function_privilege('authenticated', to_regprocedure('public.verify_call_duration(uuid, integer)'), 'EXECUTE')
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""'] AND position('BILLING_ON_HOLD' in (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text)'))) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text)'))
     AND has_function_privilege('service_role', to_regprocedure('public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text)'), 'EXECUTE')
     AND NOT has_function_privilege('anon', to_regprocedure('public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text)'), 'EXECUTE')
     AND NOT has_function_privilege('authenticated', to_regprocedure('public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text)'), 'EXECUTE')
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""'] AND position('billing_hold' in (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'))) > 0
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
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'call_logs'
         AND column_name IN ('billing_hold')) = 'billing_hold:text:YES:-'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.call_logs'::regclass AND conname = 'call_logs_billing_hold_check' AND convalidated)
         = 'CHECK (((billing_hold IS NULL) OR (billing_hold = ''duration_unknown''::text)))'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_call_logs_billing_hold')
         = 'CREATE INDEX idx_call_logs_billing_hold ON public.call_logs USING btree (started_at) WHERE (billing_hold IS NOT NULL)'
     AND has_column_privilege('authenticated', 'public.call_logs', 'billing_hold', 'SELECT')
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""']
            FROM pg_proc WHERE oid = to_regprocedure('public.verify_call_duration(uuid, integer)'))
     AND has_function_privilege('service_role', to_regprocedure('public.verify_call_duration(uuid, integer)'), 'EXECUTE')
     AND NOT has_function_privilege('anon', to_regprocedure('public.verify_call_duration(uuid, integer)'), 'EXECUTE')
     AND NOT has_function_privilege('authenticated', to_regprocedure('public.verify_call_duration(uuid, integer)'), 'EXECUTE')
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""'] AND position('BILLING_ON_HOLD' in (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text)'))) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text)'))
     AND has_function_privilege('service_role', to_regprocedure('public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text)'), 'EXECUTE')
     AND NOT has_function_privilege('anon', to_regprocedure('public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text)'), 'EXECUTE')
     AND NOT has_function_privilege('authenticated', to_regprocedure('public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text)'), 'EXECUTE')
     AND (SELECT NOT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""'] AND position('billing_hold' in (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.apply_call_event_fenced(text, text, uuid, uuid, jsonb)'))) > 0
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
