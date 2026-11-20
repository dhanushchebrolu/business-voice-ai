-- Outbound emergency stop: ACTIVATE. One transaction (the query channel's).
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/outbound-emergency-stop-activate.sql
-- From the next admission on, no new outbound call (single or campaign) is admitted.
-- Calls already in progress are not touched. See docs/outbound-emergency-stop-runbook.md.
DO $stop$
BEGIN
  UPDATE public.platform_settings
     SET value = '{"enabled": true}'::jsonb, updated_at = now()
   WHERE key = 'outbound.calling_paused';
  IF NOT FOUND THEN
    -- Without the row the stop does not exist (migration 20261121090000 not applied).
    RAISE EXCEPTION 'STOP_NOT_INSTALLED: platform_settings outbound.calling_paused is missing; use OUTBOUND_CALLING_DISABLED';
  END IF;
END
$stop$;
SELECT key, value, is_public, updated_at FROM public.platform_settings WHERE key = 'outbound.calling_paused';
