-- Outbound gate: post-migration verification for 20261124090000 (campaign_contact_import_atomic).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261124090000'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '20261124090000') = '47d2bf311956ddcf6cc3dd8c1ba6d8b5'
    AND ((SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY column_name) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'campaign_uploads'
          AND column_name IN ('enrolled_rows', 'already_in_campaign_rows', 'opted_out_rows', 'idempotency_key'))
         = 'already_in_campaign_rows:integer,enrolled_rows:integer,idempotency_key:text,opted_out_rows:integer'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_campaign_uploads_org_idempotency_key')
         = 'CREATE UNIQUE INDEX idx_campaign_uploads_org_idempotency_key ON public.campaign_uploads USING btree (organization_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)'
     AND (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""']
            FROM pg_proc WHERE oid = to_regprocedure('public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)'))
     AND has_function_privilege('service_role', 'public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)', 'EXECUTE'))
    AND ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', ((SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY column_name) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'campaign_uploads'
          AND column_name IN ('enrolled_rows', 'already_in_campaign_rows', 'opted_out_rows', 'idempotency_key'))
         = 'already_in_campaign_rows:integer,enrolled_rows:integer,idempotency_key:text,opted_out_rows:integer'
     AND (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_campaign_uploads_org_idempotency_key')
         = 'CREATE UNIQUE INDEX idx_campaign_uploads_org_idempotency_key ON public.campaign_uploads USING btree (organization_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)'
     AND (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=""']
            FROM pg_proc WHERE oid = to_regprocedure('public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)'))
     AND has_function_privilege('service_role', 'public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb)', 'EXECUTE')),
  'outbound_safety_unchanged', ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'transaction_read_only', current_setting('transaction_read_only')
) AS gate_outbound_verify;
rollback;
