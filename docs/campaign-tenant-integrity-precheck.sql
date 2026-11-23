-- READ-ONLY pre-check for 20261125090000_campaign_tenant_integrity.sql.
-- Run before applying the migration anywhere (it changes nothing): every count
-- must be 0. A non-zero count means existing rows already link records of two
-- different organizations; the migration would then fail (changing nothing),
-- and those rows need a decision by a person first. Never delete them blindly.
begin transaction read only;
SELECT json_build_object(
  'campaign_contacts_campaign_org_mismatch', (
    SELECT count(*) FROM public.campaign_contacts cc
    JOIN public.campaigns c ON c.id = cc.campaign_id
    WHERE c.organization_id <> cc.organization_id),
  'campaign_contacts_contact_org_mismatch', (
    SELECT count(*) FROM public.campaign_contacts cc
    JOIN public.contacts k ON k.id = cc.contact_id
    WHERE k.organization_id <> cc.organization_id),
  'campaign_uploads_campaign_org_mismatch', (
    SELECT count(*) FROM public.campaign_uploads u
    JOIN public.campaigns c ON c.id = u.campaign_id
    WHERE c.organization_id <> u.organization_id),
  'campaign_contacts_total', (SELECT count(*) FROM public.campaign_contacts),
  'campaign_uploads_total', (SELECT count(*) FROM public.campaign_uploads)
) AS campaign_tenant_integrity_precheck;
rollback;
