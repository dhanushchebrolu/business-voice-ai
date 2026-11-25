-- Outbound gate: post-migration verification for 20261203090000 (voice_provisioning_job).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261203090000'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '20261203090000') = 'd1bddf1a38b069f6256fe7ff34cc810a'
    AND ((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'provisioning_runs'
         AND column_name IN ('step_states', 'current_job_step', 'last_checkpoint', 'failure_code', 'retryable', 'next_attempt_at', 'max_attempts', 'diagnostics', 'customer_message', 'idempotency_key', 'sarvam_agent_id'))
         = 'current_job_step:text:YES:-,customer_message:text:YES:-,diagnostics:jsonb:YES:-,failure_code:text:YES:-,idempotency_key:text:YES:-,last_checkpoint:text:YES:-,max_attempts:integer:NO:5,next_attempt_at:timestamp with time zone:YES:-,retryable:boolean:YES:-,sarvam_agent_id:text:YES:-,step_states:jsonb:NO:''{}''::jsonb'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_provisioning_runs_one_active_number') LIKE 'CREATE UNIQUE INDEX idx_provisioning_runs_one_active_number ON public.provisioning_runs USING btree (phone_number_id) WHERE %'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_provisioning_runs_due') LIKE 'CREATE INDEX idx_provisioning_runs_due ON public.provisioning_runs USING btree (next_attempt_at) WHERE %'
     AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provisioning_run_events'::regclass)
     AND has_table_privilege('service_role', 'public.provisioning_run_events', 'SELECT')
     AND has_table_privilege('service_role', 'public.provisioning_run_events', 'INSERT')
     AND NOT has_table_privilege('service_role', 'public.provisioning_run_events', 'UPDATE')
     AND NOT has_table_privilege('service_role', 'public.provisioning_run_events', 'DELETE')
     AND NOT has_table_privilege('anon', 'public.provisioning_run_events', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.provisioning_run_events', 'SELECT')
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.provisioning_runs'::regclass AND conname = 'provisioning_runs_max_attempts_check' AND convalidated) IS NOT NULL)
    AND ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', ((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'provisioning_runs'
         AND column_name IN ('step_states', 'current_job_step', 'last_checkpoint', 'failure_code', 'retryable', 'next_attempt_at', 'max_attempts', 'diagnostics', 'customer_message', 'idempotency_key', 'sarvam_agent_id'))
         = 'current_job_step:text:YES:-,customer_message:text:YES:-,diagnostics:jsonb:YES:-,failure_code:text:YES:-,idempotency_key:text:YES:-,last_checkpoint:text:YES:-,max_attempts:integer:NO:5,next_attempt_at:timestamp with time zone:YES:-,retryable:boolean:YES:-,sarvam_agent_id:text:YES:-,step_states:jsonb:NO:''{}''::jsonb'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_provisioning_runs_one_active_number') LIKE 'CREATE UNIQUE INDEX idx_provisioning_runs_one_active_number ON public.provisioning_runs USING btree (phone_number_id) WHERE %'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_provisioning_runs_due') LIKE 'CREATE INDEX idx_provisioning_runs_due ON public.provisioning_runs USING btree (next_attempt_at) WHERE %'
     AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provisioning_run_events'::regclass)
     AND has_table_privilege('service_role', 'public.provisioning_run_events', 'SELECT')
     AND has_table_privilege('service_role', 'public.provisioning_run_events', 'INSERT')
     AND NOT has_table_privilege('service_role', 'public.provisioning_run_events', 'UPDATE')
     AND NOT has_table_privilege('service_role', 'public.provisioning_run_events', 'DELETE')
     AND NOT has_table_privilege('anon', 'public.provisioning_run_events', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.provisioning_run_events', 'SELECT')
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.provisioning_runs'::regclass AND conname = 'provisioning_runs_max_attempts_check' AND convalidated) IS NOT NULL),
  'outbound_safety_unchanged', ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'transaction_read_only', current_setting('transaction_read_only')
) AS gate_outbound_verify;
rollback;
