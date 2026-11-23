-- Rollback for 20261126090000_webhook_event_claim_lease.sql.
-- Deploy the previous Worker FIRST (the new code calls these functions).
-- Drops the two functions and the three columns; no other row data changes.
-- Events left unfinished go back to the old rule (only an event with a
-- recorded error can be claimed again).
BEGIN;
DROP FUNCTION IF EXISTS public.apply_call_event_fenced(text, text, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.claim_webhook_event(text, text, text, jsonb, integer, integer);
ALTER TABLE public.webhook_events
  DROP COLUMN IF EXISTS attempts,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS claim_token;
COMMIT;
