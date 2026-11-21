-- Outbound production-readiness status. READ ONLY: a read-only transaction
-- that rolls back. Prints counts and settings only, never a phone number.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/outbound-readiness-status.sql
begin transaction read only;
SELECT json_build_object(
  'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'emergency_stop', (SELECT value FROM public.platform_settings WHERE key = 'outbound.calling_paused'),
  'payment_enforcement', (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required'),
  'numbers_outbound_enabled', (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled),
  'campaigns_by_status', (SELECT COALESCE(jsonb_object_agg(status, n), '{}') FROM
      (SELECT status, count(*) n FROM public.campaigns GROUP BY status) s),
  'campaign_contacts_by_status', (SELECT COALESCE(jsonb_object_agg(status, n), '{}') FROM
      (SELECT status, count(*) n FROM public.campaign_contacts GROUP BY status) s),
  'outbound_calls_by_status', (SELECT COALESCE(jsonb_object_agg(status, n), '{}') FROM
      (SELECT status, count(*) n FROM public.call_logs WHERE direction = 'outbound' GROUP BY status) s),
  'outbound_calls_last_24h', (SELECT count(*) FROM public.call_logs
      WHERE direction = 'outbound' AND started_at > now() - interval '24 hours'),
  'unresolved_outbound', (SELECT count(*) FROM public.call_logs WHERE direction = 'outbound'
      AND status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown')),
  'unbilled_finished_outbound', (SELECT count(*) FROM public.call_logs WHERE direction = 'outbound'
      AND billing_applied_at IS NULL AND finalization_state IN ('pending', 'failed')),
  'dispatch_jobs_last_hour', (SELECT COALESCE(jsonb_object_agg(r, n), '{}') FROM
      (SELECT COALESCE(result::text, status) r, count(*) n FROM public.jobs
        WHERE kind = 'campaign.dispatch' AND created_at > now() - interval '1 hour' GROUP BY 1) s),
  'opt_out_guard_triggers', (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.contacts'::regclass
      AND tgname IN ('trg_contacts_opt_out_guard', 'trg_contacts_opt_out_truncate_guard') AND tgenabled <> 'D'),
  'rls_on_outbound_tables', (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN (
      'public.call_logs'::regclass, 'public.campaigns'::regclass, 'public.campaign_contacts'::regclass,
      'public.contacts'::regclass, 'public.wallet_balances'::regclass, 'public.wallet_transactions'::regclass)),
  'dead_jobs_last_day', (SELECT count(*) FROM public.jobs WHERE status = 'dead' AND dead_at > now() - interval '24 hours')
) AS outbound_readiness_status;
rollback;
