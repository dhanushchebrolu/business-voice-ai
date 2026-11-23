-- Outbound gate: post-migration verification for 20261125090000 (campaign_tenant_integrity).
-- READ ONLY: a read-only transaction that rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
begin transaction read only;
SELECT json_build_object(
  'all_pass', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684'
    AND (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261125090000'
    AND (SELECT md5(statements[1]) FROM supabase_migrations.schema_migrations WHERE version = '20261125090000') = '6db67125c241cfcf86fd9aa95bf6608e'
    AND ((SELECT count(*) FROM pg_constraint k WHERE k.conrelid = 'public.campaign_contacts'::regclass AND k.contype = 'f' AND k.confrelid = 'public.campaigns'::regclass) = 1
     AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = 'public.campaign_contacts'::regclass AND k.conname = 'campaign_contacts_campaign_id_fkey' AND k.contype = 'f'
           AND k.confrelid = 'public.campaigns'::regclass AND k.confdeltype = 'c' AND k.convalidated
           AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['campaign_id', 'organization_id'] AND ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['id', 'organization_id'])
     AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = 'public.campaign_contacts'::regclass AND k.contype = 'f' AND k.confrelid = 'public.contacts'::regclass) = 1
     AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = 'public.campaign_contacts'::regclass AND k.conname = 'campaign_contacts_contact_id_fkey' AND k.contype = 'f'
           AND k.confrelid = 'public.contacts'::regclass AND k.confdeltype = 'c' AND k.convalidated
           AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['contact_id', 'organization_id'] AND ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['id', 'organization_id'])
     AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = 'public.campaign_uploads'::regclass AND k.contype = 'f' AND k.confrelid = 'public.campaigns'::regclass) = 1
     AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = 'public.campaign_uploads'::regclass AND k.conname = 'campaign_uploads_campaign_id_fkey' AND k.contype = 'f'
           AND k.confrelid = 'public.campaigns'::regclass AND k.confdeltype = 'c' AND k.convalidated
           AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['campaign_id', 'organization_id'] AND ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['id', 'organization_id'])
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.campaigns'::regclass AND conname = 'campaigns_id_organization_id_key') = 'UNIQUE (id, organization_id)'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.contacts'::regclass AND conname = 'contacts_id_organization_id_key') = 'UNIQUE (id, organization_id)')
    AND ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'objects_present', ((SELECT count(*) FROM pg_constraint k WHERE k.conrelid = 'public.campaign_contacts'::regclass AND k.contype = 'f' AND k.confrelid = 'public.campaigns'::regclass) = 1
     AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = 'public.campaign_contacts'::regclass AND k.conname = 'campaign_contacts_campaign_id_fkey' AND k.contype = 'f'
           AND k.confrelid = 'public.campaigns'::regclass AND k.confdeltype = 'c' AND k.convalidated
           AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['campaign_id', 'organization_id'] AND ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['id', 'organization_id'])
     AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = 'public.campaign_contacts'::regclass AND k.contype = 'f' AND k.confrelid = 'public.contacts'::regclass) = 1
     AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = 'public.campaign_contacts'::regclass AND k.conname = 'campaign_contacts_contact_id_fkey' AND k.contype = 'f'
           AND k.confrelid = 'public.contacts'::regclass AND k.confdeltype = 'c' AND k.convalidated
           AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['contact_id', 'organization_id'] AND ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['id', 'organization_id'])
     AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = 'public.campaign_uploads'::regclass AND k.contype = 'f' AND k.confrelid = 'public.campaigns'::regclass) = 1
     AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = 'public.campaign_uploads'::regclass AND k.conname = 'campaign_uploads_campaign_id_fkey' AND k.contype = 'f'
           AND k.confrelid = 'public.campaigns'::regclass AND k.confdeltype = 'c' AND k.convalidated
           AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['campaign_id', 'organization_id'] AND ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.o) = ARRAY['id', 'organization_id'])
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.campaigns'::regclass AND conname = 'campaigns_id_organization_id_key') = 'UNIQUE (id, organization_id)'
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.contacts'::regclass AND conname = 'contacts_id_organization_id_key') = 'UNIQUE (id, organization_id)'),
  'outbound_safety_unchanged', ((SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb
     AND (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0
     AND (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0
     AND (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb),
  'transaction_read_only', current_setting('transaction_read_only')
) AS gate_outbound_verify;
rollback;
