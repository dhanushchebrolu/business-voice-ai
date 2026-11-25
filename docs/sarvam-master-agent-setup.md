# Dedicated Sarvam master agent for ClickAI provisioning: manual setup guide

Verified 2026-11-25 against branch `feature/automated-voice-provisioning` @ `b60b77f` (deployed to
production as Worker `009eea99`). **Nothing has been created in Sarvam.**

## What the master is (and is not)

- A **clone source** only. Every customer's agent is a copy of it, then each copy gets that customer's
  own prompt/tool set/voice/languages/token from the work order. Customer facts (hours, services, FAQs,
  greeting) are never stored in the agent: ClickAI serves them at call time (`clickai_business_context`).
- It must stay **unmapped**: no phone number, no deployment, no campaign, no test call, ever.
  ClickAI also refuses to register the master id as any customer's agent.
- The package `docs/sarvam-master-agent-package.json` is byte-identical to what
  `node --experimental-strip-types scripts/print-master-agent-package.mjs https://clickai.in` generates from the
  branch (checked), and `universal-agent-config.ts`, `sarvam-agent-api.server.ts` and `sarvam-agent-prompt.ts`
  are unchanged between the previously deployed Worker's commit (`3b8513e`) and `b60b77f`. It contains no
  customer data, no secrets, no tokens and no phone numbers (pattern-scanned).

## Exact values

| Item         | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent name   | `ClickAI Master (do not deploy)` (customer copies are named `clickai-<org8>-<agent8>` by their work orders)                                                                                                                                                                                                                                                                                                                                                                                |
| Created from | Blank agent. **Never** from or near Smile Dental's live agent                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Instructions | `agent.systemPrompt` from the package (11,017 characters). Copy it with: `node -e "console.log(require('./docs/sarvam-master-agent-package.json').agent.systemPrompt)" \| clip`                                                                                                                                                                                                                                                                                                            |
| Guardrail    | `agent.promptGuard` from the package, if the console has a guardrails/prompt-guard field                                                                                                                                                                                                                                                                                                                                                                                                   |
| Voice        | `Simran - Hinglish Support Agent`, internal id `01a0cf17-12bd-7de3-9df0-f607db604d52` (v4, validated by ClickAI's catalog for English + Hindi, no warnings). Not in the package; a sensible neutral default. Customers get their own saved voice on their copies                                                                                                                                                                                                                           |
| Languages    | Default/initial `English`; supported and language-identification list `English`, `Hindi`; language identification ON. Exact patch ClickAI applies for these settings: `language_config {initial_language_name: English, supported_languages: [English, Hindi], lid_supported_languages: [English, Hindi], enable_language_identification: true}`, `llm_config.agent_config.supported_languages [English, Hindi]`, `text_to_speech_config {config_version: "2.0", internal_id: 01a0cf17-…}` |
| Opening line | `{{greeting}}` (ClickAI supplies the text per customer through the on-start tool; the console intro must reference that variable, see `docs/sarvam-one-agent-inbound-outbound.md`)                                                                                                                                                                                                                                                                                                         |

### Input variables (21, all strings; default shown, `unavailable` only for the first)

`context_status` (default `unavailable`), then default empty: `missing`, `guidance`, `business_name`,
`greeting`, `business_type`, `business_description`, `business_address`, `business_phone`, `business_email`,
`business_website`, `business_timezone`, `business_date`, `business_time`, `hours_today`, `opening_hours`,
`services_and_prices`, `staff`, `faqs`, `policies`, `knowledge`.

### Output (post-call) variables (5)

| Name              | Type                                                                      | Extraction prompt                                                           |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `call_outcome`    | Enum: booked, enquiry_answered, callback_requested, not_interested, other | What the call achieved for the caller.                                      |
| `call_summary`    | String                                                                    | Two sentences: what the caller wanted and what was agreed.                  |
| `customer_name`   | String                                                                    | The caller's name if they gave it, otherwise empty.                         |
| `caller_interest` | String                                                                    | The service the caller asked about, otherwise empty.                        |
| `requested_slot`  | String                                                                    | The date and time the caller asked for (YYYY-MM-DD HH:mm), otherwise empty. |

### API tools (6), all `POST`, JSON bodies, `Authorization: Bearer <secret>`

Base `https://clickai.in/api/public/sarvam/agent`. The exact bodies, the "save into variables" list of the
on-start tool and the two reply templates (`check_availability`, `book_appointment`) are in
`agent.tools[]` of the package: copy them from there, do not retype.

| Tool                       | When     | URL suffix                   |
| -------------------------- | -------- | ---------------------------- |
| `clickai_business_context` | on start | `/context`                   |
| `get_business_info`        | run      | `/tools/get_business_info`   |
| `check_availability`       | run      | `/tools/check_availability`  |
| `book_appointment`         | run      | `/tools/book_appointment`    |
| `request_callback`         | run      | `/tools/request_callback`    |
| `record_call_outcome`      | on end   | `/tools/record_call_outcome` |

Also enable Sarvam's built-in end-call tool (`end_interaction`, the prompt calls it) and, because language
switching is on, Sarvam's built-in language-change tool. **No call-transfer tool on the master** (the master
prompt says it cannot transfer; a customer who enables transfer gets a different prompt and tool set in their work order).

