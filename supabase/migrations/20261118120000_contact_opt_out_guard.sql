-- Contact do-not-call is permanent per workspace: once contacts.opted_out is
-- true, only the audited reversal below can make that number callable again.
-- Members can update and delete contacts directly (RLS "tenant contacts"), so
-- the rules live in the database and apply to every role, the service role
-- included. Contacts are unique per (organization_id, phone) and the phone is
-- canonical E.164, so keeping the opted-out row keeps the number suppressed:
-- re-importing or re-adding it finds this row (or fails on the unique key).
--
-- An opted-out contact cannot be:
--   - cleared (opted_out true -> false) outside reverse_contact_opt_out;
--   - renumbered or moved to another workspace (that would free the number);
--   - deleted, except when its whole workspace is being deleted;
--   - removed by TRUNCATE.
-- A repeated opt-out keeps the first time and reason. Re-runnable.

CREATE OR REPLACE FUNCTION public.contacts_opt_out_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER -- the organizations lookup must not depend on the caller's RLS view
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Allowed only as part of deleting the workspace itself (ON DELETE CASCADE
    -- from organizations: the organization row is already gone).
    IF OLD.opted_out AND EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'contact % is on the do-not-call list and cannot be deleted', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.opted_out THEN
    IF NOT NEW.opted_out
       AND coalesce(current_setting('clickai.opt_out_reversal', true), '') <> 'allowed' THEN
      RAISE EXCEPTION 'contact % is on the do-not-call list; only the audited reversal can clear it', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.phone IS DISTINCT FROM OLD.phone OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'contact % is on the do-not-call list; its number and workspace cannot change', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.opted_out THEN
      -- A repeated opt-out keeps the first record.
      NEW.opted_out_at := OLD.opted_out_at;
      NEW.opted_out_reason := OLD.opted_out_reason;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_opt_out_guard ON public.contacts;
CREATE TRIGGER trg_contacts_opt_out_guard BEFORE UPDATE OR DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_opt_out_guard();

CREATE OR REPLACE FUNCTION public.contacts_opt_out_truncate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.contacts WHERE opted_out) THEN
    RAISE EXCEPTION 'contacts holds do-not-call entries and cannot be truncated'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_opt_out_truncate_guard ON public.contacts;
CREATE TRIGGER trg_contacts_opt_out_truncate_guard BEFORE TRUNCATE ON public.contacts
  FOR EACH STATEMENT EXECUTE FUNCTION public.contacts_opt_out_truncate_guard();

-- The only way to clear do-not-call. The actor is the signed-in user of the
-- request (auth.uid(), from the JWT that PostgREST verified), never a
-- parameter: no caller can act as someone else. Only signed-in users may call
-- it; the service role cannot. The actor must be an owner/admin of the
-- contact's organization, give a reason, and the change and its audit_logs
-- row commit together or not at all.
DROP FUNCTION IF EXISTS public.reverse_contact_opt_out(uuid, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.reverse_contact_opt_out(
  p_contact_id uuid,
  p_organization_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_contact public.contacts%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR coalesce(auth.role(), '') <> 'authenticated' THEN
    RAISE EXCEPTION 'a signed-in owner or admin is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT role::text INTO v_role FROM public.organization_members
    WHERE organization_id = p_organization_id AND user_id = v_actor;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'only an owner or admin can remove a do-not-call entry'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Row lock: a concurrent delete, renumber or second reversal waits for this
  -- one, then sees its result (a second reversal finds nothing to do).
  SELECT * INTO v_contact FROM public.contacts
    WHERE id = p_contact_id AND organization_id = p_organization_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT v_contact.opted_out THEN
    RETURN; -- nothing to reverse (e.g. a duplicate request); no second audit row
  END IF;

  PERFORM set_config('clickai.opt_out_reversal', 'allowed', true);
  UPDATE public.contacts
    SET opted_out = false, opted_out_at = NULL, opted_out_reason = NULL
    WHERE id = p_contact_id;
  PERFORM set_config('clickai.opt_out_reversal', '', true);

  INSERT INTO public.audit_logs
    (admin_user_id, action, entity_type, entity_id, organization_id, old_value, new_value, reason)
  VALUES (
    v_actor,
    'contact.opt_out_reversed',
    'contact',
    p_contact_id::text,
    p_organization_id,
    jsonb_build_object(
      'opted_out', true,
      'opted_out_at', v_contact.opted_out_at,
      'opted_out_reason', v_contact.opted_out_reason,
      'phone', v_contact.phone
    ),
    jsonb_build_object('opted_out', false, 'actor_role', v_role),
    btrim(p_reason)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_contact_opt_out(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reverse_contact_opt_out(uuid, uuid, text) FROM anon, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_contact_opt_out(uuid, uuid, text) TO authenticated;

-- The guard functions are trigger-only; nobody calls them directly.
REVOKE ALL ON FUNCTION public.contacts_opt_out_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.contacts_opt_out_truncate_guard() FROM PUBLIC, anon, authenticated, service_role;
