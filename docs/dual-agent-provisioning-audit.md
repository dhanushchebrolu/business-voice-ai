# Dual-agent provisioning: audit and plan (2026-11-19)

Request: every customer gets an inbound and an outbound Sarvam agent, both created **programmatically** from central templates. The outbound agent must not have booking, callback or reminder tools.

**Status: stopped at the audit.** Sarvam has no documented API for creating or configuring agents, so ClickAI cannot create them programmatically. No code, schema, Sarvam or production change was made.

## 1. What exists today

| Area             | Where                                                                                  | Behaviour                                                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model            | `docs/sarvam-one-agent-inbound-outbound.md`                                            | **One** Sarvam agent per customer for both directions; `call_direction` agent variable set by ClickAI on outbound                                                                                                                                                                             |
| Template         | `src/lib/universal-agent-config.ts`                                                    | One universal master agent (`UNIVERSAL_AGENT_TEMPLATE_VERSION = 1`); capabilities → tool list (`MASTER_AGENT_TOOLS` includes `book_appointment`, `request_callback`); business data loaded live by the on-start hook, never baked in                                                          |
| Trigger          | `payments/razorpay-platform-webhook.server.ts` → `provisioning-orchestrator.server.ts` | Setup-fee payment starts provisioning; never throws into the webhook                                                                                                                                                                                                                          |
| Pipeline         | `provisioning-pipeline.server.ts` (10 idempotent steps)                                | Steps 4–6 are **manual**: admin issues the per-agent credential, copies the master agent in Sarvam, registers `agent_configs.sarvam_app_id/_version` (`registerCustomerSarvamAgent`). Steps 7–10 automated: create/adopt inbound deployment (paused), verify, verify number mapping, activate |
| Jobs / retry     | `provisioning-runs.server.ts`, table `provisioning_runs`                               | One active run per org (partial unique index), statuses pending/running/waiting/succeeded/failed, step + note, generated config + fingerprint, verification report; admin Retry re-runs the same function                                                                                     |
| Sarvam client    | `telephony/sarvam-api-client.server.ts`                                                | Deployments (create/update/list/get/status), campaigns, cohorts, instant outbound (`appOverrides.initialBotMessage/initialStateName`), analytics. **No agent (app) endpoints**                                                                                                                |
| Tool auth        | `sarvam-agent-api.server.ts`, table `sarvam_agent_integrations`                        | Bearer credential per agent config, **one active per agent config** (partial unique index); org resolved from the credential, never the body                                                                                                                                                  |
| Inbound routing  | number → deployment → `sarvam_app_id`                                                  | Admission gate serves data only to ACTIVE numbers with verified mapping                                                                                                                                                                                                                       |
| Outbound routing | `sarvam-outbound-call.server.ts`, `campaign-dispatch.server.ts`                        | Both dial `agent_configs.sarvam_app_id/_version` (the **inbound** agent); allowed only when `sarvam_outbound_ready_app_id/_version` equal that mapping                                                                                                                                        |
| Outbound safety  | `8270fc9` (not deployed)                                                               | Kill switch, test allowlist, admission/wallet, server-side refusal of `book_appointment`/`request_callback` when the body carries an outbound `clickai_call_id`                                                                                                                               |

## 2. Sarvam capabilities (checked 2026-11-19)

- **Public Voice Agents API** (`docs.sarvam.ai/voice-agents/llms.txt`, API reference): deployments, cohorts, campaigns, instant outbound, webhook configs, experiments, analytics, boards, tests, BYOK. **No create, clone, configure, set-tools or commit endpoints for agents.** Agents are authored only in the console, by Genie, or through the Sarvam MCP server (an interactive, user-authorised tool, not a documented server-to-server API).
- **This workspace allows single-state agents only** (a second state was refused, runbook §8.6), so one agent cannot isolate tools per direction.
- The MCP server _can_ clone an agent and enable/disable tools, but it refuses to write tools that carry the ClickAI credential ("a secret may only be attached to an allow-listed url"), so even an operator-run clone needs the console for the four ClickAI tools.

So steps 4–5 of the requested orchestration ("create customer-specific inbound agent", "create customer-specific outbound agent") **cannot be automated on a documented contract**. Building them on the MCP server or on guessed `/apps` endpoints would be an unverified integration on the provisioning path that a payment triggers.

## 3. Plan (needs one decision)

What can be built now without guessing any Sarvam endpoint ("semi-automated dual agent"):

