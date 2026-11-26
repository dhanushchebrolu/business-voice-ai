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
  waiting for an agent that has since been registered. Bounded to 3 jobs / 15 s per tick. Kill switch:
  `JOBS_SCHEDULER_ENABLED=false` (stops all sweeps).
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
- **No churn:** each attempt records what it saw (agent, voice settings and confirmation timestamps)
  before working; the sweep resumes a waiting job only when that has changed since, so a change made
  while an attempt was running is not lost and an unchanged job is left alone. A superseded (reclaimed)
  attempt cannot overwrite the newer attempt's record.
- **Reliability:** reports and submits are idempotent; a second different agent for the same customer
  is refused; partial tool creation (not six) is refused and can be completed and re-reported.

## Bridge token scope, tool binding and sweep fairness

**Bridge token scope** (migration `20261204090000`, **apply before deploying this code**; rollback in
`docs/production-rollback-20261204090000-operator-bridge-token-scope.sql`):

- One customer, one provisioning job, the inbound agent. Any other work order id answers "not found".
- 1 hour by default, 4 at most. A new token for the job revokes the previous one.
- Re-checked on every request: the issuer is still an active admin with `agents.write`, and the job is
  still open (not succeeded, failed, deleted, or past the inbound agent). Otherwise revoked for good.
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
