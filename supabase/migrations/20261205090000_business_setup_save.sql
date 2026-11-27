-- The setup wizard saves a customer's business setup in ONE database transaction, one
-- submission at a time per customer.
--
--   save_business_setup(_org, _initial, _changes)
--       Runs as the signed-in member (SECURITY INVOKER): row-level security and column grants
--       apply exactly as for direct writes. A per-customer advisory lock makes concurrent
--       submissions (two tabs, retries) wait for each other, so they resolve to the same
--       business and receptionist. _changes is what the person typed; it is applied, but a blank
--       value never replaces a saved one. _initial only fills what does not exist yet.
--       A row is written only when something in it differs, so a retry changes nothing.
--       Nothing is ever deleted or merged.
--
--   one_setup_per_customer (trigger on businesses and agent_configs)
--       A browser session cannot INSERT a second business or receptionist for a customer who has
--       one, whatever code it runs. Rows that already exist are left alone, and server-side
--       writes are not restricted (a customer may hold several businesses by other means).
--
-- Apply BEFORE deploying the code that calls the function. Re-runnable. No existing row changes.
-- Rollback: docs/production-rollback-20261205090000-business-setup-save.sql

CREATE OR REPLACE FUNCTION public.lock_business_setup(_org uuid)
RETURNS void LANGUAGE sql SET search_path = public AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('business_setup:' || _org::text, 0))
$$;

-- SECURITY DEFINER so the check sees every row of that customer, whatever the caller may read.
CREATE OR REPLACE FUNCTION public.one_setup_per_customer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_taken boolean;
BEGIN
  PERFORM public.lock_business_setup(NEW.organization_id);
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE organization_id = $1)', TG_TABLE_NAME)
    INTO v_taken USING NEW.organization_id;
  IF v_taken THEN
    RAISE EXCEPTION 'BUSINESS_SETUP_EXISTS: this customer already has a record in %', TG_TABLE_NAME
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.one_setup_per_customer() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_businesses_one_per_customer ON public.businesses;
CREATE TRIGGER trg_businesses_one_per_customer
  BEFORE INSERT ON public.businesses
  FOR EACH ROW WHEN (current_user = 'authenticated')
  EXECUTE FUNCTION public.one_setup_per_customer();

DROP TRIGGER IF EXISTS trg_agent_configs_one_per_customer ON public.agent_configs;
CREATE TRIGGER trg_agent_configs_one_per_customer
  BEFORE INSERT ON public.agent_configs
  FOR EACH ROW WHEN (current_user = 'authenticated')
  EXECUTE FUNCTION public.one_setup_per_customer();

