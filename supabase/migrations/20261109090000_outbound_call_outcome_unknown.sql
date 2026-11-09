-- Adds the explicit `outcome_unknown` status to call_logs and campaign_contacts.
--
-- A Sarvam outbound start request that times out, fails at the network level
-- or gets an ambiguous provider response (5xx, 408, 409, 429, ...) does not
-- prove the call was or wasn't placed. Such a call (and its campaign contact)
-- is held in `outcome_unknown` until a webhook, a conclusive reconciliation or
-- an operator resolves it — never failed or retried automatically.
--
-- Also adds a per-number reservation index for Sarvam outbound calls (below).
--
-- Purely additive: both CHECK lists keep every existing value. Existing
-- indexes already behave correctly with the new value:
--   * idx_call_logs_campaign_contact_inflight treats every non-terminal status
--     as in flight, so an outcome_unknown call still blocks a second call row
--     for the same campaign contact.
--   * idx_campaign_contacts_due only covers pending/retry_scheduled, so an
--     outcome_unknown contact is never picked up by the dispatcher.

ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_status_check;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_status_check
  CHECK (status IN ('initiated', 'ringing', 'answered', 'in_progress', 'completed', 'failed', 'busy', 'no_answer', 'cancelled', 'outcome_unknown'));

ALTER TABLE public.campaign_contacts DROP CONSTRAINT IF EXISTS campaign_contacts_status_check;
ALTER TABLE public.campaign_contacts ADD CONSTRAINT campaign_contacts_status_check CHECK (status IN (
  'pending','queued','calling','connected','no_answer','busy','failed',
  'completed','retry_scheduled','opted_out','wrong_number','cancelled','outcome_unknown'
));

-- Read-only report of stored contact numbers that aren't in the canonical form
-- every outbound path now uses (normalizeCustomerPhone in phone-number.ts):
-- for India, "+91" followed by exactly ten digits, the first not 0. The
-- contacts CHECK already guarantees "+<digits>" with no separators, so only
-- +91 numbers can be non-canonical (e.g. "+910987654321"). Such a contact is
-- marked wrong_number by the campaign dispatcher instead of being dialled.
-- Nothing is changed here; fix the numbers in the dashboard if this reports any.
DO $$
DECLARE
  non_canonical integer;
BEGIN
  SELECT count(*) INTO non_canonical FROM public.contacts
  WHERE phone LIKE '+91%' AND phone !~ '^\+91[1-9][0-9]{9}$';
  IF non_canonical > 0 THEN
    RAISE NOTICE 'Found % contact phone number(s) that are not canonical Indian E.164 (+91 followed by 10 digits, not starting with 0). Campaigns will not dial them. Query: SELECT id, organization_id, phone FROM public.contacts WHERE phone LIKE ''+91%%'' AND phone !~ ''^\+91[1-9][0-9]{9}$'';', non_canonical;
  END IF;
END $$;

-- Atomic per-number reservation for Sarvam outbound calls — single calls and
-- campaign calls alike: at most one unresolved call per organization and
-- destination number. Both paths insert their call_logs row (auto-committed)
-- before Sarvam is contacted, so concurrent requests race on this index and
-- the losing insert fails (23505) before anything is dialled — including
-- while provider_call_id is still NULL. A conflicting insert waits only for
-- the other insert's own commit, never for a Sarvam request.
--
-- "Unresolved" = initiated or outcome_unknown: exactly the statuses an
-- operator can resolve from the admin Calls page, so a row left behind by a
-- crash never locks the number for good.
--
-- This complements, and does not replace, idx_call_logs_campaign_contact_inflight
-- (one in-flight call per campaign contact). The campaign dispatcher handles a
-- conflict here by undoing its claim on the contact and deferring it to a
-- later run (campaign-dispatch.server.ts / releaseCampaignClaim).
--
-- Not covered: Sarvam-side campaign mode (KLYRO_DISPATCH_MODE=sarvam_campaign,
-- disabled), where Sarvam dials from an uploaded cohort and Klyro writes no
-- call_logs row before the call.
--
-- destination_number IS NOT NULL is explicit: every Sarvam outbound insert sets
-- it (an E.164 number), and NULLs never compare equal in a unique index
-- anyway, so a row without one can't reserve anything.
--
-- If unresolved duplicates already exist, stop with an actionable message
-- before touching the index. The whole migration runs in one transaction, so
-- nothing above is kept either: resolve the extra calls (admin → Calls →
-- Needs review), then re-run.
DO $$
DECLARE
  duplicate_pairs integer;
BEGIN
  SELECT count(*) INTO duplicate_pairs FROM (
    SELECT 1 FROM public.call_logs
    WHERE provider = 'sarvam'
      AND direction = 'outbound'
      AND destination_number IS NOT NULL
      AND status IN ('initiated', 'outcome_unknown')
    GROUP BY organization_id, destination_number
    HAVING count(*) > 1
  ) d;
  IF duplicate_pairs > 0 THEN
    RAISE EXCEPTION 'Cannot add idx_call_logs_sarvam_outbound_number_reservation: % organization/number pair(s) already have more than one unresolved Sarvam outbound call (status initiated or outcome_unknown).', duplicate_pairs
      USING HINT = 'Resolve the extra calls first (admin Calls page, "Needs review"), then re-run this migration. Nothing from this migration was applied.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_logs_sarvam_outbound_number_reservation
  ON public.call_logs (organization_id, destination_number)
  WHERE provider = 'sarvam'
    AND direction = 'outbound'
    AND destination_number IS NOT NULL
    AND status IN ('initiated', 'outcome_unknown');
