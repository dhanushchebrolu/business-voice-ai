# Pre-deployment readiness audit

Branch `feature/automated-voice-provisioning` at `4b4e3548342a3805bb706c1df599b3af7744f4c8`, audited
2026-11-27. Audit and documentation only: nothing was deployed, migrated, called, bought or changed in
production, Sarvam or Vobiz. **No production system was queried.** Statements about production state
come from repository documents and the team's session notes, and are marked "per notes".

> **Update:** on `feature/provisioning-auto-resume`, L4 is fixed and L3 can no longer hide a waiting
> state (see "Continuing a waiting job" in `voice-ai-provisioning-workflow.md`).
>
> **Update, 2026-11-27:** H1 and H2 are fixed on this branch after the audit (see "Recovery" in
> `voice-ai-provisioning-workflow.md`). Their entries below describe `4b4e354`. The fixes need no new
> migration and have not been tried against real Sarvam. Sections 6 to 16 were not re-audited.
> **Release preparation, 2026-11-27:** there are now three unapplied migrations (`20261204090000`,
> `20261205090000` before deploying; `20261206090000` after), each with gate scripts (H4 addressed).
> For releasing, `production-deployment-runbook.md` and `production-migration-checklist.md` replace
> sections 4 and 12 to 15 below.

## 1. Executive verdict

**READY WITH CONDITIONS** to deploy the code. **NOT READY** to onboard customers with it.

No defect was found that breaks existing live inbound calls, mixes two customers' agents, or lets an
inbound agent be dialled outbound. The problems are in what happens around the happy path: two ways a
provisioning job or an outbound setup can get stuck (H1, H2), and a release process with an ordering trap
(H3, H4).

Conditions for deploying:

1. Release with an explicit Worker deploy. Do not merge to `main` before migration `20261204090000` is
   applied (H3).
2. Apply `20261204090000` first, with a history row and a lock timeout (H4).
3. The read-only pre-checks in section 12 show that no provisioning run will touch a live number (M3).
4. Do not onboard a real customer until both supervised tests pass (H5).

## 2. What was audited

| Item                                                        | Value                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Base                                                        | `main` `3b8513e` (merge base; branch is 16 commits ahead, 0 behind) |
| Size against `main`                                         | 79 files, +12174 / -468                                             |
| Live Worker (per notes)                                     | version `009eea99`, build of `b60b77f` (8th of the 16 commits)      |
| Not yet deployed                                            | `b60b77f..4b4e354`: 8 commits, 54 files, +6218 / -364               |
| Deployed commits `15000c2`, `5052a0b`, `fa498dc`, `92a14f0` | all contained in this branch                                        |

Commits, oldest first. The first eight are live per notes.

| Commit    | Change                                                           | Live |
| --------- | ---------------------------------------------------------------- | ---- |
| `f564e96` | Provisioning job: per-step state, retries, dashboards            | yes  |
| `7e37636` | Docs formatting                                                  | yes  |
| `ab62ae1` | Test flake fix (ignores `updated_at` in one comparison)          | yes  |
| `7fd76a2` | Scheduled sweep, resume on registration, gate scripts            | yes  |
| `0d430a8` | Operator bridge                                                  | yes  |
| `02089ad` | Provider authorization failures                                  | yes  |
| `c95196f` | Operator view, `report_blocker`                                  | yes  |
| `b60b77f` | Gate fix, master agent package                                   | yes  |
| `3372c4b` | Master agent setup guide                                         | no   |
| `1f57c34` | Clone master v2, six tools, tool-credential checkpoint           | no   |
| `d669dc2` | Checkpoint UX                                                    | no   |
| `cf0e492` | Mobile layout                                                    | no   |
| `d75dde8` | Mandatory checkpoint, bridge and sweep hardening                 | no   |
| `ad32022` | Token scope, `agent_ref`, fair sweep, migration `20261204090000` | no   |
| `6bebb60` | Closed customers, older versions, superseded attempts            | no   |
| `4b4e354` | Dual-agent provisioning                                          | no   |

## 3. Findings

No critical finding.

### High

**H1 (fixed after this audit). One wrong agent ID in `report_tools_created` dead-ends the job.**
Evidence: `src/lib/operator-bridge.server.ts:832` refuses any second, different agent for the same job;
`submit_agent_result` accepts only the reported one; there is no admin action to discard a report.
Probe: report `Typo-agent-1`, then the correct ID: refused. Register the correct agent by hand: the job
waits for tool credentials, and reporting it is still refused. ClickAI cannot check that a reported ID
exists. The same applies when an operator deletes and rebuilds an agent. The mistaken ID also stays
reserved against every other customer (`:793`, not limited to open jobs).
Consequence: onboarding stops. For a number that is not live, suspending it, running provisioning,
unsuspending and running again starts a new job that accepts the right ID (probed). For the outbound agent of a live customer that means
taking the live number down, or editing the database.
Smallest fix: an audited admin action "discard reported agent" for a job with no registered version of
that role, and count another customer's report only while that job is open or the agent is registered.

