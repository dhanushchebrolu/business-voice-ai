# Smile Dental v6 — `record_call_outcome` tool update (proposed, not written)

Sends Sarvam's after-call `opted_out` variable to ClickAI, so an opted-out
caller is never saved as a lead and a callback lead saved earlier in the same
call is marked `do_not_contact`. Not written to Sarvam. Needs the ClickAI Worker
with the opt-out handling deployed first (an unknown body field is ignored by
the current Worker, so the order is safe either way, but only the new Worker
acts on it).

## Request contract (eight fields)

| Field            | Source                            | Notes                                                                             |
| ---------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| `interaction_id` | system variable `interaction_id`  | once-per-call key                                                                 |
| `caller_number`  | system variable `user_identifier` | inbound: caller ID (unverified identity)                                          |
| `outcome`        | agent variable `call_outcome`     | `booked` / `enquiry_answered` / `callback_requested` / `not_interested` / `other` |
| `summary`        | agent variable `call_summary`     |                                                                                   |
| `customer_name`  | agent variable `customer_name`    |                                                                                   |
| `interest`       | agent variable `caller_interest`  |                                                                                   |
| `requested_slot` | agent variable `requested_slot`   |                                                                                   |
| `opted_out`      | agent variable `opted_out`        | **new**; `yes`/`true` (any case) = opted out; anything else = not                 |

Pinned by the test "record_call_outcome's recommended body is exactly the
eight-field contract" (`src/lib/sarvam-agent-api.server.test.ts`), which reads
`sarvamToolConfiguration()` — the admin brief ClickAI shows for this tool.

## Proposed write (v6 draft only)

Registry row on the v6 draft: `d66d374a-85a5-4eca-a6ec-752161f273d8`
(`record_call_outcome`, `webhook_on_end`), re-read 2026-11-18. Use
`configure_app_tool` (not `create_api_tool`: its flat body cannot express the
two `system_variable` fields, and a body map replaces the stored body whole).

`configure_app_tool` documents that an omitted field keeps its stored value,
but its input schema also declares defaults that differ from this row
(`lifecycle` "run", `execution_order` 0, `timeout_seconds` 8). So every stored
non-auth setting is sent explicitly with its current value; a default can then
never replace it. `auth` is omitted: the server refuses auth on a tool write
and the stored secret reference is kept. `url` is sent unchanged.

### Before / after (the v6 draft row)

| Setting                                               | Before (stored)                                                        | After                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| url                                                   | `https://clickai.in/api/public/sarvam/agent/tools/record_call_outcome` | unchanged                                                 |
| auth                                                  | bearer, stored secret reference                                        | unchanged (not sent)                                      |
| method                                                | POST                                                                   | unchanged                                                 |
| lifecycle                                             | on_end                                                                 | unchanged (sent explicitly)                               |
| execution_order                                       | 100                                                                    | unchanged (sent explicitly)                               |
| timeout_seconds                                       | 10                                                                     | unchanged (sent explicitly)                               |
| headers, path_params, query_params, save_to_variables | empty                                                                  | unchanged (sent explicitly)                               |
| mock_config                                           | simulate false, playground false                                       | unchanged (sent explicitly)                               |
| resp_template, on_failure                             | not set                                                                | unchanged (not sent)                                      |
| enabled                                               | true                                                                   | expected unchanged — verify on read-back                  |
| body                                                  | 7 entries                                                              | 8 entries: **+ `opted_out` ← agent variable `opted_out`** |

```diff
   body:
     interaction_id  ← system_variable interaction_id
     caller_number   ← system_variable user_identifier
     outcome         ← agent_variable call_outcome
     summary         ← agent_variable call_summary
     customer_name   ← agent_variable customer_name
     interest        ← agent_variable caller_interest
     requested_slot  ← agent_variable requested_slot
+    opted_out       ← agent_variable opted_out
```

### Proposed call (not executed)

```json
{
  "agent_id": "Conversatio-9c6a04cd-3334",
  "tool_id": "d66d374a-85a5-4eca-a6ec-752161f273d8",
  "tool_type": "webhook_on_end",
  "name": "record_call_outcome",
  "connector_config": {
    "url": "https://clickai.in/api/public/sarvam/agent/tools/record_call_outcome",
    "method": "POST",
    "lifecycle": "on_end",
    "execution_order": 100,
    "timeout_seconds": 10,
    "headers": [],
    "path_params": [],
    "query_params": [],
    "save_to_variables": [],
    "mock_config": { "simulate": false, "playground": false },
    "body": [
      {
        "name": "interaction_id",
        "type": "system_variable",
        "value": { "variable_name": "interaction_id" }
      },
      {
        "name": "caller_number",
        "type": "system_variable",
        "value": { "variable_name": "user_identifier" }
      },
      { "name": "outcome", "type": "agent_variable", "value": { "variable_name": "call_outcome" } },
      { "name": "summary", "type": "agent_variable", "value": { "variable_name": "call_summary" } },
      {
        "name": "customer_name",
        "type": "agent_variable",
        "value": { "variable_name": "customer_name" }
      },
      {
        "name": "interest",
        "type": "agent_variable",
        "value": { "variable_name": "caller_interest" }
      },
      {
        "name": "requested_slot",
        "type": "agent_variable",
        "value": { "variable_name": "requested_slot" }
      },
      { "name": "opted_out", "type": "agent_variable", "value": { "variable_name": "opted_out" } }
    ]
  }
}
```

Unverified until the write: the draft's `tools_config` attaches this tool as
`c9353d4c-…` version 3 (a different id from the registry row). Whether a row
update re-points that attachment is not documented; the read-back below must
check it.

Preconditions: `opted_out` is declared on the v6 draft (done: enum yes/no,
post-interaction). The first seven entries are copied from the live row as
read on 2026-11-18. `configure_app_tool` has no dry run.

After the write: read the draft back with `include: ['tools']` and
`config.llm_config.agent_config.tools_config`, and confirm: eight body entries;
auth still the same stored secret reference; url, lifecycle, execution order,
timeout and `enabled` unchanged; `tools_config` still attaches
`record_call_outcome` as ON_END with execution order 100. Do not commit v6
until a text chat whose end-of-call variables include `opted_out = yes` shows `opted_out: true` in ClickAI's `call_outcome` event and
no lead.

## Without the tool field

ClickAI also recovers the outcome (including `opted_out`) from the stored
call-end webhook when the tool call never arrives
(`sweep.call_outcome_reconcile`); this does not depend on the tool body.
