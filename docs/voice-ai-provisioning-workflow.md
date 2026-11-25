# Automated Voice AI provisioning ("Activate Number")

Branch `feature/automated-voice-provisioning` (off `main` 3b8513e). **Not merged, not deployed, migration not applied to production.**

## What it does

A customer owner presses **Activate number** (`/app/numbers`). The backend runs one durable job per
customer (`provisioning_runs`, trigger `customer_activate`) through the existing idempotent pipeline
(`provisioning-pipeline.server.ts`). The browser only starts it and reads the persisted state.

| #     | Task step                                                                                                        | Job step key (dashboard)  | Where                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1-5   | tenant, onboarding, category, hours/services/FAQs/rules/capabilities, voice+language, number belongs to customer | `validating`              | pipeline steps 1-3 (+ business category check)                                                                 |
| –     | customer's integration credential exists                                                                         | `preparing`               | pipeline step 4 (still issued by an admin)                                                                     |
| 6     | create or retrieve the customer's Sarvam agent                                                                   | `creating_agent`          | `ensureCustomerAgent` (interface) / admin registration                                                         |
| 7-8   | configure from template + business data                                                                          | `configuring_agent`       | `AgentProvisioner.configureAgent` / admin                                                                      |
| 9     | verify agent                                                                                                     | `verifying_agent`         | `AgentProvisioner.verifyAgent`, master-template and voice-applied checks                                       |
| 10    | create customer deployment                                                                                       | `creating_deployment`     | `createInboundDeploymentForNumbers` (adopts, never duplicates)                                                 |
| 11    | verify deployment                                                                                                | `verifying_deployment`    | status, agent id, version, webhook token                                                                       |
| 12    | connect the Vobiz number to the deployment                                                                       | `connecting_number`       | the number is routed by the Sarvam deployment (`connection_configs.phone_numbers`); ClickAI's row points at it |
| 13-14 | verify mapping + non-billable, non-call checks                                                                   | `verifying_number`        | Sarvam routes the number, ClickAI record matches, verified ids saved while still inactive                      |
| 15    | mark complete and activate                                                                                       | `activating` → `complete` | resume, read back, re-verify, only then `phone_numbers.status = active`                                        |

Nothing buys/claims a number, places a call, or touches billing.

## Honest limits (needs live verification)

- **Sarvam documents no agent create/clone/configure/commit API.** `unsupportedAgentProvisioner`
  is the only shipped implementation, so `creating_agent` ends in `waiting` with code
  `PROVIDER_CAPABILITY_UNVERIFIED` and an admin registers the customer's agent by hand (existing
  admin screen); the job then resumes. Implementing `AgentProvisioner` against a real API is the
  only change needed; its find-before-create, ambiguous-timeout and verify-before-register logic is
  already tested with mocks.
- The Vobiz→Sarvam connection is not a separate API call: Sarvam routes a rented number through the
  deployment. Whether a number is already on the customer's Sarvam connection is confirmed by an
  admin (existing `waiting_for_number_confirmation`); Sarvam has no number list/import API.
- The integration credential (step "preparing") is still issued by an admin (shown once).
- Everything provider-facing is verified against mocks only. A live activation has not been run.

## Reliability

- One active job per organization (`idx_provisioning_runs_one_active`) and per number
  (`idx_provisioning_runs_one_active_number`, new). Claim is an optimistic conditional update; a
  crashed attempt is reclaimed after 10 minutes.
- Resume: every attempt re-reads real DB/Sarvam state, so finished work is never repeated
  (deployment adopted, agent looked up by deterministic name `clickai-<org8>-<agent8>` first).
  `step_states`, `current_job_step`, `last_checkpoint` record where it is.
- Transient failures (`retryable`): pending + `next_attempt_at` (30 s, 1 m, 2 m, 4 m …, capped 15 m),
  at most 5 attempts, then `failed` / `RETRIES_EXHAUSTED` (retryable by hand). Permanent failures
  (`retryable = false`) are never retried automatically. A sweeper route
  `POST /api/public/cron/provisioning-retry` (Bearer `LOVABLE_CRON_SECRET`, **must be scheduled every
  minute externally like the other cron routes**) runs due jobs and stuck `running` ones.
- Ambiguous timeouts: never blindly recreated; lookup first (agent by name, deployment by number).
- Failure codes: see `FailureCode` in `src/lib/voice-provisioning-job.ts`. Customers only get a
  fixed plain message; admins get code, step, sanitized note, failing check ids, event trail.
  `sanitizeDiagnostic` strips tokens, URLs, long opaque ids and phone numbers.
- The number stays `inactive` until the final read-back passes; the admission gate additionally
  serves no business data to an unverified deployment.

## Data

Migration `20261203090000_voice_provisioning_job.sql` (additive; rollback
`docs/production-rollback-20261203090000-voice-provisioning-job.sql`, refuses while events exist
unless `rollback.discard_job_data = 'yes'`): extra columns on `provisioning_runs`, the per-number
unique index, and append-only `provisioning_run_events` (service role only; RLS on, no
anon/authenticated grants). Customers read only through owner-checked server functions.

## Customer / admin UI

- `/app/numbers`: real steps from `getMyActivationStatus` (polls every 3 s while busy), phases
  queued / running / retrying / waiting / failed / completed, "Try again" only when eligible, button
  disabled while busy. Survives refresh (state is in the DB).
- `/admin/provisioning` queue gains `retrying` and `stuck`; `/admin/provisioning/$orgId` gains the
  "Voice AI activation job" panel (steps, failure code, retryable vs permanent, agent/deployment
  ids, sanitized diagnostics, event trail). Admin "Retry provisioning" now forces the next attempt.

## Live verification checklist (not done)

1. Review, then apply the migration with a guarded single-transaction gate script (not produced yet).
2. Schedule `provisioning-retry` every minute.
3. On a **test** customer (never Smile Dental) with an admin-confirmed, unused Sarvam number and a
   hand-registered agent: press Activate; expect steps to reach `complete`, number `active`.
4. Check in Sarvam: one deployment, paused→active, routes only that number; ClickAI row verified ids set.
5. Press Activate again / reload during the run: no second deployment or job.
6. Only then one supervised inbound test call.