1. **Templates in code:** split `universal-agent-config.ts` into two roles. _Inbound_: today's capability → tool mapping. _Outbound_: fixed allow-list `clickai_business_context`, `get_business_info`, `check_availability`, `record_call_outcome`; never `book_appointment`, `request_callback`, `send_reminder`, `call_transfer`. Both generated with the fingerprint per role; template version bumped to 2.
2. **Schema (additive migration, not applied):** `agent_configs.sarvam_outbound_app_id/_version` (+ registration timestamps); `sarvam_agent_integrations.role` (`inbound` | `outbound`) with the unique index changed to one active credential per agent config **and role**; `provisioning_runs` keeps step tracking and gains the outbound agent fields in its verification report. Existing rows default to `inbound`, so live mappings are untouched.
3. **ClickAI-side tool enforcement (the hard boundary we control):** the tool API refuses `book_appointment`, `request_callback` and any write tool for an **outbound-role credential**, whatever the agent sends. This holds even if someone misconfigures the Sarvam outbound agent, and does not depend on `clickai_call_id`.
4. **Pipeline:** steps 4–6 cover both agents. The admin step becomes "create the inbound and outbound agents from the two templates and commit", guided by the generated per-role config; ClickAI issues one credential per role and registers each agent separately, so a retry after the inbound agent is registered never touches it again. The inbound deployment steps (7–10) stay as they are; the outbound agent needs no deployment (instant outbound dials an app id/version).
5. **Outbound routing:** `sendInstantOutboundCall` and campaign dispatch dial `sarvam_outbound_app_id/_version` and refuse when unset; they never fall back to the inbound agent. Outbound readiness confirms the outbound agent.
6. **UI:** customer status gains "Creating outbound AI agent" / "Outbound agent ready"; admin detail shows both agents, both credentials (safe columns only) and per-role retry.
7. **Tests:** template tool allow-lists, credential-role refusals, routing selects the outbound agent, retry after partial success, tenant isolation, migration pg tests.

Smile Dental would need its own outbound agent created (console) and registered; its inbound agent, deployment and number mapping are untouched.

Options for the agent-creation step itself:

- **A. Semi-automated (above)** — operator creates two agents per customer in Sarvam; everything else automated and enforced. Buildable now.
- **B. Ask Sarvam** for a supported app-authoring API (clone app, set tools, commit) or an enterprise extension; then step 4 becomes automatic with the same schema and routing.
- **C. Drive the Sarvam MCP server from ClickAI** — not recommended: undocumented as a server API, user-OAuth bound, and still cannot attach the ClickAI credential to tools.

## 4. Implemented: Option A (2026-11-20, feature branch only)

Option A was approved. Nothing below is deployed or applied to production.

**Schema** (`supabase/migrations/20261120090000_dual_agent_provisioning.sql`, additive; rollback `docs/production-rollback-20261120090000-dual-agent-provisioning.sql`; real-PostgreSQL test `dual_agent_provisioning.pg.test.ts`):

- `agent_configs.sarvam_outbound_app_id/_version/_registered_at/_registered_by`, set together or not at all; unique per outbound agent; trigger `agent_configs_sarvam_role_guard` refuses an outbound agent that is the same or any customer's inbound agent or shared application, and the reverse.
- `sarvam_agent_integrations.role` (`inbound` default | `outbound`); one active credential per agent **and role**. Existing rows become `inbound`; no live mapping changes.

**Templates** (`src/lib/agent-roles.ts`, `universal-agent-config.ts`, `sarvam-agent-api.server.ts`): inbound template unchanged (fingerprint unchanged). Outbound template `buildOutboundAgentConfig` + `sarvamToolConfiguration(base, "outbound")`: only `clickai_business_context`, `get_business_info`, `check_availability`, `record_call_outcome`; declares `call_direction`, `clickai_call_id`, `campaign_objective`, `campaign_instructions`; outputs `opted_out`. Same voice and languages as the inbound agent.

**Enforcement (backend, not prompt):** an `outbound` credential can call only the context, `get_business_info`, `check_availability` and `record_call_outcome`; `book_appointment` and `request_callback` return 403 `forbidden_for_outbound_agent`, audited as `OUTBOUND_AGENT_TOOL_FORBIDDEN`, before the body is read. Unknown roles get 401. The outbound credential is admitted only while the customer's outbound agent is registered and the customer is not suspended (`checkOutboundAgentAdmission`). The older `clickai_call_id` refusals stay as a second layer.

**Routing:** `outboundAgentTarget()` is the only selector. Single calls, the campaign dispatcher, campaign launch and Sarvam-campaign status changes dial only the registered outbound agent, in the version confirmed after a supervised call (`sarvam_outbound_ready_*` must equal it), never `sarvam_app_id`; there is no fallback. A Sarvam console campaign must report the same `app_id`/`app_version` before any cohort upload. Inbound routing (number → deployment → inbound agent) is unchanged.

**Provisioning:** pipeline steps 11 (outbound credential) and 12 (outbound agent registered, not the inbound agent or a master). Inbound goes live at step 10 regardless; the run completes only after step 12. Steps are read-first, so a retry after partial success re-reads the live inbound side and never creates a second deployment, credential or registration. Registering never confirms outbound calling.

