-- Outbound gate: post-migration verification for 20261127090000 (wallet_ledger_integrity).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261127090000'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '20261127090000') = '803f7f2a1ce634ddc3caaa46eb589622'
    AND ((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'wallet_transactions'
         AND column_name IN ('idempotency_key')) = 'idempotency_key:text:YES:-'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.wallet_transactions'::regclass AND conname = 'wallet_tx_idempotency_key_format' AND convalidated)
         = 'CHECK (((idempotency_key IS NULL) OR (idempotency_key ~ ''^[A-Za-z0-9_-]{16,100}$''::text)))'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.wallet_transactions'::regclass AND conname = 'wallet_tx_call_usage_has_reference' AND convalidated)
         = 'CHECK (((kind <> ''call_usage''::text) OR (reference IS NOT NULL)))'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_wallet_tx_idempotency_key')
         = 'CREATE UNIQUE INDEX idx_wallet_tx_idempotency_key ON public.wallet_transactions USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_wallet_tx_call_usage_ref') = 'CREATE UNIQUE INDEX idx_wallet_tx_call_usage_ref ON public.wallet_transactions USING btree (organization_id, reference) WHERE (kind = ''call_usage''::text)')
    AND ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', ((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'wallet_transactions'
         AND column_name IN ('idempotency_key')) = 'idempotency_key:text:YES:-'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.wallet_transactions'::regclass AND conname = 'wallet_tx_idempotency_key_format' AND convalidated)
         = 'CHECK (((idempotency_key IS NULL) OR (idempotency_key ~ ''^[A-Za-z0-9_-]{16,100}$''::text)))'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.wallet_transactions'::regclass AND conname = 'wallet_tx_call_usage_has_reference' AND convalidated)
         = 'CHECK (((kind <> ''call_usage''::text) OR (reference IS NOT NULL)))'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_wallet_tx_idempotency_key')
         = 'CREATE UNIQUE INDEX idx_wallet_tx_idempotency_key ON public.wallet_transactions USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_wallet_tx_call_usage_ref') = 'CREATE UNIQUE INDEX idx_wallet_tx_call_usage_ref ON public.wallet_transactions USING btree (organization_id, reference) WHERE (kind = ''call_usage''::text)'),
  'outbound_safety_unchanged', ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'transaction_read_only', current_setting('transaction_read_only')
) AS gate_outbound_verify;
rollback;
