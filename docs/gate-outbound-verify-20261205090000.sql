-- Outbound gate: post-migration verification for 20261205090000 (business_setup_save).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261205090000'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '20261205090000') = '227c7c32cfb4b57d527b326b016dc255'
    AND ((SELECT NOT prosecdef AND proconfig = ARRAY['search_path=public'] FROM pg_proc WHERE oid = to_regprocedure('public.save_business_setup(uuid, jsonb, jsonb)'))
     AND has_function_privilege('authenticated', 'public.save_business_setup(uuid, jsonb, jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.save_business_setup(uuid, jsonb, jsonb)', 'EXECUTE') AND (SELECT NOT prosecdef AND proconfig = ARRAY['search_path=public'] FROM pg_proc WHERE oid = to_regprocedure('public.lock_business_setup(uuid)'))
     AND has_function_privilege('authenticated', 'public.lock_business_setup(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.lock_business_setup(uuid)', 'EXECUTE')),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', ((SELECT NOT prosecdef AND proconfig = ARRAY['search_path=public'] FROM pg_proc WHERE oid = to_regprocedure('public.save_business_setup(uuid, jsonb, jsonb)'))
     AND has_function_privilege('authenticated', 'public.save_business_setup(uuid, jsonb, jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.save_business_setup(uuid, jsonb, jsonb)', 'EXECUTE') AND (SELECT NOT prosecdef AND proconfig = ARRAY['search_path=public'] FROM pg_proc WHERE oid = to_regprocedure('public.lock_business_setup(uuid)'))
     AND has_function_privilege('authenticated', 'public.lock_business_setup(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.lock_business_setup(uuid)', 'EXECUTE')),
  'transaction_read_only', current_setting('transaction_read_only')
) AS gate_outbound_verify;
rollback;