**H2 (fixed after this audit). The new outbound confirmation gate can lock an existing customer out of outbound calling.**
Evidence: `src/lib/sarvam-outbound-mode.server.ts:242`. Confirming a version needs a
`tool_auth_confirmed` event, which only `submit_agent_result` writes. That needs a job parked in an
outbound state, which the pipeline reaches only after every inbound step passes for that customer.
Probes (in memory): a live customer without a per-agent inbound credential, saved voice settings or a
business category never gets an outbound work order, and confirming a new outbound version is refused.
Withdrawing outbound ("Withdraw outbound") and confirming the same previously confirmed version again is
also refused. Where the prerequisites do pass, the existing outbound agent must still be edited to carry
exactly the work order's tools and `agent_ref`.
Consequence: registering a new outbound version, or a precautionary withdraw, stops a legacy customer's outbound
calls and campaigns until a full bridge round trip. An already confirmed registration keeps dialling until one
of those happens.
Whether any current customer is in this position is unknown (pre-check query 4).
Smallest fix: let an admin with `agents.write` record an audited tool-credential confirmation for a
registered outbound agent from the admin screen, or allow re-confirming a version confirmed before.

**H3. `main` auto-deploys production, and `main` is older than the live build.**
Evidence: `docs/production-security-remediation-plan.md` (2026-11-18, not re-verified): Cloudflare
Workers Builds on `klyro` deploys every push to `main`; Lovable pushes to `main`. Per notes the live
build is `b60b77f`, which is not on `main`.
Consequence: today, any push to `main` would replace the live build with one without the provisioning job
or bridge. Merging this branch would deploy it immediately, before migration `20261204090000`, so bridge
token issue and use would fail.
Smallest fix: check the trigger in the dashboard, hold pushes to `main`, apply the migration, then deploy.

**H4. Migration `20261204090000` has no gate package and a strict order.**
Evidence: `scripts/build-gate-outbound-package.mjs` has an entry for `20261203090000` only. The
migration sets no `lock_timeout` and writes no history row; its rollback removes none.
Applying it while the old build is live makes old token creation fail (verified on PostgreSQL, section 5).
Rolling the Worker back while it stays applied does the same. Old code ignores the scope columns, so a
scoped token still live at rollback would work for every customer. The `20261203090000` rollback gate
refuses unless history ends at `20261203090000`.
Smallest fix: add the gate entry (execute, verify, rollback) and follow sections 12 and 14.

**H5. Nothing has run against real Sarvam or Vobiz.**
All provider behaviour in tests is mocked. Unverified: that an operator can build both agents from the
work orders, that the tool body bindings for the interaction ID and caller work in a committed agent
(per notes), that the console credential selection survives commit, and that an outbound agent obeys the
300-second limit and no-transfer setting.
Consequence: the first real customer would be the first test.
Smallest fix: the supervised tests in section 13 on a test tenant.

### Medium

**M1. Hand registration leads to a checkpoint only the bridge can clear, and the page does not say so.**
`src/routes/admin.provisioning.$orgId.tsx:414` ("Manual Sarvam setup") says to copy the master, store
the credential and register. It mentions neither recreating the six tools, `agent_ref`, nor the
confirmation the job then waits for. Clearing it requires an MCP client and a `clonedFrom` equal to
master version 2, so an agent built any other way cannot be reported truthfully.

**M2. The operator panel shows only the 50 oldest waiting jobs.**
`operator-bridge.server.ts:339`. Tokens are issued only from that list. Jobs waiting on the outbound
agent never expire, so newer customers can drop off it. Probe: 60 waiting jobs, newest not listed.

**M3. Running provisioning can change a live customer's Sarvam deployment** (same behaviour on `main`).
On a live number whose registered version differs from the deployment, the run patches the deployment,
pausing and resuming it (`provisioning-pipeline.server.ts:699`,
`sarvam-inbound-deployment.server.ts:187`). A live number with no recorded deployment ID but a confirmed
number gets one created or adopted (`:583`). A verification mismatch withdraws verification, which stops
business data to the live agent (`:780`). Triggers include "Run provisioning", registering either agent
(`provisioning-admin.functions.ts:526`) and a captured setup or phone-service payment. The comment "a
live number is only re-verified" is not accurate. This matters for Smile Dental.

