-- Outbound emergency stop: STATUS. READ ONLY.
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/outbound-emergency-stop-status.sql
begin transaction read only;
SELECT json_build_object(
  'stop_active', COALESCE((SELECT (value ->> 'enabled')::boolean FROM public.platform_settings WHERE key = 'outbound.calling_paused'), false),
  'stop_installed', EXISTS (SELECT 1 FROM public.platform_settings WHERE key = 'outbound.calling_paused'),
  'stop_private', COALESCE((SELECT NOT is_public FROM public.platform_settings WHERE key = 'outbound.calling_paused'), false),
  'stop_updated_at', (SELECT updated_at FROM public.platform_settings WHERE key = 'outbound.calling_paused'),
  'open_outbound_calls', (SELECT count(*) FROM public.call_logs WHERE direction = 'outbound'
                            AND status IN ('initiated', 'ringing', 'answered', 'in_progress')),
  'outcome_unknown_calls', (SELECT count(*) FROM public.call_logs WHERE direction = 'outbound' AND status = 'outcome_unknown'),
  'outbound_admitted_since_stop', (SELECT count(*) FROM public.call_logs c, public.platform_settings s
                                    WHERE s.key = 'outbound.calling_paused' AND (s.value ->> 'enabled')::boolean
                                      AND c.direction = 'outbound' AND c.started_at > s.updated_at),
  'campaigns_by_status', (SELECT json_object_agg(status, n) FROM (SELECT status, count(*) n FROM public.campaigns GROUP BY 1) x)
) AS outbound_stop_status;
rollback;
