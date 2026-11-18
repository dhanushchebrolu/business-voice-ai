-- One-time cleanup of raw telephony webhooks in webhook_events.payload.
-- NOT RUN. Requires explicit approval, after the Worker whose telephony route
-- stores only identifiers (telephonyWebhookEventRow: payload {}) is deployed,
-- so no new raw rows arrive while this runs.
--
-- What it does: for Exotel, Vobiz and Sarvam webhook_events rows whose
-- payload still holds the raw webhook, sets payload to '{}', the same shape
-- new writes use. provider, event_id (the unique idempotency key),
-- event_type, processed_at, error and created_at are untouched, so replay
-- de-duplication and retries behave exactly as before. Nothing reads the
-- telephony payload. Removed: caller and called numbers, transcripts, agent
-- variables, recording URLs, provider account ids and the webhook
-- verify_token. Rows from other providers (Razorpay, WhatsApp, Instagram,
-- voice agent, cron) are not touched. No row is deleted.
--
-- Production state read 2026-11-18 (read-only, counts and key names only):
-- 26 Exotel rows (2026-09-16 to 09-17, every one with verify_token and
-- numbers) and 7 Sarvam rows (2026-11-12 to 11-17, numbers, transcripts,
-- agent variables); 0 Vobiz rows. The guard aborts unless exactly 33 match.
--
-- Reversible for a limited time: the original payloads are copied into a
-- private backup table (RLS on, no API access) in the same transaction. It
-- holds the removed data, so drop it once verified (see
-- production-rollback-20261118-webhook-events-payload.sql).
--
-- Pre-check (read-only), expect 33:
--   SELECT provider, count(*) FROM public.webhook_events
--    WHERE provider IN ('exotel', 'vobiz', 'sarvam')
--      AND payload ?| ARRAY['From','To','CallFrom','CallTo','DialWhomNumber','CallerName',
--          'ParentAuthID','verify_token','RecordingUrl','user_phone_number',
--          'agent_phone_number','interaction_transcript','final_agent_variables',
--          'output_agent_variables','recording_url']
--    GROUP BY provider;

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.webhook_events_payload_backup_20261118 AS
  SELECT id, provider, event_id, payload, now() AS backed_up_at
    FROM public.webhook_events
   WHERE provider IN ('exotel', 'vobiz', 'sarvam')
     AND payload ?| ARRAY['From', 'To', 'CallFrom', 'CallTo', 'DialWhomNumber', 'CallerName',
                          'ParentAuthID', 'verify_token', 'RecordingUrl', 'user_phone_number',
                          'agent_phone_number', 'interaction_transcript', 'final_agent_variables',
                          'output_agent_variables', 'recording_url'];
ALTER TABLE public.webhook_events_payload_backup_20261118 ADD PRIMARY KEY (id);
ALTER TABLE public.webhook_events_payload_backup_20261118 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_events_payload_backup_20261118 FROM PUBLIC, anon, authenticated;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM public.webhook_events_payload_backup_20261118) <> 33 THEN
    RAISE EXCEPTION 'expected exactly 33 raw telephony webhook_events rows; found %',
      (SELECT count(*) FROM public.webhook_events_payload_backup_20261118);
  END IF;
END
$guard$;

UPDATE public.webhook_events w
   SET payload = '{}'::jsonb
  FROM public.webhook_events_payload_backup_20261118 b
 WHERE w.id = b.id;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.webhook_events
     WHERE provider IN ('exotel', 'vobiz', 'sarvam')
       AND payload ?| ARRAY['From', 'To', 'CallFrom', 'CallTo', 'DialWhomNumber', 'CallerName',
                            'ParentAuthID', 'verify_token', 'RecordingUrl', 'user_phone_number',
                            'agent_phone_number', 'interaction_transcript', 'final_agent_variables',
                            'output_agent_variables', 'recording_url']
  ) THEN
    RAISE EXCEPTION 'raw telephony webhook payloads still present after cleanup';
  END IF;
END
$verify$;

COMMIT;

-- Post-check (read-only): every cleaned row kept its idempotency key and
-- processing state; payloads are empty.
--   SELECT count(*) FILTER (WHERE w.payload = '{}'::jsonb) AS emptied,
--          count(*) FILTER (WHERE w.event_id = b.event_id) AS same_event_id,
--          count(*) AS cleaned
--     FROM public.webhook_events w
--     JOIN public.webhook_events_payload_backup_20261118 b ON b.id = w.id;