**M4. Agent configuration and credential choice cannot be verified.**
Tools, settings, version and credentials are what the operator reports. `agent_ref` is checked only when
a request sends it (`sarvam-agent-api.server.ts:1193`). Sarvam secrets are workspace-wide (per notes).
Exploit: an operator selects customer B's secret on customer A's legacy tools (no `agent_ref`); A's
agent then reads B's business data and books into B's calendar. New work-order tools are refused with
`credential_mismatch`, provided they were really built with `agent_ref`.

**M5. A supervised outbound call cannot happen through ClickAI before confirmation.**
ClickAI dials only confirmed versions, and the admin test call is limited to demo organizations
(`sarvam-admin.functions.ts:1155`). A call placed from the Sarvam console carries no ClickAI call ID, so
outbound booking is refused and cannot be tested that way. The practical order is: console voice test,
confirm, then one ClickAI call to an allowlisted number, with campaigns off.

**M6. Customers are easy to confuse in the operator panel.**
Work-order rows and the token dialog (`OperatorBridgePanel.tsx:289`) show the customer name and job ID,
not the customer ID or number. "Smile Dental" and "Smile Dental 1" differ by one character. Protected
customers have no technical guard: if one has a waiting job, a token can be issued for it.

### Low

| ID  | Finding                                                                                                                                                                                                                                                                                                                              | Evidence                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| L1  | Resuming a provider-side Sarvam campaign checks that the customer's agent is outbound-ready, not that the campaign runs that agent. `sarvamCampaignUsesAgent` is never called (also on `main`). Nothing in current code writes `provider_campaign_id`, so only older rows are affected. This corrects the earlier dual-agent report. | `sarvam-outbound-mode.server.ts:105`, `:325`   |
| L2  | A failed write of the "tools created" or "credentials confirmed" event is only logged; the operator is told it succeeded. The job stays waiting; resubmitting with a new token repairs it.                                                                                                                                           | `operator-bridge.server.ts:677`                |
| L3  | A run writes status and job state in two updates; a crash between them leaves a stale state until the next run.                                                                                                                                                                                                                      | `provisioning-runs.server.ts:430`              |
| L4  | The sweep resumes only customer-activation jobs waiting on inbound states. Outbound states, payment-created jobs and a newly issued credential need "Run provisioning" or a submission.                                                                                                                                              | `provisioning-runs.server.ts:517`              |
| L5  | Signed-in organization members keep `DELETE` on their own `agent_configs` row (older grant); deleting it drops the agent mapping and credential (own organization only).                                                                                                                                                             | section 5 privilege output                     |
| L6  | The bridge endpoint has no rate or body limit. The suggested `claude mcp add` command stores the token in the operator's client configuration (1 hour, single registration).                                                                                                                                                         | `routes/api/public/operator/mcp.ts`            |
| L7  | Older shared-secret context route: anyone holding `SARVAM_CONTEXT_SECRET` can read any admitted customer's context by phone number; the secret travels in the URL. Unchanged by this branch.                                                                                                                                         | `routes/api/public/sarvam/client-context.ts`   |
| L8  | A second AI outbound path (LiveKit SIP, Vobiz numbers) does not use the two-agent model. It is off unless `VOICE_AGENT_OUTBOUND_ENABLED=true`.                                                                                                                                                                                       | `voice-agent/outbound.server.ts:214`           |
| L9  | "Rotate credential" stops the live agent's credential at once (the dialog says so). Operators must not rotate when one already exists in Sarvam.                                                                                                                                                                                     | `SarvamIntegrationPanel.tsx`                   |
| L10 | Retry counters are per job, not per agent role. One job per customer.                                                                                                                                                                                                                                                                | `docs/dual-agent-provisioning-architecture.md` |
| L11 | Customer pages now show outbound as active only after confirmation; a non-Sarvam outbound number would show as not active.                                                                                                                                                                                                           | `AccountStatusPanel.tsx`, `app.numbers.tsx`    |

## 4. Migration inventory and order

Against `main` the branch adds two migrations. Latest applied in production, per notes:
`20261203090000`.

| Order | Migration                                        | State                                  | Impact on existing data                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `20261203090000_voice_provisioning_job.sql`      | **applied** (per notes, gate verified) | Adds 11 columns to `provisioning_runs` (nullable or defaulted), one unique index (one active job per number), one retry index, tables `provisioning_run_events` and `operator_bridge_tokens`. No rewrite of existing values. Unchanged since it was applied.       |
| 2     | `20261204090000_operator_bridge_token_scope.sql` | **not applied**                        | Adds `organization_id`, `run_id`, `agent_role` to `operator_bridge_tokens`; **revokes every existing unscoped token**; adds a unique index on `provisioning_runs (id, organization_id)`, a composite foreign key (cascade), two checks and a one-live-token index. |

