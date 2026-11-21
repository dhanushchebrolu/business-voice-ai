-- GATE C4-H1 post-migration verification for 20261122090000 (campaign retry limits).
-- READ ONLY: runs inside a read-only transaction and rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c4h1-verify-20261122090000.sql
begin transaction read only;
WITH c AS (
  SELECT
    (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261122090000' AS history_latest,
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.campaigns'::regclass
       AND conname = 'campaigns_retry_statuses_allowed' AND convalidated)
      = 'CHECK ((retry_statuses <@ ARRAY[''no_answer''::text, ''busy''::text, ''failed''::text]))' AS retry_statuses_constraint,
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.campaigns'::regclass
       AND conname = 'campaigns_retry_after_minutes_range' AND convalidated)
      = 'CHECK (((retry_after_minutes >= 15) AND (retry_after_minutes <= 10080)))' AS retry_after_constraint,
    (SELECT count(*) FROM public.campaigns
      WHERE NOT (retry_statuses <@ ARRAY['no_answer', 'busy', 'failed']::text[])
         OR retry_after_minutes NOT BETWEEN 15 AND 10080) = 0 AS every_campaign_within_limits,
    -- Unchanged by this gate:
    (SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb AS emergency_stop_off,
    (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0 AS no_outbound_number,
    (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0 AS no_campaign_running,
    (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb AS payment_enforcement_unchanged
)
SELECT json_build_object(
  'all_pass', history_latest AND retry_statuses_constraint AND retry_after_constraint AND every_campaign_within_limits
    AND emergency_stop_off AND no_outbound_number AND no_campaign_running AND payment_enforcement_unchanged,
  'checks', to_jsonb(c)
) AS gate_c4h1_verify
FROM c;
rollback;
