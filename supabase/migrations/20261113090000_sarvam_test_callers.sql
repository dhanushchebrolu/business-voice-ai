-- Test-mode isolation for Sarvam inbound agents.
-- Calls from a number on this list are test calls: book_appointment checks the slot but never
-- writes a booking, and record_call_outcome never creates a lead. Everything else is unchanged.
-- Rollback: ALTER TABLE public.sarvam_agent_integrations DROP COLUMN test_caller_numbers;

ALTER TABLE public.sarvam_agent_integrations
  ADD COLUMN IF NOT EXISTS test_caller_numbers text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.sarvam_agent_integrations
  DROP CONSTRAINT IF EXISTS sarvam_agent_integrations_test_callers_check;
ALTER TABLE public.sarvam_agent_integrations
  ADD CONSTRAINT sarvam_agent_integrations_test_callers_check CHECK (
    cardinality(test_caller_numbers) <= 20
    AND array_to_string(test_caller_numbers, ',') ~ '^(\+[1-9][0-9]{6,14}(,\+[1-9][0-9]{6,14})*)?$'
  );
