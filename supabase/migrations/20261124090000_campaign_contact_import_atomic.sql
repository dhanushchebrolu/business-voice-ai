-- Atomic, retry-safe campaign contact imports with accurate history
-- (campaign reliability audit, import findings).
--
-- Before: the server enrolled CSV rows one REST call at a time and wrote the
-- history row last, so a failure part-way left some contacts enrolled and no
-- history; a re-import was logged as "N valid" even when nothing was added; a
-- blank CSV name overwrote a contact's saved name; a retry after a lost
-- response wrote a second history row.
--
-- Now one function, public.import_campaign_contacts, does the whole import in
-- ONE transaction (a function call is a single statement): either every
-- contact, membership and the history row are written, or nothing is.
--
--   - Contacts: one per (organization, phone) as before (UNIQUE). A blank or
--     missing name never replaces a saved name; a non-blank name replaces it
--     (the import's existing contract). Only non-empty CSV fields are merged
--     into custom_fields, so empty cells never erase saved values. opted_out
--     is never written: a do-not-call contact is counted and not enrolled.
--   - Memberships: INSERT ... ON CONFLICT (campaign_id, contact_id) DO NOTHING,
--     so concurrent or repeated imports never duplicate a membership, and the
--     counts say exactly what this import added.
--   - History: campaign_uploads gains enrolled_rows, already_in_campaign_rows,
--     opted_out_rows and idempotency_key (all nullable; rows from before keep
--     NULL and show the old totals). One history row per (organization, key):
--     the same key again returns the first import's result, unchanged. A
--     transaction-scoped advisory lock serialises imports with the same key,
--     so concurrent retries wait for the first and then replay it.
--   - Tenancy: the caller (server, service role) has already authorised the
--     user; the function re-checks that the campaign belongs to the
--     organization and is editable, takes the organization for every row it
--     writes from that argument, and is executable by service_role only.
--
-- Additive and re-runnable. Rollback:
-- docs/production-rollback-20261124090000-campaign-contact-import-atomic.sql

ALTER TABLE public.campaign_uploads
  ADD COLUMN IF NOT EXISTS enrolled_rows integer,
  ADD COLUMN IF NOT EXISTS already_in_campaign_rows integer,
  ADD COLUMN IF NOT EXISTS opted_out_rows integer,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_uploads_org_idempotency_key
  ON public.campaign_uploads (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.import_campaign_contacts(
  _org uuid,
  _campaign uuid,
  _user uuid,
  _idempotency_key text,
  _filename text,
  _total_rows integer,
  _invalid_rows integer,
  _duplicate_rows integer,
  -- [{"phone": "+91...", "name": "..." | null, "fields": {...}, "variables": {...}}]
  _rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
-- Empty: every table is schema-qualified and built-ins resolve to pg_catalog only, so no
-- function created in public can shadow one and run with this function's privileges.
SET search_path = ''
AS $$
DECLARE
  existing public.campaign_uploads%ROWTYPE;
  campaign_status text;
  campaign_org uuid;
  r jsonb;
  incoming_name text;
  clean_fields jsonb;
  v_contact_id uuid;
  v_opted_out boolean;
  inserted integer;
  enrolled integer := 0;
  already integer := 0;
  opted integer := 0;
  upload_id uuid;
BEGIN
  IF _org IS NULL OR _campaign IS NULL THEN
    RAISE EXCEPTION 'organization and campaign are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Same import again (retry, lost response, double click): the first result, unchanged.
  IF _idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(_org::text || ':' || _idempotency_key, 0::bigint));
    SELECT * INTO existing FROM public.campaign_uploads
      WHERE organization_id = _org AND idempotency_key = _idempotency_key;
    IF FOUND THEN
      IF existing.campaign_id IS DISTINCT FROM _campaign THEN
        RAISE EXCEPTION 'this import id belongs to another campaign' USING ERRCODE = 'unique_violation';
      END IF;
      RETURN jsonb_build_object(
        'upload_id', existing.id, 'replayed', true,
        'total_rows', existing.total_rows, 'valid_rows', existing.valid_rows,
        'invalid_rows', existing.invalid_rows, 'duplicate_rows', existing.duplicate_rows,
        'enrolled', existing.enrolled_rows, 'already_in_campaign', existing.already_in_campaign_rows,
        'opted_out', existing.opted_out_rows);
    END IF;
  END IF;

  -- The campaign must be this organization's and still accept contacts. FOR SHARE keeps
  -- its status from changing (launch, cancel) until this import commits.
  SELECT organization_id, status INTO campaign_org, campaign_status
    FROM public.campaigns WHERE id = _campaign FOR SHARE;
  IF NOT FOUND OR campaign_org IS DISTINCT FROM _org THEN
    RAISE EXCEPTION 'Campaign not found for this organization.' USING ERRCODE = 'no_data_found';
  END IF;
  IF campaign_status NOT IN ('draft', 'scheduled', 'paused') THEN
    RAISE EXCEPTION 'Contacts cannot be added while the campaign is %.', campaign_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Phone order: concurrent imports lock shared contacts in the same order, so they
  -- queue instead of deadlocking.
  FOR r IN SELECT value FROM jsonb_array_elements(_rows) ORDER BY value->>'phone' LOOP
    incoming_name := nullif(btrim(coalesce(r->>'name', '')), '');
    SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) INTO clean_fields
      FROM jsonb_each(coalesce(r->'fields', '{}'::jsonb))
      WHERE jsonb_typeof(value) = 'string' AND btrim(value #>> '{}') <> '';

    INSERT INTO public.contacts AS c (organization_id, name, phone, custom_fields, source)
    VALUES (_org, incoming_name, r->>'phone', clean_fields, 'csv_import')
    ON CONFLICT (organization_id, phone) DO UPDATE SET
      name = coalesce(EXCLUDED.name, c.name),
      custom_fields = c.custom_fields || EXCLUDED.custom_fields
    RETURNING c.id, c.opted_out INTO v_contact_id, v_opted_out;

    IF v_opted_out THEN
      opted := opted + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.campaign_contacts (campaign_id, organization_id, contact_id, variables)
    VALUES (_campaign, _org, v_contact_id, coalesce(r->'variables', '{}'::jsonb))
    ON CONFLICT (campaign_id, contact_id) DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted = 1 THEN enrolled := enrolled + 1; ELSE already := already + 1; END IF;
  END LOOP;

  INSERT INTO public.campaign_uploads (
    campaign_id, organization_id, filename, total_rows, valid_rows, invalid_rows,
    duplicate_rows, enrolled_rows, already_in_campaign_rows, opted_out_rows,
    idempotency_key, created_by)
  VALUES (
    _campaign, _org, _filename, _total_rows, jsonb_array_length(_rows), _invalid_rows,
    _duplicate_rows, enrolled, already, opted, _idempotency_key, _user)
  RETURNING id INTO upload_id;

  RETURN jsonb_build_object(
    'upload_id', upload_id, 'replayed', false,
    'total_rows', _total_rows, 'valid_rows', jsonb_array_length(_rows),
    'invalid_rows', _invalid_rows, 'duplicate_rows', _duplicate_rows,
    'enrolled', enrolled, 'already_in_campaign', already, 'opted_out', opted);
END;
$$;

REVOKE ALL ON FUNCTION public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_campaign_contacts(uuid, uuid, uuid, text, text, integer, integer, integer, jsonb) TO service_role;
