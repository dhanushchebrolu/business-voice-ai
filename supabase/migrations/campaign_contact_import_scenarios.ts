/**
 * Self-checking scenarios for public.import_campaign_contacts
 * (20261124090000_campaign_contact_import_atomic.sql). Plain SQL: every
 * expectation is an assertion that raises 'FAIL: ...', and the last line
 * prints ALL_OK. Run inside BEGIN ... ROLLBACK so nothing is kept. Used by
 * campaign_contact_import_atomic.pg.test.ts (CI, a fresh cluster) and against
 * the local QA database, so both run the identical checks.
 *
 * Needs one row in auth.users (the owner of the two test workspaces).
 */
export const IMPORT_SCENARIOS_SQL = `
CREATE FUNCTION pg_temp.check(ok boolean, what text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; END $f$;
CREATE FUNCTION pg_temp.fail_history() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RAISE EXCEPTION 'injected history failure'; END $f$;

DO $$
DECLARE
  owner uuid := (SELECT id FROM auth.users ORDER BY created_at LIMIT 1);
  org_a uuid; org_b uuid; ca uuid; ca2 uuid; cb uuid; cr uuid;
  res jsonb; again jsonb;
  failed boolean;
  row3 jsonb := '[
    {"phone":"+919100000101","name":"One","fields":{"name":"One"},"variables":{}},
    {"phone":"+919100000102","name":"Two","fields":{"name":"Two"},"variables":{}},
    {"phone":"+919100000103","name":"Three","fields":{"name":"Three"},"variables":{}}]';
BEGIN
  PERFORM pg_temp.check(owner IS NOT NULL, 'an auth user exists');
  INSERT INTO public.organizations (name, owner_id) VALUES ('IMPORT TEST A', owner) RETURNING id INTO org_a;
  INSERT INTO public.organizations (name, owner_id) VALUES ('IMPORT TEST B', owner) RETURNING id INTO org_b;
  INSERT INTO public.campaigns (organization_id, name) VALUES (org_a, 'A main') RETURNING id INTO ca;
  INSERT INTO public.campaigns (organization_id, name) VALUES (org_a, 'A counts') RETURNING id INTO ca2;
  INSERT INTO public.campaigns (organization_id, name) VALUES (org_b, 'B main') RETURNING id INTO cb;
  INSERT INTO public.campaigns (organization_id, name, status) VALUES (org_a, 'A running', 'running') RETURNING id INTO cr;
  INSERT INTO public.contacts (organization_id, phone, name, custom_fields) VALUES
    (org_a, '+919100000001', 'Asha Saved', '{"city":"Pune","plan":"Gold"}'),
    (org_a, '+919100000002', NULL, '{}');
  INSERT INTO public.contacts (organization_id, phone, name, opted_out, opted_out_reason)
    VALUES (org_a, '+919100000009', 'Do Not Call', true, 'asked');

  -- 1-2. A blank (or missing) name never erases a saved name; empty cells erase nothing.
  res := public.import_campaign_contacts(org_a, ca, owner, NULL, 'blank.csv', 2, 0, 0,
    '[{"phone":"+919100000001","name":null,"fields":{"name":"","city":"","plan":"  "},"variables":{}},
      {"phone":"+919100000001","name":"   ","fields":{},"variables":{}}]');
  PERFORM pg_temp.check((SELECT name FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000001') = 'Asha Saved', '1-2 saved name kept');
  PERFORM pg_temp.check((SELECT custom_fields->>'city' FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000001') = 'Pune', '1-2 empty cell kept saved field');
  PERFORM pg_temp.check((SELECT custom_fields->>'plan' FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000001') = 'Gold', '1-2 blank cell kept saved field');

  -- 3-5. New with a name; new without a name; a saved empty name gets filled; a non-blank
  -- name replaces a saved one (the import's existing contract).
  res := public.import_campaign_contacts(org_a, ca, owner, NULL, 'names.csv', 4, 0, 0,
    '[{"phone":"+919100000003","name":"New Name","fields":{"name":"New Name"},"variables":{}},
      {"phone":"+919100000004","name":null,"fields":{},"variables":{}},
      {"phone":"+919100000002","name":"Filled","fields":{"name":"Filled","city":"Delhi"},"variables":{}},
      {"phone":"+919100000001","name":"Asha New","fields":{},"variables":{}}]');
  PERFORM pg_temp.check((SELECT name FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000003') = 'New Name', '3 new contact with name');
  PERFORM pg_temp.check((SELECT name IS NULL FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000004'), '4 new contact without name stays NULL');
  PERFORM pg_temp.check((SELECT name FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000002') = 'Filled', '5 empty saved name filled');
  PERFORM pg_temp.check((SELECT custom_fields->>'city' FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000002') = 'Delhi', '5 non-empty field merged');
  PERFORM pg_temp.check((SELECT name FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000001') = 'Asha New', '5 non-blank name replaces (existing contract)');
  PERFORM pg_temp.check((SELECT custom_fields->>'city' FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000001') = 'Pune', '5 fields not in the row are kept');

  -- 6. Three new contacts -> 3 added.
  res := public.import_campaign_contacts(org_a, ca2, owner, 'imp_counts_first_0001', 'three.csv', 3, 0, 0, row3);
  PERFORM pg_temp.check((res->>'enrolled')::int = 3 AND (res->>'already_in_campaign')::int = 0, '6 three new -> 3 added: ' || res::text);
  PERFORM pg_temp.check((res->>'replayed')::boolean = false, '6 not a replay');

  -- 7 + 19. The same three again under a new key -> 0 added, 3 already; a new history row.
  res := public.import_campaign_contacts(org_a, ca2, owner, 'imp_counts_second_001', 'three.csv', 3, 0, 0, row3);
  PERFORM pg_temp.check((res->>'enrolled')::int = 0 AND (res->>'already_in_campaign')::int = 3, '7 three existing -> 0 added: ' || res::text);
  PERFORM pg_temp.check((SELECT count(*) FROM public.campaign_uploads WHERE campaign_id = ca2) = 2, '19 a different key is a separate import');

  -- 8-10. Mixed: existing member, new, do-not-call; invalid and duplicate rows as counted by the server.
  res := public.import_campaign_contacts(org_a, ca2, owner, 'imp_counts_mixed_0001', 'mixed.csv', 6, 1, 1,
    '[{"phone":"+919100000101","name":"One","fields":{},"variables":{}},
      {"phone":"+919100000104","name":"Four","fields":{},"variables":{}},
      {"phone":"+919100000009","name":"Do Not Call","fields":{},"variables":{}}]');
  PERFORM pg_temp.check(
    (res->>'total_rows')::int = 6 AND (res->>'valid_rows')::int = 3 AND (res->>'invalid_rows')::int = 1
    AND (res->>'duplicate_rows')::int = 1 AND (res->>'enrolled')::int = 1
    AND (res->>'already_in_campaign')::int = 1 AND (res->>'opted_out')::int = 1, '8-10 mixed counts: ' || res::text);
  -- Do-not-call: counted, never enrolled, never cleared.
  PERFORM pg_temp.check((SELECT opted_out FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000009'), 'opted-out stays opted out');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.campaign_contacts cc JOIN public.contacts c ON c.id = cc.contact_id
    WHERE cc.campaign_id = ca2 AND c.phone = '+919100000009'), 'opted-out never enrolled');

  -- 11. History equals the memberships actually created.
  PERFORM pg_temp.check(
    (SELECT sum(enrolled_rows) FROM public.campaign_uploads WHERE campaign_id = ca2)
    = (SELECT count(*) FROM public.campaign_contacts WHERE campaign_id = ca2), '11 history matches memberships');

  -- 16-17. The same key again returns the first result; nothing new is written.
  again := public.import_campaign_contacts(org_a, ca2, owner, 'imp_counts_first_0001', 'three.csv', 3, 0, 0, row3);
  PERFORM pg_temp.check((again->>'replayed')::boolean AND (again->>'enrolled')::int = 3, '16-17 replay returns original counts: ' || again::text);
  PERFORM pg_temp.check((SELECT count(*) FROM public.campaign_uploads WHERE organization_id = org_a AND idempotency_key = 'imp_counts_first_0001') = 1, '16 one history row per key');
  PERFORM pg_temp.check((SELECT count(*) FROM public.campaign_contacts WHERE campaign_id = ca2) = 4, '16 replay adds no membership');

  -- 12. A failure while writing contacts rolls back everything this import wrote.
  failed := false;
  BEGIN
    PERFORM public.import_campaign_contacts(org_a, ca, owner, 'imp_atomic_contact_01', 'bad.csv', 2, 0, 0,
      '[{"phone":"+919100000201","name":"Good","fields":{},"variables":{}},
        {"phone":"not-a-phone","name":"Bad","fields":{},"variables":{}}]');
  EXCEPTION WHEN check_violation THEN failed := true;
  END;
  PERFORM pg_temp.check(failed, '12 bad row raised');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000201'), '12 earlier contact rolled back');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.campaign_uploads WHERE idempotency_key = 'imp_atomic_contact_01'), '12 no history');

  -- 13. A failure writing the history row rolls back the contacts and memberships.
  CREATE TRIGGER fail_history BEFORE INSERT ON public.campaign_uploads
    FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_history();
  failed := false;
  BEGIN
    PERFORM public.import_campaign_contacts(org_a, ca, owner, 'imp_atomic_history_1', 'h.csv', 1, 0, 0,
      '[{"phone":"+919100000301","name":"H","fields":{},"variables":{}}]');
  EXCEPTION WHEN raise_exception THEN failed := true;
  END;
  DROP TRIGGER fail_history ON public.campaign_uploads;
  PERFORM pg_temp.check(failed, '13 history failure raised');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000301'), '13 contact rolled back');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.campaign_contacts cc JOIN public.contacts c ON c.id = cc.contact_id
    WHERE cc.campaign_id = ca AND c.phone = '+919100000301'), '13 membership rolled back');

  -- 14. Retrying after a failure (same key) succeeds cleanly.
  res := public.import_campaign_contacts(org_a, ca, owner, 'imp_atomic_history_1', 'h.csv', 1, 0, 0,
    '[{"phone":"+919100000301","name":"H","fields":{},"variables":{}}]');
  PERFORM pg_temp.check((res->>'enrolled')::int = 1 AND NOT (res->>'replayed')::boolean, '14 retry after failure: ' || res::text);

  -- Tenancy: another workspace's campaign is refused; a key is per workspace; a key
  -- belongs to one campaign; a running campaign takes no contacts.
  failed := false;
  BEGIN PERFORM public.import_campaign_contacts(org_a, cb, owner, NULL, 'x.csv', 1, 0, 0, row3);
  EXCEPTION WHEN no_data_found THEN failed := true; END;
  PERFORM pg_temp.check(failed, 'tenant: other organization''s campaign refused');
  PERFORM pg_temp.check((SELECT count(*) FROM public.campaign_contacts WHERE campaign_id = cb) = 0, 'tenant: nothing written to B');
  res := public.import_campaign_contacts(org_b, cb, owner, 'imp_counts_first_0001', 'b.csv', 1, 0, 0,
    '[{"phone":"+919100000101","name":"B One","fields":{},"variables":{}}]');
  PERFORM pg_temp.check(NOT (res->>'replayed')::boolean AND (res->>'enrolled')::int = 1, 'tenant: same key in B is B''s own import');
  PERFORM pg_temp.check((SELECT name FROM public.contacts WHERE organization_id = org_a AND phone = '+919100000101') = 'One', 'tenant: A''s contact untouched');
  failed := false;
  BEGIN PERFORM public.import_campaign_contacts(org_a, ca, owner, 'imp_counts_first_0001', 'x.csv', 1, 0, 0, row3);
  EXCEPTION WHEN unique_violation THEN failed := true; END;
  PERFORM pg_temp.check(failed, 'a key reused for another campaign is refused');
  failed := false;
  BEGIN PERFORM public.import_campaign_contacts(org_a, cr, owner, NULL, 'x.csv', 1, 0, 0, row3);
  EXCEPTION WHEN check_violation THEN failed := true; END;
  PERFORM pg_temp.check(failed, 'a running campaign takes no contacts');

  -- 20. History written before this migration (no new counts) is still readable.
  INSERT INTO public.campaign_uploads (campaign_id, organization_id, filename, total_rows, valid_rows, invalid_rows, duplicate_rows)
    VALUES (ca, org_a, 'legacy.csv', 3, 3, 0, 0);
  PERFORM pg_temp.check((SELECT enrolled_rows IS NULL AND valid_rows = 3 FROM public.campaign_uploads WHERE filename = 'legacy.csv' AND campaign_id = ca), '20 legacy row readable');
END $$;

SELECT 'ALL_OK';
`;
