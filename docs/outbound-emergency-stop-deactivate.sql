-- Outbound emergency stop: REMOVE. One transaction (the query channel's).
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/outbound-emergency-stop-deactivate.sql
-- Running campaigns resume dialling at the next dispatch run (about a minute)
-- if CAMPAIGN_DISPATCH_ENABLED is set. Read docs/outbound-emergency-stop-runbook.md §3 first.
DO $stop$
BEGIN
  UPDATE public.platform_settings
     SET value = '{"enabled": false}'::jsonb, updated_at = now()
   WHERE key = 'outbound.calling_paused';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STOP_NOT_INSTALLED: platform_settings outbound.calling_paused is missing';
  END IF;
END
$stop$;
SELECT key, value, is_public, updated_at FROM public.platform_settings WHERE key = 'outbound.calling_paused';