### Authentication secret (placeholder only)

Create/choose a Sarvam secret for the tools' Bearer value with a **placeholder** such as
`MASTER-PLACEHOLDER-NOT-A-TOKEN`. Never paste a real ClickAI token on the master. Real per-customer tokens are
issued by ClickAI (`issue_agent_credential`) onto each customer's own copy. Open point to confirm in the
console: whether Sarvam secrets are per agent or per workspace. If they are workspace-wide, each customer copy
needs its own uniquely named secret (the work order's operator steps must say so); check this before the first
customer test.

## Verified findings you should know

1. **Package contents are safe**: no customer or Smile Dental data, no tokens, no phone numbers. The
   "Bearer token" lines are descriptions, not values.
2. **Two variables are referenced but not declared** in the inbound package: `@clickai_call_id` (in
   `book_appointment`, `request_callback`) and `@opted_out` (in `record_call_outcome`). They are declared only by
   the outbound template. This matches ClickAI's unchanged inbound template, Sarvam drops undeclared
   variables, and ClickAI treats a missing or literal value as "not an outbound call / not opted out" (the
   server only accepts a UUID call id and only `yes`/`true` for opt-out). So it is safe as is. If the console
   rejects the tool bodies for undefined variables, declare `clickai_call_id` (input, default empty) and
   `opted_out` (output, Enum yes/no, default no) exactly as the outbound agent does; do not remove them from the
   bodies.
3. `allowlistIps` (`4.213.167.70`, `35.154.84.150`) is information about Sarvam's source addresses for the
   ClickAI side. Nothing to configure in Sarvam, and ClickAI does not currently enforce it.
4. The prompt's emergency number (112) and language examples (Telugu/Hindi/English) are generic; each
   customer's work order regenerates the prompt for their tool set.
5. There is no Booking vs Enquiry second master: one master serves both. The work order shows
   `template.profile` (booking/enquiry) from the customer's tools.
6. Sarvam agent ids are not secrets, but ClickAI never maps customers to the master (enforced in code).

## Create it (you, in the Sarvam Voice Agents console)

1. [ ] Create a NEW blank agent named `ClickAI Master (do not deploy)`.
2. [ ] Paste the system prompt (command above) as the instructions; apply `promptGuard` if there is a field.
3. [ ] Add the 21 input variables and 5 output variables exactly as listed.
4. [ ] Add the 6 API tools from `agent.tools[]` (URL, method, auth, body, save-into-variables, reply templates);
       Bearer secret = placeholder. Enable end-call and language-change built-ins; no transfer.
5. [ ] Voice and languages as in the table; intro = `{{greeting}}`.
6. [ ] Validate in the console. Fix only what Sarvam names (see finding 2).
7. [ ] **Commit** once (immutable version needed for cloning). Do not create a deployment, connect a number, make a
       campaign, add a test caller or place a test call.
8. [ ] In Sarvam, confirm Deployments and Phone numbers reference nothing about this agent.
9. [ ] Copy the agent id (not the version) and send it to the ClickAI deployer.
10. [ ] Leave it untouched afterwards. Later template changes: regenerate the package and apply the difference.

## ClickAI side, later (not done yet)

- Set `SARVAM_MASTER_AGENT_APP_ID` on the `klyro` Worker to the new agent id (a secret or plain binding;
  the Worker reads it with `process.env`). It is **not set today** (live Worker `009eea99` has no such binding).
  Setting a binding requires a Worker deploy/secret change, so it needs your separate approval.
  Optional: `SARVAM_OUTBOUND_MASTER_AGENT_APP_ID` is for the outbound template only; not needed.
- Then, in Admin → Provisioning → Agent builder, a work order's checklist item "Master template configured in
  ClickAI" turns ticked and `templateAgentAppId` shows the id.

## After creation: verify without changing anything

- The master id is refused if anyone tries to register it for a customer (covered by tests; the ClickAI
  registration, the pipeline and the bridge all reject it).
- Sarvam shows no deployment or number on it.
