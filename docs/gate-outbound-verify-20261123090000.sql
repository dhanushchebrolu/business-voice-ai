-- Outbound gate: post-migration verification for 20261123090000 (campaign_creation_idempotency).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261123090000'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '20261123090000') = '738ed34d0dd6d7cccb580f005fa38fc9'
    AND ((SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaigns' AND column_name = 'idempotency_key') = 'text'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_campaigns_org_idempotency_key')
         = 'CREATE UNIQUE INDEX idx_campaigns_org_idempotency_key ON public.campaigns USING btree (organization_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)')
    AND ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', ((SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaigns' AND column_name = 'idempotency_key') = 'text'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_campaigns_org_idempotency_key')
         = 'CREATE UNIQUE INDEX idx_campaigns_org_idempotency_key ON public.campaigns USING btree (organization_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)'),
  'outbound_safety_unchanged', ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'transaction_read_only', current_setting('transaction_read_only')
) AS gate_outbound_verify;
rollback;
