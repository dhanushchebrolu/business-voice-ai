-- Rollback for 20261124090000_campaign_contact_import_atomic.sql. Removes the
-- import function, its unique index and the four history columns; contacts,
-- memberships and existing history rows stay. Deploy an application version
-- that does not call import_campaign_contacts first, or CSV imports fail.
BEGIN;
DROP FUNCTION IF EXISTS public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb);
DROP INDEX IF EXISTS public.idx_campaign_uploads_org_idempotency_key;
ALTER TABLE public.campaign_uploads
  DROP COLUMN IF EXISTS enrolled_rows,
  DROP COLUMN IF EXISTS already_in_campaign_rows,
  DROP COLUMN IF EXISTS opted_out_rows,
  DROP COLUMN IF EXISTS idempotency_key;
COMMIT;
