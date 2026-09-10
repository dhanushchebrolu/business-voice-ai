-- Atomic first-platform-admin bootstrap.
--
-- Prior to this migration, claimPlatformAdmin (admin.functions.ts) claimed
-- the first platform admin with a two-step "SELECT count(*) WHERE
-- is_active, then INSERT" using the service-role client. Those are two
-- separate round trips: two concurrent bootstrap calls (different users,
-- both holding the correct PLATFORM_ADMIN_BOOTSTRAP_SECRET) could each see
-- the table empty before either INSERT commits, and both would succeed,
-- producing two "first" admins instead of one.
--
-- This function moves the whole check-then-insert into a single
-- SECURITY DEFINER transaction serialized by a Postgres advisory lock, so
-- only the first caller to reach it can ever see platform_admins empty.
-- Every later caller (post-lock) re-checks against the now-committed state
-- and is turned away. is_active is intentionally still an ordinary,
-- freely-toggleable column afterwards — this only makes the *bootstrap*
-- race safe; it does not restrict the platform to a single active admin
-- (see upsertPlatformAdmin, which grants additional admins after bootstrap).
CREATE OR REPLACE FUNCTION public.bootstrap_first_platform_admin(p_user_id uuid, p_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Serializes every concurrent bootstrap attempt against every other one,
  -- regardless of which user is calling. The lock is released automatically
  -- when this transaction ends (commit or rollback) — no unlock needed, and
  -- no lock is held across calls.
  PERFORM pg_advisory_xact_lock(hashtext('platform_admin_bootstrap'));

  IF EXISTS (SELECT 1 FROM public.platform_admins WHERE is_active) THEN
    RETURN false;
  END IF;

  INSERT INTO public.platform_admins (user_id, email, role, is_active)
  VALUES (p_user_id, p_email, 'super_admin', true)
  ON CONFLICT (user_id) DO UPDATE
    SET email = excluded.email,
        role = 'super_admin',
        is_active = true,
        updated_at = now();

  RETURN true;
END;
$$;

-- Callable only from server-side code holding the service_role key
-- (supabaseAdmin) — never from an authenticated user's own session, and
-- never anonymously. The secret/identity checks stay in claimPlatformAdmin;
-- this function only makes the DB half of that operation atomic.
REVOKE ALL ON FUNCTION public.bootstrap_first_platform_admin(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_first_platform_admin(uuid, text) TO service_role;
