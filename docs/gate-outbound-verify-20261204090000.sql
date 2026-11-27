-- Outbound gate: post-migration verification for 20261204090000 (operator_bridge_token_scope).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261204090000'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '20261204090000') = '4a7926ac665ca32e7084c7f70470cdd3'
    AND ((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operator_bridge_tokens'
         AND column_name IN ('agent_role', 'organization_id', 'run_id')) = 'agent_role:text:YES:-,organization_id:uuid:YES:-,run_id:uuid:YES:-'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.operator_bridge_tokens'::regclass AND conname = 'operator_bridge_tokens_run_of_customer' AND convalidated) LIKE 'FOREIGN KEY (run_id, organization_id) REFERENCES %provisioning_runs(id, organization_id) ON DELETE CASCADE'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.operator_bridge_tokens'::regclass AND conname = 'operator_bridge_tokens_role' AND convalidated) IS NOT NULL
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.operator_bridge_tokens'::regclass AND conname = 'operator_bridge_tokens_scoped' AND convalidated) IS NOT NULL
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_provisioning_runs_id_org') LIKE 'CREATE UNIQUE INDEX %'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_operator_bridge_tokens_one_live') LIKE 'CREATE UNIQUE INDEX %'
     AND NOT EXISTS (SELECT 1 FROM public.operator_bridge_tokens t WHERE t.revoked_at IS NULL
           AND (to_jsonb(t) ->> 'organization_id' IS NULL OR to_jsonb(t) ->> 'run_id' IS NULL))),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', ((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY column_name)
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operator_bridge_tokens'
         AND column_name IN ('agent_role', 'organization_id', 'run_id')) = 'agent_role:text:YES:-,organization_id:uuid:YES:-,run_id:uuid:YES:-'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.operator_bridge_tokens'::regclass AND conname = 'operator_bridge_tokens_run_of_customer' AND convalidated) LIKE 'FOREIGN KEY (run_id, organization_id) REFERENCES %provisioning_runs(id, organization_id) ON DELETE CASCADE'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.operator_bridge_tokens'::regclass AND conname = 'operator_bridge_tokens_role' AND convalidated) IS NOT NULL
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.operator_bridge_tokens'::regclass AND conname = 'operator_bridge_tokens_scoped' AND convalidated) IS NOT NULL
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_provisioning_runs_id_org') LIKE 'CREATE UNIQUE INDEX %'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_operator_bridge_tokens_one_live') LIKE 'CREATE UNIQUE INDEX %'
     AND NOT EXISTS (SELECT 1 FROM public.operator_bridge_tokens t WHERE t.revoked_at IS NULL
           AND (to_jsonb(t) ->> 'organization_id' IS NULL OR to_jsonb(t) ->> 'run_id' IS NULL))),
  'transaction_read_only', current_setting('transaction_read_only')
) AS gate_outbound_verify;
rollback;