Only migration 2 is to be executed. It touches no agent, number, customer, subscription, booking, wallet
or call row. The new `provisioning_runs` index cannot fail on data (`id` is already unique). Index builds
are not concurrent; the table is small, but set a lock timeout. It is re-runnable. Rollback
(`docs/production-rollback-20261204090000-operator-bridge-token-scope.sql`) revokes all live tokens, then
drops everything added; the only data lost is token scope. The rollback of migration 1 drops the job
columns and both tables, refuses while events exist unless told to discard them, and must run after
rolling back migration 2.

## 5. Schema consistency (real PostgreSQL)

All 87 migrations were applied in order to a disposable PostgreSQL cluster with a stand-in for
Supabase's auth schema and roles (temporary script, not committed).

| Check                                                                                                                       | Result                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Every table and column in the generated types exists                                                                        | 78 tables, 0 problems                                      |
| Columns of `provisioning_runs`, `provisioning_run_events`, `operator_bridge_tokens`, `agent_configs` missing from the types | none                                                       |
| `anon` / `authenticated` privileges on job, event, token and credential tables                                              | none                                                       |
| `authenticated` update of agent mapping columns                                                                             | refused                                                    |
| `authenticated` on `agent_configs`                                                                                          | table-level `select`, `delete` (L5); row-level security on |
| Old build's token insert with only migration 1                                                                              | works                                                      |
| Old build's token insert with migration 2                                                                                   | fails on `operator_bridge_tokens_scoped`                   |
| Rollback 2, rollback 1, re-apply both                                                                                       | succeeds                                                   |
| The section 12.1 pre-check queries                                                                                          | run in a read-only transaction                             |

`anon` appears with table privileges on `agent_configs` and `phone_numbers` because the stand-in grants
Supabase-like defaults; row-level security has no `anon` policy there. The stand-in is not production:
real grants and history were not read. Rollbacks ran on empty job tables; the "refuse while events exist"
guard is covered by the existing PostgreSQL tests.

## 6. Dual-agent separation

| Property                                     | Result                              | Enforced by                                                                                     |
| -------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Distinct agent ID and version                | yes                                 | separate columns; database guard in `20261120090000`                                            |
| One agent in both roles or for two customers | refused                             | database trigger and unique indexes; registration and bridge checks                             |
| Distinct credentials                         | yes                                 | `sarvam_agent_integrations.role`; role decides allowed agent-API tools                          |
| Distinct configuration                       | yes                                 | `buildUniversalAgentConfig` / `buildOutboundAgentConfig`; outbound is never cloned from inbound |
| Distinct provisioning state and confirmation | yes                                 | role-specific job states; events carry the role                                                 |
| Deployment mapping                           | inbound only                        | instant outbound needs none                                                                     |
| Version                                      | per role; older submissions refused | `submitAgentResult`                                                                             |

Limits: M4 (not verifiable in Sarvam), L10 (one job, shared counters).

## 7. Call routing

| Entry point                                                                                | Agent used                                                                                         | Unconfirmed or missing outbound agent                            |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Inbound call (Sarvam deployment on the number)                                             | inbound; deployment verified against `sarvam_app_id`                                               | not applicable                                                   |
| Agent API, inbound credential                                                              | the credential's customer; needs an active, verified number                                        | refused `not_admitted`                                           |
| Agent API, outbound credential                                                             | the credential's customer; allowed tools only; booking only for the dialled number on an open call | needs a registered (not yet confirmed) outbound agent, by design |
| Single call (`createSarvamInstantOutboundCall`) and admin test call                        | `outboundAgentTarget` (`sarvam-outbound-call.server.ts:414`)                                       | refused; no inbound fallback                                     |
| Campaign dispatcher (cron route and scheduled job; needs `CAMPAIGN_DISPATCH_ENABLED=true`) | `outboundAgentTarget` (`campaign-dispatch.server.ts:285`)                                          | nothing dialled                                                  |
| Campaign launch                                                                            | `isOutboundReady` (`campaign-launch-readiness.server.ts:196`)                                      | blocked; Sarvam-paced mode blocked                               |
| Admin change of a provider-side campaign                                                   | whatever Sarvam's campaign holds                                                                   | L1                                                               |
| Generic telephony outbound                                                                 | retired, always throws                                                                             | not applicable                                                   |
| LiveKit SIP agent call                                                                     | not a Sarvam agent                                                                                 | L8                                                               |
| Admin call detail                                                                          | agent matching the call's direction (current registration, not recorded per call)                  | shows none                                                       |

