-- GATE C4-H1 verification after a rollback of 20261122090000. READ ONLY.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c4h1-verify-rollback-20261122090000.sql
begin transaction read only;
WITH c AS (
  SELECT
    (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261121090000' AS history_back_to_20261121,
    (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.campaigns'::regclass
       AND conname IN ('campaigns_retry_statuses_allowed', 'campaigns_retry_after_minutes_range')) = 0 AS constraints_removed,
    to_regprocedure('public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer, timestamptz, text, text)') IS NOT NULL AS gate_c1_engine_intact,
    EXISTS (SELECT 1 FROM public.platform_settings WHERE key = 'outbound.calling_paused') AS emergency_stop_setting_intact
)
SELECT json_build_object(
  'all_pass', history_back_to_20261121 AND constraints_removed AND gate_c1_engine_intact AND emergency_stop_setting_intact,
  'checks', to_jsonb(c)
) AS gate_c4h1_verify_rollback
FROM c;
rollback;
