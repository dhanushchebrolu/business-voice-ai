-- Rollback for 20261125090000_campaign_tenant_integrity.sql. Puts back the
-- original single-column foreign keys (same names, ON DELETE CASCADE) in place
-- of the composite ones and drops the two (id, organization_id) unique keys.
-- No row is changed. Every existing row satisfies the single-column keys
-- (the composite keys were stricter), so VALIDATE cannot fail here.
BEGIN;
ALTER TABLE public.campaign_contacts DROP CONSTRAINT IF EXISTS campaign_contacts_campaign_id_fkey;
ALTER TABLE public.campaign_contacts ADD CONSTRAINT campaign_contacts_campaign_id_fkey
  FOREIGN KEY (campaign_id) REFERENCES public.campaigns (id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.campaign_contacts DROP CONSTRAINT IF EXISTS campaign_contacts_contact_id_fkey;
ALTER TABLE public.campaign_contacts ADD CONSTRAINT campaign_contacts_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES public.contacts (id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.campaign_uploads DROP CONSTRAINT IF EXISTS campaign_uploads_campaign_id_fkey;
ALTER TABLE public.campaign_uploads ADD CONSTRAINT campaign_uploads_campaign_id_fkey
  FOREIGN KEY (campaign_id) REFERENCES public.campaigns (id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.campaign_contacts VALIDATE CONSTRAINT campaign_contacts_campaign_id_fkey;
ALTER TABLE public.campaign_contacts VALIDATE CONSTRAINT campaign_contacts_contact_id_fkey;
ALTER TABLE public.campaign_uploads VALIDATE CONSTRAINT campaign_uploads_campaign_id_fkey;
-- Legacy names from an earlier draft of this migration, if ever applied.
ALTER TABLE public.campaign_contacts DROP CONSTRAINT IF EXISTS campaign_contacts_campaign_same_org_fkey;
ALTER TABLE public.campaign_contacts DROP CONSTRAINT IF EXISTS campaign_contacts_contact_same_org_fkey;
ALTER TABLE public.campaign_uploads DROP CONSTRAINT IF EXISTS campaign_uploads_campaign_same_org_fkey;
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_id_organization_id_key;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_id_organization_id_key;
COMMIT;
