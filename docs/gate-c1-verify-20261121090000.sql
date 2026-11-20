-- GATE C1 post-migration verification for 20261121090000 (campaign context engine).
-- READ ONLY: runs inside a read-only transaction and rolls back. Safe to run any time.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/gate-c1-verify-20261121090000.sql
-- Every check is true when it passes; all_pass is their conjunction.
-- Not visible to SQL (check separately, see docs/gate-c1-execution-plan.md §4):
-- the Worker's CAMPAIGN_DISPATCH_ENABLED / KLYRO_DISPATCH_MODE bindings, and the
-- application's in-flight limit argument (3), which the dispatcher and single
-- calls pass to admission.

begin transaction read only;
WITH c AS (
  SELECT
    -- History
    (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261121090000') = 1 AS history_recorded,
    -- Columns
    (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaigns'
       AND column_name IN ('description', 'context', 'context_version', 'context_reviewed_at', 'context_reviewed_by', 'budget_limit')) = 6 AS campaigns_columns,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaign_contacts' AND column_name = 'excluded_reason') AS excluded_reason_column,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'call_logs'
              AND column_name = 'campaign_context_snapshot' AND data_type = 'jsonb') AS snapshot_column,
    -- Constraints
    (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.campaigns'::regclass
       AND conname IN ('campaigns_description_length', 'campaigns_budget_limit_positive', 'campaigns_context_reviewed')) = 3 AS campaigns_constraints,
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.campaign_contacts'::regclass AND conname = 'campaign_contacts_status_check')
      LIKE '%''outcome_unknown''::text, ''excluded''::text]%' AS contact_status_includes_excluded,
    -- Functions and signatures
    to_regprocedure('public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer, timestamptz, text, text)') IS NOT NULL AS campaign_admission_signature,
    to_regprocedure('public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer)') IS NULL AS old_campaign_signature_absent,
    to_regprocedure('public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)') IS NOT NULL AS single_admission_signature,
    to_regprocedure('public.within_outbound_calling_hours(timestamptz)') IS NOT NULL AS hours_function,
    to_regprocedure('public.outbound_admission_now()') IS NOT NULL AS admission_clock_function,
    -- Function permissions
    (NOT has_function_privilege('anon', 'public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer, timestamptz, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer, timestamptz, text, text)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer, timestamptz, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.outbound_admission_now()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.outbound_admission_now()', 'EXECUTE')) AS admission_service_role_only,
    -- RLS and grants
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.campaigns'::regclass)
      AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.campaign_contacts'::regclass)
      AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.call_logs'::regclass)
      AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.platform_settings'::regclass) AS rls_enabled,
    (SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'campaigns')
      = 'members create campaign,members update draft campaign,tenant campaigns read' AS campaigns_policies,
    (SELECT relacl::text FROM pg_class WHERE oid = 'public.campaigns'::regclass)
      = '{postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=arwd/postgres}' AS campaigns_table_acl,
    (has_column_privilege('authenticated', 'public.campaigns', 'description', 'UPDATE')
     AND has_column_privilege('authenticated', 'public.campaigns', 'budget_limit', 'UPDATE')
     AND NOT has_column_privilege('authenticated', 'public.campaigns', 'context', 'UPDATE')
     AND NOT has_column_privilege('authenticated', 'public.campaigns', 'context_version', 'UPDATE')
     AND NOT has_column_privilege('authenticated', 'public.campaigns', 'context_reviewed_at', 'UPDATE')
     AND NOT has_column_privilege('authenticated', 'public.campaigns', 'context_reviewed_by', 'UPDATE')
     AND NOT has_column_privilege('authenticated', 'public.campaigns', 'status', 'UPDATE')
     AND NOT has_column_privilege('authenticated', 'public.campaigns', 'dispatch_mode', 'UPDATE')) AS campaigns_column_grants,
    -- Immutable per-call context snapshot
    (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.call_logs'::regclass AND tgname = 'trg_call_logs_context_snapshot_immutable')
      = 'CREATE TRIGGER trg_call_logs_context_snapshot_immutable BEFORE UPDATE OF campaign_context_snapshot ON public.call_logs FOR EACH ROW EXECUTE FUNCTION call_logs_context_snapshot_immutable()' AS snapshot_trigger,
    (SELECT prosrc LIKE '%campaign_context_snapshot%' AND prosrc LIKE '%''context_changed''%'
       FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admit_campaign_outbound_call') AS snapshot_written_by_admission,
    -- IST calling hours (09:00 inclusive to 21:00 exclusive), any session time zone
    (NOT public.within_outbound_calling_hours('2026-11-20 03:29:59+00')
     AND public.within_outbound_calling_hours('2026-11-20 03:30:00+00')
     AND public.within_outbound_calling_hours('2026-11-20 15:29:59+00')
     AND NOT public.within_outbound_calling_hours('2026-11-20 15:30:00+00')) AS hours_boundaries,
    (SELECT bool_and(prosrc LIKE '%within_outbound_calling_hours(public.outbound_admission_now())%')
       FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('admit_campaign_outbound_call', 'admit_single_outbound_call')) AS hours_in_both_admissions,
    -- Emergency stop
    EXISTS (SELECT 1 FROM public.platform_settings WHERE key = 'outbound.calling_paused' AND is_public = false) AS emergency_stop_setting_private,
    (SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused') = '{"enabled": false}'::jsonb AS emergency_stop_off,
    (SELECT bool_and(prosrc LIKE '%outbound.calling_paused%')
       FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('admit_campaign_outbound_call', 'admit_single_outbound_call')) AS emergency_stop_in_both_admissions,
    -- Wallet reservation: every outbound call not yet billed, single or campaign
    (SELECT bool_and(prosrc LIKE '%billing_applied_at IS NULL AND finalization_state IN (''pending'', ''failed'')%'
                     AND prosrc LIKE '%-- Worst case still owed by every outbound call not yet billed, single or campaign.%')
       FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('admit_campaign_outbound_call', 'admit_single_outbound_call')) AS wallet_reserves_unbilled,
    (SELECT prosrc LIKE '%budget_exhausted%' AND prosrc LIKE '%resolution_source IS DISTINCT FROM ''start_failure''%'
       FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admit_campaign_outbound_call') AS campaign_budget_check,
    -- Shared in-flight limit: both count every open outbound call of the customer (last 15 minutes)
    (SELECT bool_and(prosrc LIKE '%started_at > now() - interval ''15 minutes''%')
       FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('admit_campaign_outbound_call', 'admit_single_outbound_call')) AS in_flight_window,
    (SELECT prosrc LIKE '%-- In flight: every outbound call of this customer, single or campaign.%'
       FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admit_single_outbound_call') AS single_in_flight_shared,
    (SELECT prosrc LIKE '%FOR SHARE%' FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admit_campaign_outbound_call') AS campaign_row_lock,
    -- Experimental Sarvam cohort path unavailable (launch refuses it in code; nothing uses it in data)
    (SELECT count(*) FROM public.campaigns WHERE dispatch_mode = 'sarvam_campaign' OR provider_cohort_id IS NOT NULL) = 0 AS no_cohort_campaigns,
    NOT has_column_privilege('authenticated', 'public.campaigns', 'dispatch_mode', 'INSERT') AS dispatch_mode_not_customer_writable,
    -- Nothing enabled
    (SELECT count(*) FROM public.campaigns WHERE status IN ('running', 'scheduled', 'queued')) = 0 AS no_campaign_running,
    (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) = 0 AS no_outbound_number,
    COALESCE((SELECT result ->> 'skipped' = 'disabled' AND updated_at > now() - interval '10 minutes'
                FROM public.jobs WHERE kind = 'campaign.dispatch' ORDER BY updated_at DESC LIMIT 1), false) AS dispatch_reports_disabled,
    (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') = 'false'::jsonb AS payment_enforcement_unchanged
)
SELECT json_build_object(
  'all_pass', history_recorded AND campaigns_columns AND excluded_reason_column AND snapshot_column AND campaigns_constraints
    AND contact_status_includes_excluded AND campaign_admission_signature AND old_campaign_signature_absent AND single_admission_signature
    AND hours_function AND admission_clock_function AND admission_service_role_only AND rls_enabled AND campaigns_policies
    AND campaigns_table_acl AND campaigns_column_grants AND snapshot_trigger AND snapshot_written_by_admission AND hours_boundaries
    AND hours_in_both_admissions AND emergency_stop_setting_private AND emergency_stop_off AND emergency_stop_in_both_admissions
    AND wallet_reserves_unbilled AND campaign_budget_check AND in_flight_window AND single_in_flight_shared AND campaign_row_lock
    AND no_cohort_campaigns AND dispatch_mode_not_customer_writable AND no_campaign_running AND no_outbound_number
    AND dispatch_reports_disabled AND payment_enforcement_unchanged,
  'checks', to_jsonb(c)
) AS gate_c1_verify
FROM c;
rollback;
