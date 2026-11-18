# Prerequisite: `record_call_outcome` must send `opted_out` (inbound opt-out)

Status: **not met.** The Smile Dental v6 draft's `record_call_outcome` tool
sends seven fields; `opted_out` is missing (read 2026-11-18). Nothing was
written to Sarvam.

Reconfirmed read-only on 2026-11-18 (final investigation). Outstanding:

1. **Tool update (manual approval step):** add the eighth body field
   `opted_out` ← agent variable `opted_out` to `record_call_outcome`, sending
   every stored non-auth setting explicitly (see the proposal doc). The
   `opted_out` variable is already declared on the draft.
2. **Prompt blockers 1–3:** not applied; the draft prompt is unchanged
   (sha256 prefix `eaa8943c0f251340`).
3. **`send_reminder`:** still attached to the draft (deletion routes were not
   attempted further, per instruction).
4. **Live deployment:** still on v5; v6 is not committed or mapped.

Each of these is a Sarvam write and needs explicit approval. ClickAI's side
(contact suppression, reconciliation of `opted_out`) is ready but not
deployed.

## Why it is a hard prerequisite

ClickAI records each call's outcome once (one `call_outcome` row per
integration + interaction). The first writer wins:

- The Sarvam on-end tool normally arrives first. Without an `opted_out` field
  ClickAI records `opted_out = false`.
- The reconciliation job (`sweep.call_outcome_reconcile`), which does read
  `opted_out` from the stored call-end webhook, then sees the outcome already
  recorded and skips the call.

So until the tool sends `opted_out`, an inbound caller's opt-out is **never**
applied: the callback lead saved earlier in the call is not marked
`do_not_contact`, and a lead can still be created for them. Reconciliation
only covers calls where the tool call never arrived.

Do not describe or rely on the inbound opt-out workflow (agent prompt
blockers 1–3, the `opted_out` after-call variable, ClickAI lead suppression)
until every check below passes for the agent version that is live.

## What the tool must send

Exactly eight body fields (pinned by the test "record_call_outcome's
recommended body is exactly the eight-field contract"):

| Field            | Source                            |
| ---------------- | --------------------------------- |
| `interaction_id` | system variable `interaction_id`  |
| `caller_number`  | system variable `user_identifier` |
| `outcome`        | agent variable `call_outcome`     |
| `summary`        | agent variable `call_summary`     |
| `customer_name`  | agent variable `customer_name`    |
| `interest`       | agent variable `caller_interest`  |
| `requested_slot` | agent variable `requested_slot`   |
| `opted_out`      | agent variable `opted_out`        |

The proposed write (not executed) is in
`sarvam-smile-v6-record-call-outcome-tool.md`; it sends every stored non-auth
setting explicitly because `configure_app_tool`'s schema defaults differ from
this tool's settings.

## Deployment verification checklist (read-only, after the approved write)

Read the draft with `agents(operation='get', include=['tools',
'config.llm_config.agent_config.tools_config', 'variables'])` and record each
result. All must pass before committing the version.

- [ ] **Tool body:** the `record_call_outcome` row has exactly the eight
      entries above; `opted_out` is `agent_variable` → `opted_out`.
- [ ] **Variable exists:** `opted_out` is declared (enum `yes`/`no`,
      `update_post_interaction: true`, with its post-interaction prompt).
- [ ] **Endpoint:** url is
      `https://clickai.in/api/public/sarvam/agent/tools/record_call_outcome`,
      method POST.
- [ ] **Lifecycle:** `on_end`, execution order 100, timeout 10 s (unchanged).
- [ ] **Stored credential:** auth is `bearer` with the same stored secret
      reference as the other ClickAI tools (compare the reference id only;
      never read or print the secret value).
- [ ] **Enabled:** the row shows `enabled: true`.
- [ ] **Attachment:** `tools_config` still attaches `record_call_outcome` as
      `ON_END`, execution order 100 (the attachment uses its own tool id and
      version; confirm it points at the updated tool).
- [ ] **No other change:** every other tool row and the prompt sha are the
      same as before the write.
- [ ] **Text chat:** a chat whose end-of-call variables include
      `opted_out = yes` produces a ClickAI `call_outcome` event with
      `opted_out: true` and no lead (test identifier: no real lead is saved).
- [ ] **After the remap (live version):** repeat the read for the version the
      deployment uses; a supervised inbound test call from the test number
      shows `opted_out` in the outcome event.

Only after all boxes are ticked may the inbound opt-out workflow be enabled
or announced.
