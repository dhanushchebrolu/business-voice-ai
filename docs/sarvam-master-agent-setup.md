# Dedicated Sarvam master agent for ClickAI provisioning

Preparation only. **Nothing has been created in Sarvam.** The package is generated from the code
that builds every customer's work order, so the master and the customer agents cannot drift:

```
node --experimental-strip-types scripts/print-master-agent-package.mjs https://clickai.in > docs/sarvam-master-agent-package.json
```

`docs/sarvam-master-agent-package.json` holds the universal template version, the master tool list
(`clickai_business_context`, `get_business_info`, `check_availability`, `book_appointment`,
`request_callback`, `record_call_outcome`, `call_transfer`), the capability map, and the inbound agent
definition (system prompt, prompt guard, HTTP tool specs, input and output variables, IP allowlist). It
contains no secrets and no customer data.

## How ClickAI finds the master

- **Setting:** the Worker variable `SARVAM_MASTER_AGENT_APP_ID` (read by `masterAgentAppId()` in
  `sarvam-agent-registration.server.ts`; the bridge returns it to the operator as
  `template.masterAgentAppId` / `templateAgentAppId`). It is **not set in production today** (Worker
  `3abcf27e` has no such binding).
- **Set it later** (not now): `wrangler secret put SARVAM_MASTER_AGENT_APP_ID` for the `klyro` worker (or a
  plain var), then deploy. The Sarvam agent id is not a secret, but a secret binding survives
  `--keep-vars` deploys like the others.
- **Protection:** ClickAI refuses to map any customer to that id (`applySarvamAgentMapping`, the pipeline's
  master check, the bridge's `submit_agent_result`), so the master can never become a customer's agent.
- `SARVAM_OUTBOUND_MASTER_AGENT_APP_ID` is the separate outbound template; not needed for this test.

## Why the master is unmapped and customer data stays dynamic

The master carries only the shared prompt, guardrails and tools. Per-customer facts (business name,
hours, services, FAQs, rules, greeting) are NOT baked in: they are served at call time by ClickAI
(`clickai_business_context` / on-start hook, behind the admission gate that serves nothing to an
unverified number). What differs per customer is applied when their agent is built from the master:
tool set (capabilities), voice, languages, the customer's own Bearer secret, and the prompt variant
(`healthcare` or not). So the master needs no phone number, no deployment, and must have none.

## Manual creation checklist (you, in Sarvam, later)

Never clone or reuse Smile Dental's live agent (`Smile-Denta-…`, v5) as the template, and never edit it.

1. [ ] In the Sarvam Voice Agents console (or Genie), create a NEW agent named exactly
       `ClickAI Master (do not deploy)`. Start blank, not from Smile Dental.
2. [ ] Paste `agent.systemPrompt` from `docs/sarvam-master-agent-package.json` as the instructions.
3. [ ] Add the input variables and output variables from the package, exactly as named.
4. [ ] Add the HTTP tools from `agent.tools` (names, URLs on `https://clickai.in`, request shapes, reply
       templates). For the Bearer secret use a placeholder secret value such as `MASTER-PLACEHOLDER`
       (a real customer token is set only on each customer's own copy). Do not use any real token.
5. [ ] Apply `agent.promptGuard` / guardrails and the IP allowlist (`agent.allowlistIps`).
6. [ ] Voice and language: any valid default (for example the voice Smile Dental uses, chosen fresh).
       Each customer's work order replaces them with that customer's saved voice and languages.
7. [ ] Validate the config in Sarvam, then **Commit** once (an immutable version is required to clone).
8. [ ] Do NOT create a deployment, connect a number, create a campaign, or place a test call.
9. [ ] Confirm in Sarvam → Deployments and Phone numbers that nothing references the master.
10. [ ] Copy the agent id (not a version) and give it to the ClickAI deployer to set as
        `SARVAM_MASTER_AGENT_APP_ID` after the migration and deploy steps.
11. [ ] Keep the master read-only afterwards. Changing it never changes existing customers (they are
        copies); new customers get the change. If the ClickAI template version changes, rebuild
        the package and re-apply the diff to the master.

## Verification after setting the variable (still no live changes)

- Admin → Provisioning → Agent builder shows no "master not configured" warning; any work order's
  checklist has "Master template configured in ClickAI" ticked.
- `submit_agent_result` with the master id is refused (test: "the master template … refused").
