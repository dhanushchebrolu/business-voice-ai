-- Rollback for production-cleanup-20261118-webhook-events-payload.sql.
-- NOT RUN. Two parts; run only one, with approval.
--
-- Part A — undo the cleanup (only while the backup table still exists).
-- Puts the original raw payload back, keeping any key written after the
-- cleanup (the current keys win). This restores the phone numbers,
-- transcripts and old webhook tokens the cleanup removed; use it only if a
-- reader turns out to need them. Idempotency keys were never changed.

BEGIN;
SET LOCAL lock_timeout = '10s';
UPDATE public.webhook_events w
   SET payload = b.payload || w.payload
  FROM public.webhook_events_payload_backup_20261118 b
 WHERE w.id = b.id;
COMMIT;

-- Part B — finish (after the post-check passes; recommended within 7 days).
-- Drops the backup, which holds the removed personal data and old tokens;
-- after this the cleanup cannot be undone.
--
--   BEGIN;
--   DROP TABLE IF EXISTS public.webhook_events_payload_backup_20261118;
--   COMMIT;
