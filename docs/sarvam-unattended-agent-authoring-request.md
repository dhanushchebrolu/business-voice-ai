# Unattended Sarvam agent authoring: findings and the request to Sarvam

Checked 2026-11-27 against the official docs and the public OAuth discovery metadata. Answer:
**ClickAI cannot create Sarvam agents unattended today; nothing in Sarvam's published surface allows it.**

## What was checked

| Question                                                                   | Result (source)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent create/clone/configure/commit via REST?                              | No. The Voice Agents API covers deployments, campaigns, cohorts, instant outbound, analytics, boards, tests, webhook configs, experiments, BYOK ([llms.txt](https://docs.sarvam.ai/voice-agents/llms.txt), [API introduction](https://docs.sarvam.ai/voice-agents/api/introduction)). Deployments only take an existing `app_id` + `app_version` ([create deployment](https://docs.sarvam.ai/voice-agents/api/deployments/create)). |
| Agent authoring at all?                                                    | Only in the console, Genie ([genie](https://docs.sarvam.ai/voice-agents/build/genie)) and the Voice Agents MCP server ([mcp](https://docs.sarvam.ai/voice-agents/mcp)): `configure_agent` (create/update/clone), `agents` (commit), `create_http_tool`, `configure_deployment`.                                                                                                                                                     |
| MCP auth                                                                   | OAuth 2.1 through Sarvam SSO; "the client stores the token and reuses it for 24 hours; there is no refresh token"; token scoped to one org and workspace; "No API keys are pasted into client config" ([mcp](https://docs.sarvam.ai/voice-agents/mcp)).                                                                                                                                                                             |
| Service account / client credentials?                                      | None documented. The MCP server's discovery document (`https://mcp.sarvam.ai/voice-agents/.well-known/oauth-authorization-server`) lists `grant_types_supported: [authorization_code, refresh_token]`, `token_endpoint_auth_methods_supported: [none]`, PKCE S256 only, plus dynamic client registration. No `client_credentials`; the documented flow gives no refresh token even though the grant is listed.                      |
| Does the Voice Agents API key (Settings → API Key) carry authoring rights? | It authenticates the REST services only (`X-API-Key`); nothing documents it on the MCP server or any agent endpoint ([api-key](https://docs.sarvam.ai/voice-agents/settings/api-key)). It is also separate from the Model API key.                                                                                                                                                                                                  |
| Enterprise/private API?                                                    | Docs mention enterprise "extensions", policies, and enterprise-only tools (`upload_agent_code`, workflows) but no service-account or private authoring API ([extensions](https://docs.sarvam.ai/voice-agents/settings/extensions), [policy](https://docs.sarvam.ai/voice-agents/settings/policy)). Sarvam's team also said in Discord (Oct 2026) there is no server-to-server agent authoring and no timeline.                      |
| Can a server worker legitimately satisfy the MCP auth?                     | Only by holding a person's SSO session. That session expires daily and is a personal credential; storing it as a permanent backend secret, or scripting the SSO login, is not a supported architecture and is not done here.                                                                                                                                                                                                        |

Not done (by rule): browser automation, cookie/token extraction, undocumented or guessed endpoints
(for example the `app-authoring` service's agent paths), request bodies for `configure_agent` (its
schema is only served by the MCP resource `sarvam://schemas/agent-config` behind the login).

## What ClickAI does today

Operator bridge (see `voice-ai-provisioning-workflow.md`): an admin signs in to Sarvam in their own
MCP client, connects the same client to ClickAI's bridge, and the client builds the waiting
customers' agents. Everything else (deployment, number routing, verification, activation, retries) is
automatic. The provider authorization dependency is isolated behind `AgentProvisioner`
(`defaultAgentProvisioner()` returns the unsupported implementation) and `AUTHORING_STATUS`
(`src/lib/sarvam-agent-authoring-status.ts`, shown on `/admin/provisioning`). A provider
401/403 is already handled (`PROVIDER_AUTH_EXPIRED` / `PROVIDER_PERMISSION_DENIED`: the job parks
for a person, nothing is retried blindly, nothing is duplicated on resume), and 429/5xx are retried
with backoff, so a real implementation only has to supply the four provider calls.

## The exact request to send Sarvam (developer@sarvam.ai, or the account team / Discord thread)

> Subject: Service credential for unattended Voice Agents authoring (ClickAI, SaaS on Sarvam Voice Agents)
>
> We run a SaaS (ClickAI) that provisions one dedicated voice agent per customer inside our single
> Sarvam workspace, using your documented deployments API for inbound numbers. Agent create /
> clone / configure / commit is only documented through the Voice Agents MCP server, which requires
> an interactive SSO login (24 h token, no refresh token), so our backend cannot automate it.
>
> Please enable, for our organisation/workspace, ONE of:
>
> 1. A service credential (OAuth `client_credentials` or a long-lived, revocable, workspace-scoped
>    token) accepted by `https://mcp.sarvam.ai/voice-agents`; or
> 2. Agent-authoring REST endpoints (create/clone, configure, commit, read) under the Voice Agents API
>    key (`X-API-Key`), with published request schemas.
>
> Required permissions: create agent, clone agent from a template agent, configure agent (prompt,
> variables, HTTP tools, voice, languages), commit version, read agent/version. Not needed: org or
> billing administration, deleting agents, campaign access.
>
> Requirements: usable from a Cloudflare Worker; documented renewal/rotation; revocation; per-call
> idempotency or a documented way to look an agent up by name; rate limits. Is this an Enterprise
> feature or something support can enable on our plan? Customers will stay inside our workspace; we
> do not want per-customer Sarvam accounts. We will not store personal SSO sessions as backend secrets.

## When Sarvam answers

1. Implement `AgentProvisioner` (`find` by name, `create` by cloning the master template,
   `configure` from `buildUniversalAgentConfig` + `sarvamToolConfiguration`, `commit`, `verify`) using
   the schemas Sarvam documents; return it from `defaultAgentProvisioner()` when the credential is set;
   flip `AUTHORING_STATUS`. The pipeline, retries, idempotency, tenant isolation, events and UI already work
   with it (tests: `voice-provisioning-workflow.test.ts`, "agent creation" and "provider authorization").
2. Keep the operator bridge as the fallback for `PROVIDER_AUTH_EXPIRED` / `PROVIDER_PERMISSION_DENIED`.
