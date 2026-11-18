-- One-time cleanup of call_logs.provider_metadata on existing Sarvam calls.
-- NOT RUN. Requires explicit approval, after the Worker that stores only
-- identifiers (webhook-correlation buildProviderMetadata) is deployed, so no
-- new raw payloads arrive while this runs.
--
-- What it does: for Sarvam call logs whose provider_metadata still holds the
-- raw webhook payload, keeps only the keys ClickAI reads — interaction_id,
-- recording_url, app_id (non-empty strings) and late_provider_report (object)
-- — the same rule as sanitizeProviderMetadata(). Removed: every agent
-- variable, the transcript copy, both phone numbers, deployment/app_version
-- fields and, for outbound rows, ClickAI's webhook URL with its token.
-- Nothing else on the row changes; no row is deleted. The call's transcript,
-- numbers and allowlisted variables keep their own columns.
--
-- Production state read 2026-11-18 (read-only, key names only): 7 Sarvam
-- inbound rows carry the raw payload; 0 outbound rows exist. The guard below
-- aborts unless exactly 7 rows match, so a changed count is reviewed first.
--
-- Reversible for a limited time: the original values are copied into a
-- private backup table (RLS on, no API access) in the same transaction.
-- That table itself holds the personal data, so drop it once the result is
-- verified (see production-rollback-20261118-sarvam-provider-metadata.sql).
--
-- Pre-check (read-only), expect 7:
--   SELECT count(*) FROM public.call_logs
--    WHERE provider = 'sarvam'
--      AND provider_metadata ?| ARRAY['_agent_variables','final_agent_variables',
--          'interaction_transcript','user_phone_number','webhook_config'];

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.call_logs_provider_metadata_backup_20261118 AS
  SELECT id, provider_metadata, now() AS backed_up_at
    FROM public.call_logs
   WHERE provider = 'sarvam'
     AND provider_metadata ?| ARRAY['_agent_variables', 'final_agent_variables',
                                   'interaction_transcript', 'user_phone_number', 'webhook_config'];
ALTER TABLE public.call_logs_provider_metadata_backup_20261118 ADD PRIMARY KEY (id);
ALTER TABLE public.call_logs_provider_metadata_backup_20261118 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_logs_provider_metadata_backup_20261118 FROM PUBLIC, anon, authenticated;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM public.call_logs_provider_metadata_backup_20261118) <> 7 THEN
    RAISE EXCEPTION 'expected exactly 7 raw Sarvam provider_metadata rows; found %',
      (SELECT count(*) FROM public.call_logs_provider_metadata_backup_20261118);
  END IF;
END
$guard$;

UPDATE public.call_logs c
   SET provider_metadata = (
     SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
       FROM jsonb_each(c.provider_metadata) e
      WHERE (e.key IN ('interaction_id', 'recording_url', 'app_id')
             AND jsonb_typeof(e.value) = 'string' AND e.value <> '""'::jsonb)
         OR (e.key = 'late_provider_report' AND jsonb_typeof(e.value) = 'object')
   )
  FROM public.call_logs_provider_metadata_backup_20261118 b
 WHERE c.id = b.id;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.call_logs
     WHERE provider = 'sarvam'
       AND provider_metadata ?| ARRAY['_agent_variables', 'final_agent_variables',
                                     'interaction_transcript', 'user_phone_number', 'webhook_config']
  ) THEN
    RAISE EXCEPTION 'raw Sarvam provider_metadata still present after cleanup';
  END IF;
END
$verify$;

COMMIT;

-- Post-check (read-only): every cleaned row kept its interaction_id, and only
-- allowlisted keys remain.
--   SELECT count(*) FILTER (WHERE c.provider_metadata ? 'interaction_id') AS with_interaction_id,
--          count(*) AS cleaned
--     FROM public.call_logs c
--     JOIN public.call_logs_provider_metadata_backup_20261118 b ON b.id = c.id;
--   SELECT DISTINCT k FROM public.call_logs c, jsonb_object_keys(c.provider_metadata) k
--    WHERE c.id IN (SELECT id FROM public.call_logs_provider_metadata_backup_20261118);
