# Automated Voice AI provisioning ("Activate Number")

Branch `feature/automated-voice-provisioning` (off `main` 3b8513e). **Not merged, not deployed, migration not applied to production.**

## What it does

A customer owner submits their setup: **Submit setup**, or **Activate number** once a number is
assigned (`/app/numbers`). The backend runs one durable job per customer (`provisioning_runs`,
trigger `customer_activate`) through the existing idempotent pipeline
(`provisioning-pipeline.server.ts`). The browser only starts it and reads the persisted state.

## What starts provisioning

| Event                                                           | Starts a job?                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Signup, accepting an invitation                                 | no                                                                  |
| Payment (setup fee, phone service fee, monthly plan)            | **no**: it records the payment; the setup fee unlocks the dashboard |
| Finishing the setup wizard, saving business details             | no                                                                  |
| Customer submits an **incomplete** setup                        | no: refused with what is missing                                    |
| Customer submits a **complete** setup                           | **yes**, one per customer; again joins the same job                 |
| Admin actions on the provisioning page (run, register an agent) | yes (a deliberate operator step)                                    |
| Background sweep                                                | never creates a job; continues existing ones                        |

### The setup wizard (migrations `20261205090000` before deploying, `20261206090000` after)

- It opens with everything already saved (the receptionist's business, else the first one) and does
  not open until that has been read; a failed read offers a retry.
- One database call, `save_business_setup`, saves in a single transaction, as the signed-in member.
  A per-customer lock makes two tabs or a retry wait their turn and land on the same records.
- Only what the person edited is applied, and a blank never replaces a saved value (to clear a field,
  use the Business page). Untouched days keep their own hours and breaks. The same submission again
  writes nothing. Two people editing the same field: the later save wins.
- A browser session cannot insert a second business or receptionist for a customer (trigger,
  `20261206090000`). Server-side writes can, and existing duplicate records are left exactly as they
  are.
- A customer with no receptionist record is sent back to the wizard.
- Two migrations because the build that is live today saves the wizard with direct inserts:
  `20261205090000` (the function) does not affect it; `20261206090000` (the trigger) would refuse its
  retry after a failed save, so apply it only after this code is live and remove it before rolling the
  code back. See `production-migration-checklist.md` and `production-deployment-runbook.md`.

"Complete" (`businessSetupProblems`): a business profile and receptionist, a category, a business
name, and the data every switched-on capability needs. Voice and languages and the number are the
team's steps: the job waits for them. Eligibility to submit is the existing phone feature lock;
this change adds no payment rule. A waiting job continues by itself once the missing step is done (see
[Continuing a waiting job](#continuing-a-waiting-job)).

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

- **Sarvam agent authoring (checked 2026-11-25 against docs.sarvam.ai/voice-agents/llms.txt,
  /api/introduction.md and /mcp.md):** the public REST API (`X-API-Key`) covers deployments,
  campaigns, instant outbound, analytics, boards, tests, webhook configs, experiments and BYOK, with
  **no agent create/clone/configure/commit endpoint**. The only documented route is the Voice Agents
  MCP server (`https://mcp.sarvam.ai/voice-agents`), which does expose agent create/clone/configure/
  commit but authenticates through interactive Sarvam SSO OAuth, one org/workspace per login, **token
  valid 24 h with no refresh token**. That is a human-in-the-loop tool, not a server-to-server API, so
  it is deliberately not automated here (no headless SSO, no stored tokens, no undocumented endpoints).
  `unsupportedAgentProvisioner` stays the only implementation: `creating_agent` ends in `waiting`
  (`AWAITING_AGENT_CREATION`). Handoff: registering the agent (admin "Register agent")
  immediately re-runs the customer's open job, and the scheduled sweep continues it if that call fails.
  If Sarvam ships a keyed agent API, implement `AgentProvisioner` and return it from
  `defaultAgentProvisioner()`.
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
  at most 5 _consecutive failed_ attempts (clicks or sweeps that merely found the job waiting do not
  count), then `failed` / `RETRIES_EXHAUSTED` (retryable by hand). Permanent failures
  (`retryable = false`) are never retried automatically.
- **Scheduling uses the existing system**: job kind `sweep.provisioning_retry` is enqueued every
  minute by `periodicJobs` (`src/lib/jobs/scheduler.server.ts`), driven by the Worker cron
  `* * * * *` in `wrangler.json` via `server/plugins/scheduled-jobs.ts`. No extra trigger or
  secret. It resumes due retries, crashed (`running` > 10 min) jobs, and customer-started jobs
  whose prerequisites changed while they waited (below). Bounded to 3 jobs / 15 s per tick. Kill switch:
  `JOBS_SCHEDULER_ENABLED=false` (stops all sweeps).
- Ambiguous timeouts: never blindly recreated; lookup first (agent by name, deployment by number).
- Failure codes: see `FailureCode` in `src/lib/voice-provisioning-job.ts`. Customers only get a
  fixed plain message; admins get code, step, sanitized note, failing check ids, event trail.
  `sanitizeDiagnostic` strips tokens, URLs, long opaque ids and phone numbers.
- The number stays `inactive` until the final read-back passes; the admission gate additionally
  serves no business data to an unverified deployment.

## Continuing a waiting job

Every step a person takes continues a **customer-started** job within about a minute, with no
**Retry**: saving or applying voice and languages, assigning a number, registering the connection,
confirming the number, issuing a credential, registering an agent, reporting or confirming tool
credentials (inbound and outbound), releasing a wrong agent ID, and, while the job waits for the
business setup, changes to the business, hours, services, FAQs, rules, knowledge or receptionist.

The sweep reads the database, not the screen the change came from. Each attempt records a digest of
the facts in `WAITED_ON` (`provisioning-runs.server.ts`) before working; the sweep resumes a waiting
job when the digest differs. The digest holds only what a person changes: not a number's link,
deployment, verification or activation (the job writes those), not a credential's last use, no clock.
So an unchanged job is never re-run, and a change made during an attempt still counts.

- The sweep never creates a job: one that finished after the sweep listed it stays finished.
- Jobs started by an admin action or a payment are not resumed automatically.
- Not detected (still need **Check again** or **Retry provisioning**): Worker configuration such as a
  replaced Sarvam key, and anything changed only in Sarvam.
- A permanently failed job is not resumed.
- On the first sweep after deployment, every waiting customer-started job runs once.

## Live and switched-off numbers, and the deployment lock

**A number that has gone live** (status `active`, even with inbound switched off) is never changed by
a provisioning attempt, whoever starts it (**Retry**, **Check again**, an agent registration, the
operator bridge or the sweep): nothing is created, paused, resumed, edited, re-linked or switched on.

| Attempt                                    | Sarvam calls | Result when the saved verification matches | Otherwise          |
| ------------------------------------------ | ------------ | ------------------------------------------ | ------------------ |
| The sweep, including its automatic retries | none         | outbound steps only                        | stops for a person |
| Any attempt on a number with inbound off   | none         | outbound steps only; left off              | stops for a person |
| Any attempt on a suspended number          | none         | stops at once                              | stops at once      |
| A person's attempt on a line that is on    | one read     | outbound steps                             | stops for a person |

"Stops for a person" is a failed job that is not retried by itself. A definite identity mismatch in a
person's read still withdraws the saved verification (the admission gate then serves no business data).
Changing a live deployment is only done by its own admin actions, each under the deployment lock below:
**Re-verify live deployment** or registering a new version of the same agent (checked with Sarvam
before it is saved; one cut off after Sarvam accepted it is finished by running it again),
pause/resume, webhook update, and sync (which only restores the verified version).

**Agent mapping.** While a number is live, or verified and suspended, its agent id and version change
only through that checked move. The operator bridge, template mapping and direct registration are
refused; with inbound off, turn it on first.

**Switched off** (suspended, or active with inbound off): the customer sees "Your number is switched
off" with nothing to press, and no deployment can be created for it.

**While a number is still being set up**, an attempt stops if a person suspends or releases it
meanwhile, and activation applies only from the status the attempt started with.

**Activate (admin)** takes the deployment lock, so it is refused while another change is in progress.
For a Sarvam number with a deployment, Sarvam must report it active; a paused or unreadable one is
not activated, and nothing is resumed for you. Resume it (or retry provisioning), then activate.

**Deployment lock.** One per number (`phone_numbers.metadata.deployment_lock`, compare-and-swap, no
migration), held by every change to its deployment or mapping: creation and adoption, the job from
verification to activation (including a person's read of a live number), sync, the live version move,
webhook update and its recovery, admin pause/resume and agent mapping changes. A second change is
refused as "in progress" (the job retries a not-yet-live number with backoff). Each holder confirms it
still has the lock before changing Sarvam. A crashed holder blocks that number, **including admin
pause**, until the lock lapses after 5 minutes. Description-only edits do not take it.

**Recovery.** A deployment found at Sarvam is adopted only if it is the only one routing the number,
runs this customer's agent and routes exactly that number. A recorded deployment of another agent or
number is never paused, edited or resumed. Both lookups rely on Sarvam's deployment search finding
the number, which has not been verified live. Reassigning a number drops its deployment,
verification and confirmation; remove the old deployment in Sarvam before provisioning it again. A
reassignment made while a deployment is being created leaves that deployment unrecorded.

**Interrupted pauses.** Before sync, the live version move or a webhook update pauses an active
deployment, it records `phone_numbers.metadata.sarvam_webhook_recovery`; if it cannot, nothing is
paused. The record is cleared only when Sarvam confirms the deployment active, or when an admin
pauses it. While it stands:

| Action                         | Effect                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Sync                           | changes nothing and reports an error, never `in_sync`                                       |
| Re-verify / register a version | puts the verified version back, resumes it, then does what was asked                        |
| Resume deployment              | resumes it if agent, number and a safe version match; never an unverified live version move |
| Webhook update                 | refused until resumed                                                                       |

Nothing resumes it unattended: a crash leaves the line paused until a person runs one of these, and
no alert is sent. A live number whose deployment is paused for any other reason is also never
`in_sync`. Sync never touches a released number's deployment.

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

1. Review, then apply the migration with the gate scripts (see "Migration gate"); the latest applied migration must be `20261202090000`.
2. Nothing to schedule: the sweep rides the existing Worker cron.
3. On a **test** customer (never Smile Dental) with an admin-confirmed, unused Sarvam number and a
   hand-registered agent: press Activate; expect the job to stop at `waiting_for_tool_authentication`
   until the credentials are confirmed (see "tool-authentication checkpoint"), then reach `complete`, number `active`.
4. Check in Sarvam: one deployment, paused→active, routes only that number; ClickAI row verified ids set.
5. Press Activate again / reload during the run: no second deployment or job.
6. Only then one supervised inbound test call.

## Migration gate (20261203090000): built, NOT executed

`node scripts/build-gate-outbound-package.mjs 20261203090000` regenerates these (rebuild if the
migration or rollback file changes; the embedded SHA-256 records the gated text):

| File                                             | Purpose                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/gate-outbound-execute-20261203090000.sql`  | one-transaction apply: guards (system identifier, database, latest migration `20261202090000`, objects absent, outbound-safety state), the migration byte for byte, history row, in-transaction check including a fingerprint proving existing data (`provisioning_runs` and the other tables) is unchanged |
| `docs/gate-outbound-verify-20261203090000.sql`   | read-only post-apply verification (`all_pass`)                                                                                                                                                                                                                                                              |
| `docs/gate-outbound-rollback-20261203090000.sql` | guarded undo (latest migration only); refuses while `provisioning_run_events` has rows unless `SET LOCAL rollback.discard_job_data = 'yes';` is added at the top                                                                                                                                            |

Run from the main checkout, only after explicit approval:
`npx supabase db query --remote=eorazvlmqwunmhwviocn --yes -f docs/gate-outbound-execute-20261203090000.sql`, then the verify script.
Rehearsed (wrong-identity refusal, execute, refuse twice, verify, rollback) on a disposable cluster by
`supabase/migrations/voice_provisioning_job_gate.pg.test.ts`.

## Operator bridge: Sarvam agent authoring (2026-11-26 investigation)

**Findings (official docs only; full evidence and the exact request to Sarvam: `sarvam-unattended-agent-authoring-request.md`).** Agent create/clone/configure/commit exists only in the Voice
Agents MCP server ([mcp](https://docs.sarvam.ai/voice-agents/mcp),
[genie](https://docs.sarvam.ai/voice-agents/build/genie),
[api intro](https://docs.sarvam.ai/voice-agents/api/introduction)): tools `configure_agent`
(create/update/clone), `agents` (commit), `create_http_tool`, `configure_deployment`, etc. Its
standard discovery metadata (`/.well-known/oauth-authorization-server` on `mcp.sarvam.ai/voice-agents`)
lists only `authorization_code` (+ `refresh_token`) with PKCE, public clients, no `client_credentials`;
the docs state the token lasts 24 h, no refresh token, one workspace per login. The REST API key
(`X-API-Key`) reaches deployments, campaigns and analytics, not agents. So: **no supported
service-to-service route; a backend cannot create agents unattended.** Storing a personal 24 h token as a
server secret, scraping the dashboard or guessing endpoints are all out of bounds.

**What is implemented instead: a secure operator bridge** (`operator-bridge*.server.ts`,
`/api/public/operator/mcp`, admin panel on `/admin/provisioning`). ClickAI exposes its own small MCP
server. A platform admin creates a bridge token for one work order (see "Bridge token scope" below) and adds it to
their own MCP client next to the Sarvam MCP server, which they sign in to themselves. The client then:

1. `list_agent_work_orders`: customers whose job waits at the agent step (clicked Activate, onboarding
   valid, number assigned and confirmed).
2. `get_agent_work_order`: deterministic agent name, template (master) agent id, generated prompt, HTTP
   tool specs, input variables, voice, languages, capabilities, fingerprint, and the steps.
3. The customer's integration credential is generated by a **person** in the admin screen (Provisioning,
   the customer, integration credential) and pasted straight into the Sarvam console. The bridge has no
   tool that issues or returns it: anything it returns enters the operator's AI model context.
4. Builds the agent with Sarvam's own tools (reuse by name, else clone template, configure, commit).
5. `submit_agent_result {agentId, version, fingerprint}`: ClickAI refuses a stale fingerprint, a master
   template, a malformed id or an agent registered to another customer (existing unique index), registers
   it, marks voice settings applied to that exact version, and **resumes the job immediately** (scheduled
   sweep is the backstop). The job then does everything documented REST allows: create/adopt deployment
   with the already-assigned number, pause, verify, resume, read back, activate.

Properties: no Sarvam token ever reaches ClickAI;
every call is idempotent (name lookup, same id+version no-op, one deployment per number); the event
trail records each bridge action (token prefix only); expired/revoked tokens get a clear 401 and the
operator mints a new one; Sarvam's own 24 h sign-in is the operator's daily routine. Migration
`20261203090000` now also creates `operator_bridge_tokens` (service-role only, ≤ 24 h CHECK); the gate
scripts were rebuilt. Nothing here is verified against live Sarvam: the operator's client does the
Sarvam-side work and the exact `configure_agent` field mapping comes from `sarvam://schemas/agent-config`.

**Operator runbook.** 1) `/admin/provisioning` → "Create bridge token" **on that customer's work order**
→ check the customer, job and role shown → copy the command into your MCP client. 2) Sign in to `sarvam-voice-agents` (`/mcp` → Authenticate; repeat daily). 3) Ask: "Process the
ClickAI agent work order." 4) Review the agents it builds (Sarvam prompts approval for every
write). 5) The token is used up by the submission; revoke it if you abandon the job.

