# Dual-agent provisioning: architecture

Every customer has two separate Sarvam agents. This supersedes the plan in
`dual-agent-provisioning-audit.md` (2026-11-19): Sarvam still has no agent-authoring API for us, so
authoring is a person's step (operator bridge), isolated behind `AgentProvisioner`.

## Identity per role

| Per agent          | Inbound                                        | Outbound                                                                                                       |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Agent id / version | `agent_configs.sarvam_app_id/_version`         | `agent_configs.sarvam_outbound_app_id/_version`                                                                |
| Credential         | `sarvam_agent_integrations` role `inbound`     | role `outbound`                                                                                                |
| Configuration      | `buildUniversalAgentConfig`                    | `buildOutboundAgentConfig` (never derived from inbound)                                                        |
| Tools              | six, cloned master v2 + recreated              | `OUTBOUND_AGENT_TOOLS` allowed by capabilities                                                                 |
| Tool `agent_ref`   | `inbound:<agent config id>`                    | `outbound:<agent config id>`                                                                                   |
| Checkpoint events  | `role: inbound` (also events with no role)     | `role: outbound`                                                                                               |
| Deployment         | one, on the customer's number, verified        | none: instant outbound needs no deployment                                                                     |
| Verification       | deployment, version, number, mapping read back | tool-credential confirmation, then an admin's confirmation after a supervised call (`sarvam_outbound_ready_*`) |
| Bridge token       | inbound job states                             | outbound job states                                                                                            |

`registeredAgent(row, role)` and `outboundConfirmed(row)` (`agent-roles.ts`) are the readers to use.
The database refuses one agent in both roles or for two customers
(`20261120090000_dual_agent_provisioning.sql`).

## One job, two stages

One provisioning job per customer covers both agents (one active job per organisation is enforced by
the database): inbound steps 1-10, then outbound credential (11), agent and checkpoint (12). Retry
counters and attempts are **per job**, not per role; the job's state says which agent it waits on,
and every event carries the role.

States added: `waiting_for_outbound_tool_authentication`.

## What blocks what

- Inbound number goes live only after the inbound checkpoint and verification. It does not wait for
  outbound.
- The job completes only when the outbound agent is registered **and** its tool credentials are
  confirmed.
- Dialling needs all of: registered outbound agent, confirmed tool credentials (to be marked ready),
  an admin's ready confirmation for exactly that version, and the existing outbound gates. There is no
  fallback to the inbound agent anywhere (`outboundAgentTarget`).
- The recovery sweep does **not** resume outbound states: a re-run also re-verifies the live inbound
  side, so it stays a deliberate action ("Run provisioning" or the submission itself).

## Existing customers

Nothing is migrated, created, redeployed or remapped, and this change adds no migration.

- Live inbound agents: unchanged; never gated.
- Outbound agent already confirmed for calling: unchanged; re-confirming that version stays possible.
- Outbound agent registered but not confirmed: its tool credentials must now be confirmed before it
  can be marked ready (bridge, or an admin's check on the provisioning page).
- A confirmed version that is withdrawn or replaced can be enabled again while the outbound credential
  is live (`voice-ai-provisioning-workflow.md`, "Recovery").
- No outbound agent: outbound calls and campaigns refuse, as before. Add one when wanted: the job
  reaches `waiting_for_outbound_agent`, then follow the outbound work order.
- Tools without `agent_ref` (everything built earlier) behave as before.

## Policy kept, for the owner to decide

The outbound agent has **no call transfer and no callback tool** (`OUTBOUND_FORBIDDEN_TOOLS`), and it
books only for the number ClickAI dialled on an open call. Allowing transfer on outbound calls is a
policy change plus Sarvam configuration; it was not made here.

## What ClickAI cannot verify

Sarvam gives us no read API for agent configuration or tool credentials. Tools, call settings (maximum
length, no transfer) and credentials are as the operator reports them from a read-back. A wrongly
selected credential is refused only when a call reaches ClickAI, via `agent_ref`.