Direction: ClickAI sets `call_direction` and its call ID last, so contact or template variables cannot
override them. Routes under `src/routes/api` are unchanged against `main` except the new
`operator/mcp.ts`; webhook handlers are unchanged.

Result: no path found that dials the inbound agent for an outbound call. The only live-call change since
the deployed build is the `agent_ref` check, which ignores requests without that field.

## 8. Provisioning lifecycle, failures and recovery

Entry points: customer "Activate Number" (owner, phone feature unlocked), captured `setup_fee` or
`phone_service_fee` payment, admin "Run provisioning", agent registration, bridge submission, and the
minute sweep. All go through `runProvisioning`: one active job per customer and per number, claimed with
an optimistic attempt number.

Fault injection against the real pipeline and runner with an in-memory database and mocked Sarvam
(temporary probe, not committed):

| Injected failure                                   | After failure                   | After retry                       | Deployments created |
| -------------------------------------------------- | ------------------------------- | --------------------------------- | ------------------- |
| Deployment create fails before taking effect       | pending retry, number inactive  | live                              | 1                   |
| Create fails after ClickAI recorded the deployment | pending retry, inactive         | live, reused                      | 1                   |
| Deployment read fails                              | pending retry, inactive         | live                              | 1                   |
| Pause fails                                        | pending retry, inactive         | live                              | 1                   |
| Resume fails                                       | pending retry, inactive         | live                              | 1                   |
| Reading the customer's data throws                 | pending retry                   | live                              | 1                   |
| Database write fails at verification save          | pending retry, inactive         | live                              | 1                   |
| Database write fails at activation                 | pending retry, inactive         | live                              | 1                   |
| Worker dies mid-run                                | sweep reclaims after 10 minutes | live                              | 1                   |
| Two runs at once                                   | one claims                      | live                              | 1                   |
| Retries exhausted                                  | job failed                      | new job from admin retry succeeds | 1                   |

A create whose response is lost before ClickAI records it relies on the deployment adopt logic, which this
probe did not exercise (the existing deployment tests cover it).

Existing tests also cover superseded attempts, sweep paging and rotation, closed customers, and tool
checkpoint resume. Not simulated: real Sarvam timeouts and partial states, PostgREST behaviour, and
Cloudflare CPU or time limits on a sweep over thousands of jobs (the sweep reads every candidate each
minute). ClickAI creates no Sarvam agent, so no duplicate agent can come from ClickAI; an operator could
create one (the work order says to reuse by name). No path deletes customer data.

Dead ends found: H1, H2. Manual follow-up needed: L4.

## 9. Same workflow for every plan

Verified by code search: the pipeline, runner, bridge, agent configuration and checkpoint contain no
plan, subscription or entitlement condition, and the branch adds none. Every customer's job needs both
agents to complete. Differences come only from the customer's own capability settings (which tools are
on). Eligibility to press "Activate" uses the existing phone feature lock (lifecycle, locks,
entitlements, the payment-enforcement switch; off per notes), which this branch does not change. Only
`setup_fee` and `phone_service_fee` payments start a job. There is no automated test asserting identical
steps across plan names, because nothing reads a plan. Payment enforcement and pricing are untouched.

## 10. Security

Checked and holding:

- Bridge tokens: 256-bit random, hash only, default 1 hour, maximum 4, one customer, job and role. Each
  request rechecks expiry, revocation, the issuer's `agents.write`, job state, role and customer
  lifecycle. One registration per token (conditional update). A replay gets 401. Other jobs answer
  "not found". Scope is also enforced by database constraints.
- Admin actions use `assertPlatformAdmin` with a capability; token issue and revoke are audited.
- Tokens and job tables are service-role only (section 5).
- The bridge returns no credential; diagnostics are redacted (`sanitizeDiagnostic`); logs carry no token.
- Outbound limits are enforced server-side: tool allow-list, booking bound to the dialled number.
- Customers cannot write agent mapping columns (column grants).

Residual exploit scenarios: M4 (wrong secret on tools without `agent_ref`), L7 (shared context secret),
L6 (token readable on the operator's machine for up to 1 hour: it can read that one work order and
register one agent that passes the same checks), H4 (scoped token accepted globally by old code after a
careless rollback).

The currently live build (`b60b77f`, per notes) issues tokens valid for **every** customer, 8 hours by default and 12 at most, reusable. This branch fixes that. Until deployment, create no bridge tokens in
production.

