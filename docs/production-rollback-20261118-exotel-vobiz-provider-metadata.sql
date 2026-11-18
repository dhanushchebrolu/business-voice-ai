-- Rollback for production-cleanup-20261118-exotel-vobiz-provider-metadata.sql.
-- NOT RUN. Two parts; run only one, with approval.
--
-- Part A — undo the cleanup (only while the backup table still exists).
-- Puts the original raw payload back, keeping any key written after the
-- cleanup (the current keys win). This restores the phone numbers and the old
-- webhook tokens the cleanup removed; use it only if a reader turns out to
-- need a removed key.

BEGIN;
SET LOCAL lock_timeout = '10s';
UPDATE public.call_logs c
   SET provider_metadata = b.provider_metadata || c.provider_metadata
  FROM public.call_logs_provider_metadata_backup_20261118_telephony b
 WHERE c.id = b.id;
COMMIT;

-- Part B — finish (after the post-check passes and nothing needs a removed
-- key; recommended within 7 days). Drops the backup, which holds the removed
-- phone numbers and old webhook tokens; after this the cleanup cannot be
-- undone.
--
--   BEGIN;
--   DROP TABLE IF EXISTS public.call_logs_provider_metadata_backup_20261118_telephony;
--   COMMIT;
