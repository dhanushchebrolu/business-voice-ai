# Controlled-test tenant: "Smile Dental 1": prerequisite checklist

Read-only review of production on 2026-11-27 (SELECT-only transactions; nothing modified, no number
assigned). Organization `ccb6543c-da78-47cf-b32f-7851ddc575ea`, client id `VAA-000004`. This is a
different organization from the live "Smile Dental" (`5669e43f-…`, VAA-000002, number ending 0061),
which must not be touched.

| Prerequisite                                  | Status                                                                        | Action (all manual, by you or an admin)                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Organization / owner                          | OK: 1 member                                                                  | none                                                                                                                  |
| Agent record linked to a business             | OK (`agent_configs` row with business)                                        | none                                                                                                                  |
| Sarvam agent registered                       | none (`sarvam_app_id` empty)                                                  | the operator-bridge test creates it                                                                                   |
| Business category                             | OK: `dental_clinic`                                                           | none                                                                                                                  |
| Services                                      | OK: 3 active                                                                  | none                                                                                                                  |
| FAQs                                          | OK: 2 active                                                                  | none                                                                                                                  |
| Opening hours                                 | OK: 7 rows                                                                    | none                                                                                                                  |
| Rules / capabilities                          | not reviewed beyond the above; the work order's checklist reports any blocker | open Provisioning → this customer; fix what it lists                                                                  |
| Voice and language settings                   | **MISSING** (no `agent_voice_language_settings` row)                          | customer or admin: Settings → Voice & language, choose voice + languages                                              |
| Phone number                                  | **MISSING** (zero numbers)                                                    | YOU assign a spare, unused number to this customer (manual; not bought here)                                          |
| Number safety                                 | cannot be verified until assigned                                             | the number must exist in Sarvam on the connection, not routed to any deployment, not used by Smile Dental 0061 / 0870 |
| Sarvam connection row                         | **MISSING** (`telephony_connections` provider sarvam = 0)                     | admin: Provisioning → register the customer's Sarvam connection (the shared connection id)                            |
| Number confirmed in Sarvam                    | **MISSING**                                                                   | admin: "confirm number exists in Sarvam" after checking the console                                                   |
| Integration credential                        | **MISSING** (0 active)                                                        | issued by the operator bridge (`issue_agent_credential`) or admin                                                     |
| Lifecycle / payment gate                      | `not_provisioned`; payment enforcement is OFF globally                        | the existing phone feature gate must pass for the customer's Activate click (admin override or lifecycle step)        |
| Existing agent / deployment / mapping at risk | none: no numbers, no deployment, no registered agent                          | none                                                                                                                  |

Also needed before the test, outside this tenant: migration `20261203090000` applied through its gate
scripts, the branch deployed, `SARVAM_MASTER_AGENT_APP_ID` set (see `sarvam-master-agent-setup.md`), and a
bridge token. Do not use the live Smile Dental number or agent for any step.