## 11. Operator workflow and legacy compatibility

### Walkthrough

| Step                         | Inbound                                      | Outbound                                | Risk                           |
| ---------------------------- | -------------------------------------------- | --------------------------------------- | ------------------------------ |
| Identify customer            | name link, checkpoint card shows ID          | same                                    | M6                             |
| Identify role                | role pill, token dialog, work order `scope`  | same                                    | clear                          |
| Create agent                 | clone master v2 under the generated name     | new agent, name ends `-out`             | cannot be verified             |
| Tools                        | recreate six, with `agent_ref`               | only the listed ones                    | M4                             |
| Credential                   | generate in "Inbound agent data integration" | generate in "Outbound agent"            | L9; two panels, clearly titled |
| Report tools                 | `report_tools_created`                       | same                                    | H1                             |
| Select credential, commit    | Sarvam console, before commit                | same                                    | cannot be verified             |
| Register and confirm version | `submit_agent_result`                        | same, then "Confirm for outbound calls" | M5                             |

An operator can complete it when nothing goes wrong. The dangerous points are a mistyped ID (H1), the
stale manual instructions (M1), and acting on the wrong customer (M6).

### Existing customers

| Case                                   | Effect of deploying                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Live inbound customer                  | Calls, webhooks, admission and deployment unchanged. Not gated. See M3 before running provisioning. |
| Legacy single-agent customer           | Outbound refused as before. A job waits on the outbound agent.                                      |
| Outbound agent confirmed               | Keeps dialling. Cannot change version or withdraw and restore without the bridge (H2).              |
| Outbound registered, unconfirmed       | Now needs the bridge confirmation before it can be confirmed.                                       |
| Non-live number with registered agent  | Not activated until tool credentials are confirmed.                                                 |
| Existing deployments and Vobiz numbers | Nothing migrated or remapped. No Vobiz or `telephony` route code changed.                           |
| Existing campaigns                     | Same dialling gates. L1 for old provider-side campaigns.                                            |

Assumptions that hold only for new or fully set up customers: one Sarvam number per customer; an own
connection row; an admin-confirmed number; saved and applied voice settings; a per-agent credential;
agents built from work orders. Smile Dental's records were not read; whether they meet these is unknown,
so run no provisioning action on it. "Smile Dental 1" is the test tenant; per its checklist (2026-11-27)
it still lacks voice settings, a number, a connection row, number confirmation and credentials.

## 12. Deployment plan (not executed)

### 12.1 Pre-deployment checks

1. CI green on the exact SHA to deploy; working tree clean; build from that SHA.
2. Cloudflare dashboard: confirm what `klyro` deploys automatically. Hold pushes to `main` and Lovable
   publishing until H3 is settled.
3. `npx wrangler deployments status --name klyro`: record the live version (expected `009eea99`).
4. Read-only database checks, inside `begin transaction read only; ... rollback;`:

```sql
-- 1. Expected 20261203090000.
select max(version) from supabase_migrations.schema_migrations;
-- 2. Live bridge tokens (the migration revokes them). Expect 0.
select count(*) from operator_bridge_tokens where revoked_at is null and expires_at > now();
-- 3. Open jobs the sweep or an admin could continue.
select organization_id, status, current_step, trigger from provisioning_runs
 where status in ('pending','running','waiting');
-- 4. H2: customers with outbound agents, and whether their inbound prerequisites exist.
select a.organization_id,
       (a.sarvam_outbound_ready_app_id = a.sarvam_outbound_app_id
        and a.sarvam_outbound_ready_version = a.sarvam_outbound_app_version) is true as confirmed,
       exists(select 1 from sarvam_agent_integrations i where i.agent_config_id = a.id
              and i.role = 'inbound' and i.status = 'active') as inbound_credential,
       exists(select 1 from agent_voice_language_settings v where v.agent_config_id = a.id
              and v.status = 'applied' and v.applied_sarvam_app_id = a.sarvam_app_id
              and v.applied_sarvam_app_version = a.sarvam_app_version) as voice_applied
  from agent_configs a where a.sarvam_outbound_app_id is not null;
-- 5. M3: live numbers without a recorded or matching deployment.
select n.organization_id, n.provider_deployment_id is null as no_deployment,
       n.verified_sarvam_app_version is distinct from a.sarvam_app_version as version_differs
  from phone_numbers n left join agent_configs a on a.id = n.agent_config_id
 where n.provider = 'sarvam' and n.status = 'active';
-- 6. L1: provider-side campaigns.
select organization_id, status from campaigns where provider_campaign_id is not null;
-- 7. Fingerprint of protected rows, to compare after deployment.
select 'agent', md5(to_jsonb(a)::text) from agent_configs a
 where organization_id::text like '5669e43f%' or organization_id = 'ccb6543c-da78-47cf-b32f-7851ddc575ea'
union all
select 'number', md5(to_jsonb(n)::text) from phone_numbers n
 where organization_id::text like '5669e43f%' or organization_id = 'ccb6543c-da78-47cf-b32f-7851ddc575ea';
```

