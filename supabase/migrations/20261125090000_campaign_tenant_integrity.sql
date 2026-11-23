-- Campaign tenant integrity in the database (campaign reliability audit).
--
-- campaign_contacts and campaign_uploads each carry organization_id, but
-- nothing made it match the organization of the campaign (or the contact)
-- they point at: only application code (and import_campaign_contacts) kept
-- them consistent. From now on the database refuses any row that links
-- records of two different organizations:
--
--   campaign_contacts (campaign_id, organization_id) -> campaigns (id, organization_id)
--   campaign_contacts (contact_id,  organization_id) -> contacts  (id, organization_id)
--   campaign_uploads  (campaign_id, organization_id) -> campaigns (id, organization_id)
--
-- Each existing single-column key (campaign_contacts_campaign_id_fkey,
-- campaign_contacts_contact_id_fkey, campaign_uploads_campaign_id_fkey) is
-- REPLACED by its composite version under the SAME NAME, inside this one
-- transaction. Keeping both would give PostgREST two relationships between
-- the same tables and every embed such as contacts(*) or
-- campaign_contacts(count) would fail with HTTP 300 (PGRST201), including in
-- the app version already deployed. With one key per pair the Data API is
-- unchanged. The composite key is strictly stronger than the one it replaces
-- (it still requires the parent row to exist), and deletes behave as before
-- (ON DELETE CASCADE).
--
-- The (id, organization_id) unique keys these need are redundant with the
-- primary keys and change no row.
--
-- Existing rows: each composite key is added NOT VALID and then VALIDATEd. If
-- any existing row already mixes organizations, VALIDATE fails and the whole
-- migration rolls back, leaving the old keys in place; run
-- docs/campaign-tenant-integrity-precheck.sql (read-only) first. No row is
-- ever deleted or modified here.
--
-- Re-runnable (a key that is already composite is left alone). Rollback:
-- docs/production-rollback-20261125090000-campaign-tenant-integrity.sql

DO $$
DECLARE
  spec record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_id_organization_id_key') THEN
    ALTER TABLE public.campaigns
      ADD CONSTRAINT campaigns_id_organization_id_key UNIQUE (id, organization_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_id_organization_id_key') THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_id_organization_id_key UNIQUE (id, organization_id);
  END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      ('campaign_contacts', 'campaign_contacts_campaign_id_fkey', 'campaign_id', 'campaigns'),
      ('campaign_contacts', 'campaign_contacts_contact_id_fkey',  'contact_id',  'contacts'),
      ('campaign_uploads',  'campaign_uploads_campaign_id_fkey',  'campaign_id', 'campaigns')
    ) AS s(tbl, conname, col, parent)
  LOOP
    -- Already composite (migration re-run): nothing to do.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = spec.conname
        AND conrelid = format('public.%I', spec.tbl)::regclass
        AND array_length(conkey, 1) = 2
    );
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', spec.tbl, spec.conname);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I, organization_id) '
      'REFERENCES public.%I (id, organization_id) ON DELETE CASCADE NOT VALID',
      spec.tbl, spec.conname, spec.col, spec.parent
    );
  END LOOP;
END $$;

-- Existing rows: fails (and rolls everything back) if any row mixes organizations.
ALTER TABLE public.campaign_contacts VALIDATE CONSTRAINT campaign_contacts_campaign_id_fkey;
ALTER TABLE public.campaign_contacts VALIDATE CONSTRAINT campaign_contacts_contact_id_fkey;
ALTER TABLE public.campaign_uploads VALIDATE CONSTRAINT campaign_uploads_campaign_id_fkey;
