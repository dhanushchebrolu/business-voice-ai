# Inbound and outbound agents: what each can do, and what is left to do by hand

Status: 2026-11-25. Written from the code at the time and one production test call
(call `16239c47`, 2026-11-24 19:01 IST). "Verified" means read in the code or in production
data; "unverified" means it depends on how the agent was built inside Sarvam, which ClickAI
cannot read.

## The constraint that shapes everything

Sarvam agents are authored in Sarvam's dashboard. Sarvam has no public API to read or write
an agent's prompt, tools, languages or voice (`sarvam-capabilities.ts`: "NOT DOCUMENTED — DO
NOT IMPLEMENT"; `inspectSarvamAgent` can only confirm an app exists and has had calls).
ClickAI controls four things:

1. the prompt and tool declarations it GENERATES for an operator to build from
   (`sarvamToolConfiguration`, one shared prompt core, `sarvam-agent-prompt.ts`);
2. what its own backend ALLOWS each credential to do (`agent-roles.ts`, the agent API);
3. what it sends at call start (`agent_variables`, `app_overrides.initial_bot_message`);
4. what it does with the result (webhooks, finalization, campaigns, reports).

So "the agent ignores a capability" always means either (1) the operator built the agent
from an older or different template, or (2) ClickAI's backend refused. Fixing it needs the
template to be right AND the operator to apply it in Sarvam.

## Side by side

| Area                                                       | Inbound agent                                                | Outbound agent                                                              | Parity                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------ |
| Prompt                                                     | shared core, `role: inbound`                                 | same core, `role: outbound` (persona, opening, conversation steps differ)   | Shared, no drift: one builder              |
| Language following                                         | `LANGUAGE` section (new)                                     | same section (new)                                                          | Same                                       |
| Language list and auto-switching                           | Sarvam agent setting, from the saved voice-language settings | same saved settings, in `buildOutboundAgentConfig`                          | Same source; **applied by hand in Sarvam** |
| Opening line                                               | per-language greeting (`customGreetingFor`)                  | one English line set per call (`outboundOpeningLine`)                       | **Gap**: outbound opening is English       |
| Business facts, FAQs, services, hours                      | read live at call start                                      | same hook (`clickai_business_context`, `get_business_info`)                 | Same                                       |
| Check availability                                         | yes                                                          | yes                                                                         | Same                                       |
| Book an appointment                                        | yes, for the caller id                                       | yes, only for the number ClickAI dialled, on its own open call              | Same engine; outbound identity is stronger |
| Look up own appointments                                   | no                                                           | yes (`list_appointments`, new)                                              | Outbound ahead                             |
| Reschedule                                                 | no tool on the Sarvam path                                   | yes (`reschedule_appointment`, new)                                         | Outbound ahead                             |
| Cancel                                                     | no tool on the Sarvam path                                   | yes, after the person confirms (`cancel_appointment`, new)                  | Outbound ahead                             |
| Lead capture, callback request                             | yes (`request_callback`)                                     | **no, by design**: callbacks are saved from the call result                 | Intentional difference                     |
| Message taking                                             | yes                                                          | no, by design                                                               | Intentional                                |
| Call transfer, human escalation                            | yes (`call_transfer`)                                        | no, by design (`callTransfer: false`)                                       | Intentional                                |
| Calendar integration                                       | shared booking engine                                        | same engine                                                                 | Same                                       |
| Customer capability switches                               | from the agent's saved capabilities                          | same snapshot; tools appear only when the switch is on                      | Same rule                                  |
| Voice                                                      | saved voice and pace                                         | same                                                                        | Same                                       |
| Outcome persistence                                        | `record_call_outcome` on end                                 | same, plus `opted_out`, `wrong_number`, `interest_level`, `outbound_result` | Outbound adds fields                       |
| Calling hours, opt-outs, wallet, shared call slots, budget | n/a                                                          | enforced by ClickAI before and during dialling                              | Outbound only                              |

Reschedule and cancel are not on the inbound Sarvam agent because a caller's number is the
provider's unverified caller id; moving or cancelling someone's booking on that alone is not
safe. The outbound agent can, because ClickAI itself chose the number it dialled.

## Booking from outbound calls: what was wrong

Evidence from production (read-only):

- Smile Dental's capabilities have booking, rescheduling, cancelling and the calendar on, and
  a Google Calendar is connected. ClickAI's side allows outbound booking.
- On the 2026-11-24 test call the agent called `context`, then `check_availability` twice,
  then `call_outcome`. It never called `book_appointment`. It told the person "To book it,
  please call the clinic... The time is not held until you do", which is word for word the
  prompt's availability-only text.
- The registered outbound agent is Sarvam app `Smile-Denta-a17cec18-1c23` v2. The code's
  template was at v6 and is now v7.

Conclusion: the agent in Sarvam was built without the booking tool (or from a template
that had it off). That is a configuration of the Sarvam agent, not a fault in ClickAI's
booking engine. What is now in the code: the three appointment tools on the outbound
template, a prompt that matches the tools it has, and the engine honouring the dashboard
toggles (an agent saved before the backend permission keys existed, such as Smile Dental's,
was refused by the engine although its toggles are on).

## What must be done by hand in Sarvam (cannot be automated)

For each customer with an outbound agent, an operator:

1. opens the customer's Admin page, Outbound agent panel, and copies the current outbound
   template (template v7: system prompt, tools, variables, call settings);
2. updates the agent in Sarvam's dashboard to match, including the three appointment tools
   when the customer's capabilities allow them, and the language list with automatic
   switching on (Voice and language panel);
3. saves it as a new version, registers that version in ClickAI, and confirms it for outbound.

Until this is done for a customer, their live outbound agent behaves as it was built.

## Not verified

- That the Sarvam agent, once rebuilt, follows the language rule in Telugu, Hindi and mixed
  speech. The model's choice is made inside Sarvam; the prompt instruction is tested, the
  behaviour needs one supervised call in each language.
- That outbound calls reach `context` before the person speaks (the live-call counter and
  the shared call slots both assume an outbound call's first `context` request marks the
  answer; it did on the test call).