### 12.2 Backup and rollback preparation

Confirm a recent Supabase backup or point-in-time recovery window. Export `operator_bridge_tokens`,
`provisioning_runs` and `provisioning_run_events` (expected empty or small). Record the rollback Worker
version. Have the three rollback statements ready (section 14).

### 12.3 Migration

Only `20261204090000`. Preferred: add it to `scripts/build-gate-outbound-package.mjs` (previous
`20261203090000`) and run the generated execute and verify scripts, as for earlier migrations. Do not use
an unreviewed `supabase db push`. Whatever the method: one transaction, `SET LOCAL lock_timeout = '5s'`,
insert the history row. Verify: three new columns, three constraints, two new indexes, no live unscoped
token, `max(version) = 20261204090000`, protected-row fingerprints unchanged. Between this step and the
Worker deploy, bridge token creation fails; do both in one sitting.

### 12.4 Worker deployment

1. Build the approved SHA with the production `VITE_*` values (`bun run build`).
2. `npx wrangler versions upload`, compare the new version's bindings with the live one (30 per notes),
   confirm the name is `klyro`.
3. `npx wrangler versions deploy <new-id>@100% --name klyro`.
4. Do not run `wrangler triggers deploy` (per notes).

### 12.5 Configuration

No new required variable. Defaults in code: master `ClickAI-Mas-002f42d7-604f`, version 2;
`SARVAM_MASTER_AGENT_APP_ID` and `SARVAM_MASTER_AGENT_VERSION` only override them.
`SARVAM_OUTBOUND_MASTER_AGENT_APP_ID` optional. The bridge needs `TELEPHONY_WEBHOOK_BASE_URL`.
Leave `CAMPAIGN_DISPATCH_ENABLED`, `KLYRO_DISPATCH_MODE`, `VOICE_AGENT_OUTBOUND_ENABLED`,
`OUTBOUND_PILOT_RESTRICTION` and payment enforcement as they are; record their current values.

### 12.6 Verification

- `deployments status` shows the new version at 100%.
- `POST /api/public/operator/mcp` without a token returns 401.
- The minute sweep logs succeed; no `provisioning_sweep:run_failed`.
- Admin provisioning list and one non-protected customer page load; pre-check queries 3, 5 and 7 are
  unchanged.
- Place no test call to a live customer; watch their next real calls in the logs.

## 13. Supervised tests (each needs the owner's approval)

### Inbound, tenant "Smile Dental 1"

1. Complete the checklist: voice settings, a **spare** number (never one ending 0061 or 0870), connection
   row, number confirmation.
2. "Activate", generate the inbound credential, create a bridge token for this job only; check the
   customer ID.
3. Build the agent from the work order; read the agent ID back before reporting it (H1).
4. Select the credential, commit, submit. Expect: deployment created paused, verified, resumed, number
   active.
5. One call from your phone: greeting, business facts, availability, a booking, call outcome. Confirm the
   booking is in this tenant only, the webhook recorded the call as inbound, and logs show no
   `credential_mismatch` or `not_admitted`.

### Vobiz routing

Before activation, in the consoles (read only): the spare number exists on the Sarvam connection and is in
no other deployment. After: the deployment lists exactly that number and the new agent; the ClickAI
verification report is all green; Smile Dental's deployment, agent, version and number are unchanged.
Place no test on them.

### Outbound, same tenant

1. Generate the outbound credential, build the outbound agent from its work order, report, select the
   credential, commit, submit. Check in Sarvam: 300 seconds maximum, no transfer, only the listed tools.
2. Voice test in the Sarvam console (booking will be refused there; expected).
3. Set `SARVAM_OUTBOUND_TEST_ALLOWLIST` to your own number only (check that pilot restriction is not
   `off`), campaigns disabled; add yourself as a contact; enable outbound on the test number; ensure
   wallet balance; stay within 09:00–21:00 IST.
4. "Confirm the outbound agent for outbound calls", then one single call. Expect the outbound agent,
   booking only for your number, opt-out honoured, call detail showing the outbound agent, correct charge.
5. Say "transfer me" and "call me back": both must be refused. Let one call run past 5 minutes.
6. If anything fails, "Withdraw outbound" (on a new-flow tenant it can be confirmed again).