## Final workflow: Claude-assisted agent step (2026-11-27)

ClickAI cannot call Claude Code's MCP session, and Sarvam offers no service credential, so the agent
authoring step is operator-assisted through the existing bridge; the rest is automatic.

1. Customer finishes onboarding. Admin assigns a number (Sarvam number, confirmed in Sarvam).
2. Customer clicks **Activate Number**. ClickAI validates onboarding, category, capabilities, voice and
   language, number ownership, and eligibility (existing phone gate), then creates the one idempotent job
   (one active job per customer and per number).
3. The job stops at **`WAITING_FOR_AGENT_CREATION`** (`failure_code AWAITING_AGENT_CREATION`; customer sees
   "our team is setting up your voice agent"). It appears under **Provisioning → Agent builder**.
4. Operator, in Claude Code with both MCP servers connected (`sarvam-voice-agents` signed in, and
   `clickai-operator` with that work order's bridge token): "Process the ClickAI agent work order."
5. Claude: `list_agent_work_orders` → `get_agent_work_order` (customer, category, ids, masked number,
   template + Booking/Enquiry profile, voice/languages, capabilities, summary counts, checklist, ready
   prompt/tools/variables, fingerprint, steps) → checks Sarvam sign-in → reads the playbook/schema →
   reuses the agent named exactly `clickai-…` or clones the master template → configures → validates →
   commits → `submit_agent_result {agentId, version, fingerprint}`.
6. ClickAI validates (format, job ownership, fingerprint still current, not a master template, not another
   customer's agent), stores agent id/version, marks voice settings applied, and **resumes the same job**:
   create/adopt deployment → attach the assigned number → read back and verify agent/version/number/
   webhook → activate only if every check passes. Customer dashboard shows Active.

**No Sarvam sign-in:** Claude calls `report_blocker(sarvam_auth_required)` and stops. The job shows
`WAITING_FOR_OPERATOR` ("Sarvam sign-in needed") on the admin page; nothing retries or loops, nothing is
created. After signing in, the same work order continues (same job, no duplicates).

**Lost result:** the agent exists but `submit_agent_result` never arrived → the next run finds the agent by
its deterministic name and submits again; resubmitting the same id and version is a no-op.

**Template:** the repo has ONE universal master agent (`SARVAM_MASTER_AGENT_APP_ID`); the "Booking" vs
"Enquiry" distinction is the tool set generated from the customer's capabilities (`template.profile`),
not two Sarvam templates. Add a second master only if Sarvam tools ever need to differ per app.

**Verification limit:** Sarvam has no agent read API, so ClickAI cannot confirm the agent id/version exists
before the deployment call; it validates everything it can (above) and Sarvam must accept the deployment
for that id/version, after which ClickAI reads the deployment back and compares agent, version, number and
webhook before activating. A wrong id/version therefore stops at deployment verification, never at
activation.

## Cloning the committed master and the tool-authentication checkpoint

- **Master reference:** `ClickAI-Mas-002f42d7-604f`, **committed version 2** (defaults in
  `sarvam-agent-tools-spec.ts`; `SARVAM_MASTER_AGENT_APP_ID` / `SARVAM_MASTER_AGENT_VERSION` override).
  The work order's `clone` block carries `clone_from` and `clone_version`; never a draft.
- **Tools are not cloned.** The work order lists all six tools (`clickai_business_context` on start,
  `get_business_info`, `check_availability`, `book_appointment`, `request_callback` during the call,
  `record_call_outcome` on end) with the exact v2 connector config: typed `interaction_id` /
  `user_identifier` system-variable bindings, timeouts, failure messages, reply templates, saved
  variables. No `auth` is included (the MCP cannot set it) and nothing customer-specific is in them.
- **Checkpoint (job step `authorizing_tools`):**
  1. Operator clones, issues the credential, recreates the six tools, then calls `report_tools_created`.
     The job parks as `waiting_for_tool_authentication` (`TOOL_AUTH_PENDING`) showing the agent id.
  2. A human selects the credential on each tool in the Sarvam console (before commit; committed
     versions are frozen), commits, and reads the committed version back.
  3. `submit_agent_result` with `toolAuth` evidence for all six tools registers the version, records
     `tool_auth_confirmed` and resumes the **same job**, which deploys, routes and activates.
- **Never active while pending:** the pipeline refuses to deploy/activate a not-yet-live number until
  the confirmation for that agent **and version** exists. This holds however the agent was
  registered: an agent registered by hand in the admin screen is gated exactly like an operator-built
  one (the operator confirms it with `report_tools_created` then `submit_agent_result`). Only a number
  that is already live is exempt: it is only re-verified.
- **Reports belong to one job:** the "tools created" report is scoped to the provisioning job, so an
  earlier job's report never blocks reporting a replacement agent for a new job.
- **No churn:** a job is resumed only after a person's change (see
  [Continuing a waiting job](#continuing-a-waiting-job)). A superseded (reclaimed) attempt cannot
  overwrite the newer attempt's record.
- **Reliability:** reports and submits are idempotent; a second different agent for the same customer
  is refused until an admin releases the first (see Recovery); partial tool creation (not six) is refused and can be completed and re-reported.

## Recovery

Both actions are on the customer's admin provisioning page, need `agents.write` and a reason, are
written to `audit_logs` before they take effect, and change ClickAI records only: nothing is read from
or written to Sarvam or Vobiz, and no number or deployment is touched. No migration is needed.

### A wrong agent ID was reported or submitted

1. If the wrong agent is **registered** (it was submitted), first register the correct one. A
   registered agent is never released.
2. **Release a wrong agent ID** (also "Wrong agent ID?" on the work order in the operator bridge).
   Its reports and confirmations stop counting for this customer, it can be reported by whoever it
   belongs to, and all of this customer's bridge tokens end. A job waiting on that report goes back
   to waiting for an agent; it is the same job.
3. Create a new bridge token and report the correct ID. Requests made with an old token are refused.

A released ID is not banned: with a new token it can be reported again (if the release was the
mistake). Refused while the job is running; try again.

### Outbound agent: new version, withdrawal, re-enabling

| Situation                                                    | What is needed before "Confirm the outbound agent for outbound calls"               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| The version confirmed now                                    | nothing new                                                                         |
| A version that was confirmed earlier (withdrawn or replaced) | a live outbound credential                                                          |
| A new or never-confirmed version                             | its tool credentials: **Confirm outbound tool credentials**, or the operator bridge |

- Withdrawing or replacing a confirmed version records it first. If that record cannot be written, the
  withdrawal still happens and the admin is told.
- Versions withdrawn before this change count only if the audit log holds a "ready" entry made after
  that agent version was registered as the outbound agent.
- **Confirm outbound tool credentials** works without a provisioning job (older customers whose
  inbound setup is incomplete). The admin reads the committed version in Sarvam and enters the
  `agent_ref` seen on its tools; the registered ID and version must match and the outbound credential
  must be live. ClickAI cannot check the tools itself. It never enables calling.
- A job waiting on the outbound agent is continued; no other job is run.
- Rotating the credential does not cancel a recorded confirmation: update the Sarvam secret at once.

## Bridge token scope, tool binding and sweep fairness

**Bridge token scope** (migration `20261204090000`, **apply before deploying this code**; rollback in
`docs/production-rollback-20261204090000-operator-bridge-token-scope.sql`):

- One customer, one provisioning job, the inbound agent. Any other work order id answers "not found".
- 1 hour by default, 4 at most. A new token for the job revokes the previous one.
- Re-checked on every request: the issuer is still an active admin with `agents.write`, and the job is
  still open (not succeeded, failed, deleted, or past the inbound agent), and the customer is not
  suspended, cancelled or archived. Otherwise revoked for good (at the token's next use).
- A submission of an older version than the one registered is refused. An attempt that a newer one has
  taken over stops at its next step.
- The one registration it can make uses it up. Before that, reads and the (idempotent) report can be
  repeated by whoever holds it: it is a bearer token.
- The bridge builds inbound agents only; no outbound token can be issued.

**Tool binding.** Every tool in the work order sends a fixed body field `agent_ref`
(`inbound:<agent config id>`). Submission requires it, read back, on all six tools. At call time the
agent API refuses a request whose `agent_ref` is not the one of the credential presented
(`credential_mismatch`, nothing served). This catches another customer's or role's credential selected
on a tool, **when the call happens**. ClickAI still cannot see which credential Sarvam holds: it cannot
detect the mistake before the first call, and the check depends on the tool really sending the field
(operator read-back). Agents built earlier send no `agent_ref` and behave as before.

**Recovery sweep.** All candidates are read page by page (no fixed window). Each minute the start point
rotates and due retries, crashed runs and changed waiting jobs take turns; only claimed runs use up the
tick's three slots, with a bound on failures per tick.
