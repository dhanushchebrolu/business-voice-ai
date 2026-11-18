-- One-time cleanup of call_logs.provider_metadata on historical Exotel and
-- Vobiz calls. NOT RUN. Requires explicit approval, after the Worker that
-- stores only identifiers (webhook-correlation buildProviderMetadata, shared
-- by every telephony provider) is deployed, so no new raw payloads arrive.
--
-- What it does: these rows hold the provider's raw webhook form post. Keeps
-- only the keys ClickAI stores today — interaction_id, recording_url, app_id
-- (non-empty strings) and late_provider_report (object), the same rule as
-- sanitizeProviderMetadata() — with Exotel's RecordingUrl carried over as
-- recording_url, which is what buildProviderMetadata stores for a new call.
-- Removed: caller and called numbers (From, To, CallFrom, CallTo,
-- DialWhomNumber, ForwardedFrom), CallerName, the Vobiz account id
-- (ParentAuthID), billing and timing fields, tenant_id / flow_id and the
-- webhook verify_token secret. Nothing in ClickAI reads any removed key
-- (readers use only Sarvam and livekit_sip keys). Nothing else on the row
-- changes; no row is deleted.
--
-- Production state read 2026-11-18 (read-only, counts and key names only):
-- 23 Exotel rows (last updated 2026-09-17, 5 with RecordingUrl) and 175 Vobiz
-- rows (last updated 2026-11-07); every one carries phone numbers and
-- verify_token. The guard aborts unless exactly 198 rows match.
--
-- The verify_token values have been at rest in this table: rotate the Vobiz
-- (and, if still configured, Exotel) webhook token separately. This cleanup
-- does not make the old token safe.
--
-- Reversible for a limited time: the original values are copied into a
-- private backup table (RLS on, no API access) in the same transaction. That
-- table holds the numbers and the old tokens, so drop it once verified (see
-- production-rollback-20261118-exotel-vobiz-provider-metadata.sql).
--
-- Pre-check (read-only), expect 198:
--   SELECT count(*) FROM public.call_logs
--    WHERE provider IN ('exotel', 'vobiz')
--      AND provider_metadata ?| ARRAY['From','To','CallFrom','CallTo','DialWhomNumber',
--          'ForwardedFrom','CallerName','ParentAuthID','verify_token'];

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.call_logs_provider_metadata_backup_20261118_telephony AS
  SELECT id, provider, provider_metadata, now() AS backed_up_at
    FROM public.call_logs
   WHERE provider IN ('exotel', 'vobiz')
     AND provider_metadata ?| ARRAY['From', 'To', 'CallFrom', 'CallTo', 'DialWhomNumber',
                                   'ForwardedFrom', 'CallerName', 'ParentAuthID', 'verify_token'];
ALTER TABLE public.call_logs_provider_metadata_backup_20261118_telephony ADD PRIMARY KEY (id);
ALTER TABLE public.call_logs_provider_metadata_backup_20261118_telephony ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_logs_provider_metadata_backup_20261118_telephony
  FROM PUBLIC, anon, authenticated;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM public.call_logs_provider_metadata_backup_20261118_telephony) <> 198 THEN
    RAISE EXCEPTION 'expected exactly 198 raw Exotel/Vobiz provider_metadata rows; found %',
      (SELECT count(*) FROM public.call_logs_provider_metadata_backup_20261118_telephony);
  END IF;
END
$guard$;

UPDATE public.call_logs c
   SET provider_metadata = (
     SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
       FROM jsonb_each(
              CASE WHEN NOT c.provider_metadata ? 'recording_url'
                        AND jsonb_typeof(c.provider_metadata -> 'RecordingUrl') = 'string'
                   THEN c.provider_metadata
                        || jsonb_build_object('recording_url', c.provider_metadata -> 'RecordingUrl')
                   ELSE c.provider_metadata
              END) e
      WHERE (e.key IN ('interaction_id', 'recording_url', 'app_id')
             AND jsonb_typeof(e.value) = 'string' AND e.value <> '""'::jsonb)
         OR (e.key = 'late_provider_report' AND jsonb_typeof(e.value) = 'object')
   )
  FROM public.call_logs_provider_metadata_backup_20261118_telephony b
 WHERE c.id = b.id;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.call_logs
     WHERE provider IN ('exotel', 'vobiz')
       AND provider_metadata ?| ARRAY['From', 'To', 'CallFrom', 'CallTo', 'DialWhomNumber',
                                     'ForwardedFrom', 'CallerName', 'ParentAuthID', 'verify_token']
  ) THEN
    RAISE EXCEPTION 'raw Exotel/Vobiz provider_metadata still present after cleanup';
  END IF;
END
$verify$;

COMMIT;

-- Post-check (read-only): only allowlisted keys remain on the cleaned rows.
--   SELECT k, count(*) FROM public.call_logs c, jsonb_object_keys(c.provider_metadata) k
--    WHERE c.id IN (SELECT id FROM public.call_logs_provider_metadata_backup_20261118_telephony)
--    GROUP BY k;