## 14. Rollback

Triggers: live inbound calls lose business data or show new `not_admitted`, `credential_mismatch` or 5xx
on the agent API; any outbound call using an unexpected agent; any change in protected-row fingerprints;
sweep errors that repeat for 10 minutes; admin or customer pages failing.

Immediate containment, without a rollback: revoke all tokens in the admin panel; set the outbound
emergency stop (`docs/outbound-emergency-stop-runbook.md`) for outbound problems.

Procedure, in this order:

1. `update operator_bridge_tokens set revoked_at = now() where revoked_at is null;`
2. `npx wrangler versions deploy 009eea99-0e4d-4ff9-bb36-fe22dda8b6e0@100% --name klyro --yes` (confirm
   the full ID from step 12.1.3 first).
3. Only if the schema must go back: run the `20261204090000` rollback, delete its history row, verify.
   If left applied, old code cannot create tokens, which is the safe state.
4. Only if migration 1 must also go: `docs/gate-outbound-rollback-20261203090000.sql` (needs history
   ending at `20261203090000`, and the discard setting if events exist). Not normally needed.

After a rollback the older build has no tool-credential checkpoint and no outbound confirmation gate;
confirm no outbound version during that time. Deployments created in Sarvam and agents registered during
the window remain; review them by hand. Rollback was not rehearsed against production.

## 15. Monitoring after deployment (first 48 hours)

- Logs: `provisioning_sweep:run_failed`, `provisioning_runs:event_write_failed`,
  `provisioning_runs:fail_write_failed`, `operator_bridge:*`, `sarvam_agent:credential_mismatch`,
  `campaign_dispatch:agent_not_outbound_ready`, agent-API 401/403 rates.
- Daily: open jobs by state and age; jobs waiting on tool credentials over 24 hours; token issues in the
  admin audit log; active numbers whose verified deployment differs from the mapped one; protected-row
  fingerprints.

## 16. Validation

### Run during this audit (on `4b4e354`, Windows)

| Check                                                                       | Result                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| TypeScript `tsc --noEmit` (Node 24.20.0)                                    | exit 0                                                                            |
| ESLint, whole repository                                                    | 0 errors, 23 warnings                                                             |
| Prettier check on the 72 non-SQL files changed against `main`               | clean                                                                             |
| `node --test` (the CI command; voice-agent dependencies linked temporarily) | 6082 tests: 5590 passed, 0 failed, 492 skipped (PostgreSQL tests, run separately) |
| PostgreSQL tests in Docker, all `*.pg.test.ts` (Node 24.22.0)               | 487 tests: 478 passed, 0 failed, 9 skipped (no PostgREST binary)                  |
| Production build with placeholder public variables                          | succeeded                                                                         |
| Fault-injection and edge-case probes (section 8, H1, H2, M2)                | as reported; temporary, not committed                                             |
| Schema comparison and rollback chain (section 5)                            | passed                                                                            |

No test was changed or weakened. No failure or flake occurred in this run.

### Previously run, not repeated

- Mutation checks on `4b4e354`: 39 of 39 reintroduced weaknesses caught.
- Browser check of the customer account panel with mock data.
- One earlier flake in `public_conversation_stats.pg.test.ts` (a 3-second timing window in a file this
  branch does not change); it passed on reruns.

### CI evidence

GitHub Actions `Test` run `45887704921` on `4b4e354`: success (recorded when it was pushed; Node 22,
no PostgreSQL skips allowed except PostgREST checks).

### Not run

Anything against production, Sarvam, Vobiz or Cloudflare; PostgREST integration tests; load tests;
browser checks of the admin bridge panel and numbers page; a rehearsal of deployment or rollback.

## 17. Known limitations

- Sarvam has no unattended agent authoring or configuration read-back; both agents are built by a person.
- Outbound has no transfer and no callback tool; it can book only for the dialled number.
- One provisioning job and one Sarvam number per customer.
- Call records do not store which agent answered.
- Not browser-checked: the bridge panel role pill and the numbers page call-direction block.
- This audit did not review the whole application, only the branch and the paths it touches or depends on.

## 18. Decisions needed from the owner

1. Release route: direct Worker deploy (recommended) or merge to `main`; and a hold on Lovable pushes.
2. H2: fixed after this audit. Review the admin-attested confirmation before relying on it.
3. H1: fixed after this audit.
4. Approve a gate package for `20261204090000`.
5. Approve the test tenant, spare number and real calls for section 13.
6. Outbound policy: keep no transfer and no callback; keep outbound booking.
