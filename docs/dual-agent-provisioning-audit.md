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

## 4. Not changed

No migration was written or applied, no Sarvam agent or deployment was created or modified, no number was remapped, outbound and campaigns remain off, Payment Enforcement unchanged.
