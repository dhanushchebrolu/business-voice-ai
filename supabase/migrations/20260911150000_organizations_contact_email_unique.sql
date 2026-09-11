-- createClientAccount already app-level-enforces "one workspace per contact
-- email" (an ILIKE pre-check against public.organizations before the
-- insert), but that is a check-then-insert race: two concurrent
-- "Create client" submissions for the same email could both pass the
-- pre-check and both insert, leaving two workspaces for one customer.
--
-- This adds the actual race-safe guarantee at the database level. It is a
-- partial, case-insensitive unique index — case-insensitive to match the
-- app's ILIKE semantics, partial (WHERE contact_email IS NOT NULL) so it
-- never conflicts on NULL, which Postgres unique indexes already treat as
-- distinct from every other NULL, but being explicit here documents the
-- intent rather than relying on that default.
--
-- A second, concurrent create for the same email now fails with a
-- unique_violation (23505) instead of silently succeeding twice; the admin
-- server function catches that and returns a clear "already exists" error
-- instead of exposing the raw constraint name.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_contact_email_unique
  ON public.organizations (lower(contact_email))
  WHERE contact_email IS NOT NULL;
