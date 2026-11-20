-- GATE C1 verification after a rollback of 20261121090000. READ ONLY.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c1-verify-rollback-20261121090000.sql
begin transaction read only;
WITH c AS (
  SELECT
    (SELECT max(version) FROM supabase_migrations.schema_migrations) = '20261120090000' AS history_back_to_20261120,
    (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
       AND ((table_name = 'campaigns' AND column_name IN ('description', 'context', 'context_version', 'context_reviewed_at', 'context_reviewed_by', 'budget_limit'))
         OR (table_name = 'campaign_contacts' AND column_name = 'excluded_reason')
         OR (table_name = 'call_logs' AND column_name = 'campaign_context_snapshot'))) = 0 AS columns_removed,
    (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('admit_campaign_outbound_call', 'within_outbound_calling_hours', 'outbound_admission_now', 'call_logs_context_snapshot_immutable')) = 0 AS functions_removed,
    NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_call_logs_context_snapshot_immutable') AS trigger_removed,
    (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admit_single_outbound_call')
      = '27780f3d2d6f761bb553cc5ea825ee22' AS single_admission_restored,
    (has_function_privilege('service_role', 'public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)', 'EXECUTE')) AS single_admission_service_role_only,
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.campaign_contacts'::regclass AND conname = 'campaign_contacts_status_check')
      NOT LIKE '%excluded%' AS contact_status_restored,
    (SELECT count(*) FROM public.campaign_contacts WHERE status = 'excluded') = 0 AS no_excluded_contacts,
    NOT EXISTS (SELECT 1 FROM public.platform_settings WHERE key = 'outbound.calling_paused') AS stop_setting_removed,
    (SELECT relacl::text FROM pg_class WHERE oid = 'public.campaigns'::regclass)
      = '{postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=arwd/postgres}' AS campaigns_table_acl,
    (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0 AS no_outbound_number
)
SELECT json_build_object(
  'all_pass', history_back_to_20261120 AND columns_removed AND functions_removed AND trigger_removed AND single_admission_restored
    AND single_admission_service_role_only AND contact_status_restored AND no_excluded_contacts AND stop_setting_removed
    AND campaigns_table_acl,
  'no_outbound_number', no_outbound_number,
  'checks', to_jsonb(c)
) AS gate_c1_verify_rollback
FROM c;
rollback;
