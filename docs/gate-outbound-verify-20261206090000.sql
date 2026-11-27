-- Outbound gate: post-migration verification for 20261206090000 (business_setup_guard).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261206090000'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '20261206090000') = '23c4cd5992ae1be390b353dd1e912093'
    AND ((SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_businesses_one_per_customer' AND tgrelid = 'public.businesses'::regclass AND tgenabled = 'O') = 1 AND (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_agent_configs_one_per_customer' AND tgrelid = 'public.agent_configs'::regclass AND tgenabled = 'O') = 1
     AND (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.one_setup_per_customer()'))
     AND NOT has_function_privilege('authenticated', 'public.one_setup_per_customer()', 'EXECUTE')),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', ((SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_businesses_one_per_customer' AND tgrelid = 'public.businesses'::regclass AND tgenabled = 'O') = 1 AND (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_agent_configs_one_per_customer' AND tgrelid = 'public.agent_configs'::regclass AND tgenabled = 'O') = 1
     AND (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.one_setup_per_customer()'))
     AND NOT has_function_privilege('authenticated', 'public.one_setup_per_customer()', 'EXECUTE')),
  'transaction_read_only', current_setting('transaction_read_only')
) AS gate_outbound_verify;
rollback;
