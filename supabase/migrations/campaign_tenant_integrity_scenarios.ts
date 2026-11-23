/**
 * Self-checking cross-tenant scenarios for
 * 20261125090000_campaign_tenant_integrity.sql. Each attempt to link records
 * of two organizations must fail with foreign_key_violation; same-organization
 * rows, campaign deletion (cascade) and the import function keep working.
 * Plain SQL ending in ALL_OK; run inside BEGIN ... ROLLBACK. Used by
 * campaign_tenant_integrity.pg.test.ts (CI) and on the local QA database.
 * Needs one row in auth.users.
 */
export const TENANT_SCENARIOS_SQL = `
CREATE FUNCTION pg_temp.check(ok boolean, what text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; END $f$;

DO $$
DECLARE
  owner uuid := (SELECT id FROM auth.users ORDER BY created_at LIMIT 1);
  org_a uuid; org_b uuid; camp_a uuid; camp_b uuid; contact_a uuid; contact_b uuid;
  refused boolean;
  res jsonb;
BEGIN
  INSERT INTO public.organizations (name, owner_id) VALUES ('TENANT TEST A', owner) RETURNING id INTO org_a;
  INSERT INTO public.organizations (name, owner_id) VALUES ('TENANT TEST B', owner) RETURNING id INTO org_b;
  INSERT INTO public.campaigns (organization_id, name) VALUES (org_a, 'A') RETURNING id INTO camp_a;
  INSERT INTO public.campaigns (organization_id, name) VALUES (org_b, 'B') RETURNING id INTO camp_b;
  INSERT INTO public.contacts (organization_id, phone) VALUES (org_a, '+919200000001') RETURNING id INTO contact_a;
  INSERT INTO public.contacts (organization_id, phone) VALUES (org_b, '+919200000002') RETURNING id INTO contact_b;

  -- Same organization everywhere: allowed.
  INSERT INTO public.campaign_contacts (campaign_id, organization_id, contact_id) VALUES (camp_a, org_a, contact_a);
  INSERT INTO public.campaign_uploads (campaign_id, organization_id, filename) VALUES (camp_a, org_a, 'ok.csv');

  -- A's contact in B's campaign, labelled as A.
  refused := false;
  BEGIN INSERT INTO public.campaign_contacts (campaign_id, organization_id, contact_id) VALUES (camp_b, org_a, contact_a);
  EXCEPTION WHEN foreign_key_violation THEN refused := true; END;
  PERFORM pg_temp.check(refused, 'membership in another organization''s campaign refused');

  -- B's contact in A's campaign, labelled as A.
  refused := false;
  BEGIN INSERT INTO public.campaign_contacts (campaign_id, organization_id, contact_id) VALUES (camp_a, org_a, contact_b);
  EXCEPTION WHEN foreign_key_violation THEN refused := true; END;
  PERFORM pg_temp.check(refused, 'another organization''s contact refused');

  -- Moving an existing membership to another organization's campaign.
  refused := false;
  BEGIN UPDATE public.campaign_contacts SET campaign_id = camp_b WHERE campaign_id = camp_a AND contact_id = contact_a;
  EXCEPTION WHEN foreign_key_violation THEN refused := true; END;
  PERFORM pg_temp.check(refused, 'repointing a membership across organizations refused');

  -- Import history filed under the wrong organization.
  refused := false;
  BEGIN INSERT INTO public.campaign_uploads (campaign_id, organization_id, filename) VALUES (camp_b, org_a, 'x.csv');
  EXCEPTION WHEN foreign_key_violation THEN refused := true; END;
  PERFORM pg_temp.check(refused, 'history for another organization''s campaign refused');

  -- The import function still works within one organization.
  res := public.import_campaign_contacts(org_a, camp_a, owner, NULL, 'f.csv', 1, 0, 0,
    '[{"phone":"+919200000003","name":"N","fields":{},"variables":{}}]');
  PERFORM pg_temp.check((res->>'enrolled')::int = 1, 'import still works: ' || res::text);

  -- Deleting a campaign still removes its memberships and history (cascade).
  DELETE FROM public.campaigns WHERE id = camp_a;
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.campaign_contacts WHERE campaign_id = camp_a), 'cascade memberships');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.campaign_uploads WHERE campaign_id = camp_a), 'cascade history');
END $$;

SELECT 'ALL_OK';
`;