**Operator workflow** (Admin → Provisioning → customer → _Outbound agent_): issue the outbound credential (shown once), copy the outbound template, create and commit the agent in Sarvam, register its id and version (gate + server checks: own customer, not inbound, not a master, not used by anyone else). Then, separately and after a supervised call, _Confirm the outbound agent for outbound calls_. Checklist steps 11–13 show progress and failures.

**Customer view:** the account panel shows plain steps (business information, inbound agent, outbound agent, phone number, phone line, ready) with "Our team is on it" instead of errors or ids.

**Still manual:** creating and committing both agents in Sarvam (no API), storing each credential as that agent's Sarvam secret, confirming numbers in Sarvam, and the supervised-call confirmation. New env var: `SARVAM_OUTBOUND_MASTER_AGENT_APP_ID` (optional, the outbound master template's id).

**Before production, in order (each needs approval):** apply migration `20261120090000` (after `20261119090000`); deploy the Worker; for Smile Dental issue an outbound credential, create and commit its outbound agent in Sarvam, register it; one supervised outbound call; confirm it for outbound; switch outbound on for 0061. Until then outbound stays impossible: no customer has an outbound agent, so `outboundAgentTarget` returns nothing.

## 5. Pre-rollout verification (2026-11-20)

**Browser (local harnesses, mocked server data):** `npm run harness:customer-status` renders the real customer `AccountStatusPanel` through the real workspace queries (only the Supabase client is faked, its state kept across refreshes). Checked every stage: paid/pending, number assigned, inbound registered (partial), verification failed, retry succeeded with the outbound agent missing, ready, handed over; refresh keeps the stage; Dashboard ↔ Billing navigation; no console errors. `npm run harness:provisioning` covers the admin outbound panel. **Defect found and fixed:** the customer steps listed the outbound agent before the phone line, so during deployment verification (and after a failed verification) the customer was told the outbound agent was the step in progress. Steps now follow the pipeline order.

**End-to-end simulation** (`src/lib/dual-agent-e2e.test.ts`): the real run orchestrator, pipeline and registration helpers with Sarvam mocked. Activation (twice) → number → inbound credential and agent → live line → outbound credential and agent → ready, with the customer's view asserted at each stage. Recovery from an unexpected error, a lost create response (retry adopts, never creates twice), a deployment on the wrong agent, a failed resume, wrong outbound ids and repeated issue/registration: always one deployment, one credential per role, one active run, the outbound agent never the inbound one, and never dialable.

**Outbound entry points (no fallback):** customer single call, admin single call, admin demo test call (all through `sendSarvamInstantOutboundCall`), campaign dispatcher (every-minute cron and job handler), campaign launch, Sarvam console campaign cohort upload and status changes: all select the agent with `outboundAgentTarget` and refuse otherwise; behaviour tests cover the single call and the dispatcher, source checks cover launch and cohort upload. The LiveKit SIP path (`voice-agent/outbound.server.ts`) never uses Sarvam agents, serves Vobiz numbers only and is off unless `VOICE_AGENT_OUTBOUND_ENABLED=true`.

**Safety controls in front of every Sarvam dial:** global kill switch (`OUTBOUND_CALLING_DISABLED`), supervised-test allowlist, the number's `outbound_enabled`, ownership and do-not-call checks, a registered **and** confirmed outbound agent, calling hours, and atomic admission (`admit_single_outbound_call`, migration 20261119090000). Provisioning never sets `outbound_enabled` or confirms an agent.

**Migration review:** additive; `ADD COLUMN ... DEFAULT 'inbound'` is metadata-only; the new CHECKs validate 2 + 1 rows; index builds are instant at this size. **Defect found and fixed:** the role guard trigger did not fire when an agent is mapped through a shared application (the update names only `sarvam_application_id`); it now does, with a PostgreSQL test that fails on the previous version. Trigger order (by name) runs the application guard first, so the role guard sees the resolved app id. Rollback disables outbound credentials, restores the old index, and leaves `sarvam_outbound_ready_*` pointing at outbound ids, which the old code treats as "not confirmed" (fails closed).

**Production preconditions (read-only, 2026-11-20):** latest applied migration `20261118120000`; `20261119090000` and `20261120090000` both pending (apply in that order); none of the new names exist except the old `idx_sarvam_agent_integrations_one_active` (replaced); 2 agents, 1 mapped, 0 confirmed for outbound; 1 credential (active); no agent with two active credentials; no shared application also mapped directly.

## 6. Not changed

A migration was written but not applied; no Sarvam agent or deployment was created or modified, no number was remapped, outbound and campaigns remain off, Payment Enforcement unchanged.
