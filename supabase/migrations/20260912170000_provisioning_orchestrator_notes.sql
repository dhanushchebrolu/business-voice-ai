-- Automatic provisioning orchestrator: honest status trail
--
-- The Razorpay webhook's setup_fee branch now triggers automatic
-- provisioning (claim a pool number, link it to the org's Sarvam
-- connection/agent if already mapped, attempt an inbound deployment) — see
-- provisioning-orchestrator.server.ts. Two things can genuinely still block
-- full automation (a Sarvam connection not yet registered for this org, no
-- number left in the pool, the Sarvam API call itself failing) and this
-- must never be hidden behind a lifecycle_status that claims more progress
-- than actually happened. These two columns are the honest record of what
-- the orchestrator's last attempt actually did/could not do — surfaced
-- read-only in the admin provisioning view and mapped to a customer-safe
-- status label, never a raw error string, on the client dashboard.
--
-- No parallel status system: lifecycle_status (added 20260902060038)
-- remains the one source of truth for WHICH stage the organization is in;
-- these columns only explain the most recent attempt at that stage.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS provisioning_note text,
  ADD COLUMN IF NOT EXISTS provisioning_attempted_at timestamptz;