CREATE OR REPLACE FUNCTION public.save_business_setup(_org uuid, _initial jsonb, _changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_business uuid;
  v_agent uuid;
  v_created_business boolean := false;
  v_created_agent boolean := false;
  -- Blank answers are dropped: they never overwrite anything.
  b jsonb;
  bi jsonb;
  a jsonb;
  ai jsonb;
  s record;
  v_language text;
  v_greeting text;
BEGIN
  IF NOT public.is_org_member(_org) THEN
    RAISE EXCEPTION 'BUSINESS_SETUP_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  PERFORM public.lock_business_setup(_org);

  SELECT coalesce(jsonb_object_agg(key, btrim(value)), '{}') INTO b
    FROM jsonb_each_text(coalesce(_changes->'business', '{}')) WHERE btrim(value) <> '';
  SELECT coalesce(jsonb_object_agg(key, btrim(value)), '{}') INTO bi
    FROM jsonb_each_text(coalesce(_initial->'business', '{}')) WHERE btrim(value) <> '';
  SELECT coalesce(jsonb_object_agg(key, btrim(value)), '{}') INTO a
    FROM jsonb_each_text(coalesce(_changes->'agent', '{}')) WHERE btrim(value) <> '';
  SELECT coalesce(jsonb_object_agg(key, btrim(value)), '{}') INTO ai
    FROM jsonb_each_text(
      coalesce(_initial->'agent', '{}') - 'capabilities' - 'objectives')
    WHERE btrim(value) <> '';

  -- The receptionist's business if there is one, else the customer's first business.
  SELECT id, business_id INTO v_agent, v_business FROM public.agent_configs
    WHERE organization_id = _org ORDER BY created_at, id LIMIT 1;
  IF v_business IS NULL THEN
    SELECT id INTO v_business FROM public.businesses
      WHERE organization_id = _org ORDER BY created_at, id LIMIT 1;
  END IF;

  IF v_business IS NULL THEN
    IF coalesce(b->>'name', bi->>'name') IS NULL THEN
      RAISE EXCEPTION 'BUSINESS_SETUP_NAME_REQUIRED' USING ERRCODE = '22023';
    END IF;
    bi := bi || b;
    INSERT INTO public.businesses (organization_id, name, business_type, description, address,
      city, state, postal_code, primary_phone, email, website)
    VALUES (_org, bi->>'name', coalesce(bi->>'business_type', 'other'), bi->>'description',
      bi->>'address', bi->>'city', bi->>'state', bi->>'postal_code', bi->>'primary_phone',
      bi->>'email', bi->>'website')
    RETURNING id INTO v_business;
    v_created_business := true;
  ELSIF b <> '{}' THEN
    UPDATE public.businesses SET
      name = coalesce(b->>'name', name),
      business_type = coalesce(b->>'business_type', business_type),
      description = coalesce(b->>'description', description),
      address = coalesce(b->>'address', address),
      city = coalesce(b->>'city', city),
      state = coalesce(b->>'state', state),
      postal_code = coalesce(b->>'postal_code', postal_code),
      primary_phone = coalesce(b->>'primary_phone', primary_phone),
      email = coalesce(b->>'email', email),
      website = coalesce(b->>'website', website)
    WHERE id = v_business AND organization_id = _org AND NOT to_jsonb(businesses) @> b;
  END IF;

  -- Hours: missing days are filled (only until the setup is complete); edited days are written.
  IF v_agent IS NULL THEN
    INSERT INTO public.business_hours (organization_id, business_id, day_of_week, is_closed, intervals)
    SELECT _org, v_business, h.day_of_week, h.is_closed, coalesce(h.intervals, '[]')
      FROM jsonb_to_recordset(coalesce(_initial->'hours', '[]'))
        AS h(day_of_week smallint, is_closed boolean, intervals jsonb)
    ON CONFLICT (business_id, day_of_week) DO NOTHING;
  END IF;
  INSERT INTO public.business_hours (organization_id, business_id, day_of_week, is_closed, intervals)
  SELECT _org, v_business, h.day_of_week, h.is_closed, coalesce(h.intervals, '[]')
    FROM jsonb_to_recordset(coalesce(_changes->'hours', '[]'))
      AS h(day_of_week smallint, is_closed boolean, intervals jsonb)
  ON CONFLICT (business_id, day_of_week)
    DO UPDATE SET is_closed = EXCLUDED.is_closed, intervals = EXCLUDED.intervals
    WHERE (business_hours.is_closed, business_hours.intervals)
      IS DISTINCT FROM (EXCLUDED.is_closed, EXCLUDED.intervals);

  -- Services: an edited saved one by id; a new one only if no service has that name.
  FOR s IN
    SELECT * FROM jsonb_to_recordset(coalesce(_changes->'services', '[]'))
      AS x(id uuid, name text, price numeric)
  LOOP
    IF s.id IS NOT NULL THEN
      UPDATE public.services
         SET name = coalesce(nullif(btrim(s.name), ''), name), price = coalesce(s.price, price)
       WHERE id = s.id AND business_id = v_business AND organization_id = _org
         AND (name, price) IS DISTINCT FROM
             (coalesce(nullif(btrim(s.name), ''), name), coalesce(s.price, price));
    ELSIF nullif(btrim(s.name), '') IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.services
                  WHERE business_id = v_business AND lower(btrim(name)) = lower(btrim(s.name))) THEN
        UPDATE public.services SET price = s.price
         WHERE business_id = v_business AND lower(btrim(name)) = lower(btrim(s.name))
           AND s.price IS NOT NULL AND price IS DISTINCT FROM s.price;
      ELSE
        INSERT INTO public.services (organization_id, business_id, name, price, sort_order)
        SELECT _org, v_business, btrim(s.name), s.price, coalesce(max(sort_order) + 1, 0)
          FROM public.services WHERE business_id = v_business;
      END IF;
    END IF;
  END LOOP;

  IF v_agent IS NULL THEN
    -- Suggested answers and rules come once, with the first complete save.
    IF NOT EXISTS (SELECT 1 FROM public.faqs WHERE business_id = v_business) THEN
      INSERT INTO public.faqs (organization_id, business_id, question, answer, sort_order)
      SELECT _org, v_business, f->>'question', f->>'answer', (n - 1)::int
        FROM jsonb_array_elements(coalesce(_initial->'faqs', '[]')) WITH ORDINALITY AS t(f, n);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.business_rules WHERE business_id = v_business) THEN
      INSERT INTO public.business_rules (organization_id, business_id, rule, priority)
      SELECT _org, v_business, r, n::int
        FROM jsonb_array_elements_text(coalesce(_initial->'rules', '[]')) WITH ORDINALITY AS t(r, n);
    END IF;

    ai := ai || a;
    v_language := coalesce(ai->>'primary_language', 'en-IN');
    INSERT INTO public.agent_configs (organization_id, business_id, agent_name, primary_language,
      voice_id, greetings, capabilities, objectives)
    VALUES (_org, v_business, coalesce(ai->>'agent_name', 'Aria'), v_language,
      coalesce(ai->>'voice_id', 'ritu'),
      CASE WHEN ai->>'greeting' IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object(v_language, ai->>'greeting') END,
      coalesce(_initial->'agent'->'capabilities', '{}'),
      ARRAY(SELECT jsonb_array_elements_text(
        coalesce(_initial->'agent'->'objectives', '["answer_questions"]'))));
    v_created_agent := true;
  ELSIF a <> '{}' THEN
    SELECT coalesce(a->>'primary_language', primary_language),
           coalesce(a->>'greeting',
             -- A newly chosen language without a greeting gets the one on screen.
             CASE WHEN a ? 'primary_language'
                       AND NOT coalesce(greetings, '{}') ? (a->>'primary_language')
                  THEN ai->>'greeting' END)
      INTO v_language, v_greeting
      FROM public.agent_configs WHERE id = v_agent;
    UPDATE public.agent_configs SET
      agent_name = coalesce(a->>'agent_name', agent_name),
      primary_language = v_language,
      voice_id = coalesce(a->>'voice_id', voice_id),
      greetings = CASE WHEN v_greeting IS NULL THEN greetings
                       ELSE coalesce(greetings, '{}') || jsonb_build_object(v_language, v_greeting) END
    WHERE id = v_agent AND organization_id = _org
      AND ((a ? 'agent_name' AND agent_name IS DISTINCT FROM a->>'agent_name')
        OR (a ? 'voice_id' AND voice_id IS DISTINCT FROM a->>'voice_id')
        OR primary_language IS DISTINCT FROM v_language
        OR (v_greeting IS NOT NULL AND greetings->>v_language IS DISTINCT FROM v_greeting));
  END IF;

  UPDATE public.organizations SET onboarding_completed = true
   WHERE id = _org AND NOT onboarding_completed;

  RETURN jsonb_build_object('business_id', v_business,
    'created_business', v_created_business, 'created_agent', v_created_agent);
END $$;
REVOKE ALL ON FUNCTION public.lock_business_setup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lock_business_setup(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.save_business_setup(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_business_setup(uuid, jsonb, jsonb) TO authenticated;
