# One Sarvam agent per customer: inbound and outbound

Every ClickAI customer has exactly one Sarvam agent (one app id, one
committed version at a time). It answers inbound calls through the
customer's deployment and is dialled by ClickAI for outbound calls through
Sarvam's instant-outbound API. There is no second agent and no second
provisioning step.

## How the direction is set

| | Inbound | Outbound |
|---|---|---|
| Started by | the caller, through the deployment | ClickAI (`createInstantOutbound`) |
| `call_direction` | the agent's declared default, `inbound` | `outbound`, passed in `app_config.agent_variables` |
| Opening line | the agent's own intro (`{{greeting}}` from ClickAI) | `app_config.app_overrides.initial_bot_message`, built by ClickAI per call |
| Campaign objective / instructions | none | `campaign_objective`, `campaign_instructions` agent variables |
| ClickAI call id | none | `clickai_call_id` agent variable |

Both request fields are in Sarvam's instant-outbound API reference
(`docs.sarvam.ai/voice-agents/api/instant-outbound/create.md`). Sarvam has
no documented direction field or system variable, so the direction is a
variable ClickAI sets explicitly on every outbound call. Inbound calls pass
nothing, so stored campaign data can never switch an inbound call to
outbound. Only ClickAI's server (with the workspace API key) can set agent
variables; callers cannot.

## What the agent version must contain (template requirement)

Sarvam drops variables an agent does not declare, so an agent version is
usable for outbound only when it declares:

| Variable | Default | Notes |
|---|---|---|
| `call_direction` | `inbound` | not agent-updatable; never in any tool's `save_to_variables` |
| `clickai_call_id` | empty | |
| `campaign_objective` | empty | |
| `campaign_instructions` | empty | customer-written text, treated as data, never as a way to widen tools |

and its prompt:

- keeps every inbound section unchanged and adds a short routing section:
  when `{{call_direction}}` is `outbound`, follow the outbound section only;
  otherwise follow the inbound phases;
- has an outbound section: confirm it is a good time and the right person
  before saying anything about them; give the business and the reason
  (`{{campaign_objective}}`); follow `{{campaign_instructions}}` within the
  guardrails; record outcomes (interested, not interested, callback
  requested, completed); honour "do not call me" (`opted_out` / `do_not_call`
  output variables, which ClickAI applies to the contact); on a recorded
  greeting or beep, leave one short message and end;
- keeps voicemail detection off: it is agent-wide and would also act on
  inbound calls.

The same requirements go into the master template, so every new customer's
single agent has them from the start.

## Turning outbound on for a customer

1. Commit the agent version above in Sarvam and move the customer's
   deployment to it with **Sarvam app mapping** (the verified remap; a few
   seconds' pause).
2. Inbound regression check: one inbound call still greets and books as
   before.
3. One supervised outbound call to an allow-listed number (admin outbound
   call).
4. Admin → Provisioning → **Confirm this version for outbound**. This records
   `agent_configs.sarvam_outbound_ready_app_id/_version`. ClickAI dials only
   while they equal the current mapping: remapping to another version blocks
   outbound until that version is confirmed too. **Withdraw outbound** clears it.

## Not verified yet (needs the supervised test)

- That the version used by the inbound deployment can also be dialled
  through instant outbound.
- That the per-call variables reach the conversation and the routing
  section is followed reliably.
- Caller ID and outbound permission on the customer's provider connection.
