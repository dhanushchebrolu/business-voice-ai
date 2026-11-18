-- Rollback for 20261118120000_contact_opt_out_guard.sql. Run only with approval,
-- after the Worker is back on a version that does not call
-- reverse_contact_opt_out (the Contacts page "remove from do-not-call" path).
-- Removes only what the migration added. No contact, opt-out value or audit
-- row is changed: contacts stay opted out; only the database enforcement goes.
--
-- Pre-check (read-only): what the guard currently protects, and past reversals.
--   SELECT organization_id, count(*) FROM public.contacts WHERE opted_out GROUP BY 1;
--   SELECT count(*) FROM public.audit_logs WHERE action = 'contact.opt_out_reversed';

BEGIN;
DROP TRIGGER IF EXISTS trg_contacts_opt_out_guard ON public.contacts;
DROP TRIGGER IF EXISTS trg_contacts_opt_out_truncate_guard ON public.contacts;
DROP FUNCTION IF EXISTS public.contacts_opt_out_guard();
DROP FUNCTION IF EXISTS public.contacts_opt_out_truncate_guard();
DROP FUNCTION IF EXISTS public.reverse_contact_opt_out(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.reverse_contact_opt_out(uuid, uuid, uuid, text); -- earlier local draft only
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261118120000';
COMMIT;
