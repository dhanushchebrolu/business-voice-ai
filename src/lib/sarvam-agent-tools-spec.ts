/**
 * What a customer's Sarvam agent needs after it is cloned from the ClickAI
 * master: Sarvam clones copy an agent's config (prompt, variables, intro,
 * voice, languages) but NOT its tools, so the six ClickAI tools are created
 * again on every customer agent, from the definitions below.
 *
 * The definitions are the ones stored on the committed master (agent
 * ClickAI-Mas-002f42d7-604f, version 2), in the exact shape Sarvam's
 * configure_app_tool accepts: typed system_variable bindings for the call's
 * Interaction ID and caller (User Identifier), per-tool timeouts, failure
 * messages and reply templates. They deliberately carry NO authentication:
 * this MCP refuses auth on tools, so the credential is selected in the Sarvam
 * console (an explicit provisioning checkpoint, see operator-bridge.server.ts).
 * No customer data, no secrets, nothing copied from any customer's agent.
 *
 * Pure module: no I/O and no @/ imports.
 */

/** The master the customers are cloned from: always a COMMITTED version, never the draft. */
export const DEFAULT_MASTER_AGENT_APP_ID = "ClickAI-Mas-002f42d7-604f";
export const DEFAULT_MASTER_AGENT_VERSION = 2;

export const CLICKAI_TOOL_NAMES = [
  "clickai_business_context",
  "get_business_info",
  "check_availability",
  "book_appointment",
  "request_callback",
  "record_call_outcome",
] as const;
export type ClickAiToolName = (typeof CLICKAI_TOOL_NAMES)[number];

export type ToolType = "webhook" | "webhook_on_start" | "webhook_on_end";

const INTERACTION = {
  name: "interaction_id",
  type: "system_variable",
  value: { variable_name: "interaction_id" },
} as const;
const CALLER = (name: string) =>
  ({ name, type: "system_variable", value: { variable_name: "user_identifier" } }) as const;
const AGENT_VAR = (name: string, variable: string) =>
  ({ name, type: "agent_variable", value: { variable_name: variable } }) as const;
const LLM = (name: string, description: string, required: boolean) =>
  ({
    enum: [] as string[],
    name,
    type: "llm_prompt",
    required,
    param_type: "Text",
    description,
    isInputProperty: true,
  }) as const;
const REQUIRE_SERVICE = {
  name: "require_service",
  type: "static",
  value: "true",
  vtype: "Boolean",
} as const;

const CONTEXT_VARIABLES = [
  "context_status",
  "missing",
  "guidance",
  "business_name",
  "greeting",
  "business_type",
  "business_description",
  "business_address",
  "business_phone",
  "business_email",
  "business_website",
  "business_timezone",
  "business_date",
  "business_time",
  "hours_today",
  "opening_hours",
  "services_and_prices",
  "staff",
  "faqs",
  "policies",
  "knowledge",
] as const;
const save = (names: readonly string[]) =>
  names.map((n) => ({ response_path: n, variable_name: n }));

const SERVICE_LIST =
  "{% for s in result.error.options %}{{ s }}{% if not loop.last %}, {% endif %}{% endfor %}";

const CHECK_AVAILABILITY_TEMPLATE =
  "{% if ok and result.success %}{% if requested_time %}{% if requested_time.available %}{{ requested_time.time }} IS FREE. {% else %}{{ requested_time.time }} IS NOT FREE.{% if requested_time.alternatives %} Nearest open times: {% for s in requested_time.alternatives %}{{ s }}{% if not loop.last %}, {% endif %}{% endfor %}.{% endif %} Tell them that time is not free and offer the nearest times. {% endif %}{% endif %}{% if result.data.slots %}All open {{ duration_minutes }}-minute start times on that date{% if service %} for {{ service.name }}{% endif %} (local time, {{ timezone }}): {% for s in result.data.slots %}{{ s.start_local }}{% if not loop.last %}, {% endif %}{% endfor %}. Offer only these exact times. To book, send the chosen time exactly as shown (HH:mm).{% else %}There are no open slots on that date. Do not offer any time on that date; ask whether another date suits them.{% endif %}" +
  `{% elif result and result.error and result.error.code == "SERVICE_NOT_OFFERED" %}SERVICE NOT OFFERED: "{{ result.error.requested }}" is not a service of this business. Do not check times or book it. Say politely that it is not offered and name the services that are: ${SERVICE_LIST}. Never pick a different service for them.` +
  `{% elif result and result.error and result.error.code == "SERVICE_AMBIGUOUS" %}SERVICE UNCLEAR: "{{ result.error.requested }}" matches more than one service. Ask which one they want: ${SERVICE_LIST}.` +
  `{% elif result and result.error and result.error.code == "SERVICE_REQUIRED" %}SERVICE NEEDED: ask which service they want: ${SERVICE_LIST}.` +
  "{% else %}Availability could not be checked right now. Do not offer or guess any time. Say so, and offer to have the team call them back (request_callback).{% endif %}";

const BOOK_APPOINTMENT_TEMPLATE =
  '{% if ok and result.success and result.bookingOutcome == "confirmed" %}CONFIRMED: ClickAI has booked {% if service %}{{ service.name }} {% endif %}for the date and time you sent. Tell them it is booked, with the day, date and time.' +
  '{% elif ok and result.success and result.bookingOutcome == "saved_calendar_sync_failed" %}SAVED, NOT CONFIRMED: ClickAI saved the request but the appointment is not confirmed. Say exactly that: the business has the request and will confirm it. Do not say it is booked.' +
  "{% elif ok and result.success %}PENDING, NOT CONFIRMED: the booking is not confirmed yet. Say it is not confirmed yet; do not say it is booked." +
  '{% elif result and result.error and result.error.code == "SLOT_NO_LONGER_AVAILABLE" %}NOT BOOKED: that time was just taken. Do not say it is booked. Call check_availability again for that date and offer only times it returns.' +
  '{% elif result and result.error and result.error.code == "SLOT_OUTSIDE_SCHEDULE" %}NOT BOOKED: that time is outside the schedule. Offer only times check_availability returns.' +
  `{% elif result and result.error and result.error.code == "SERVICE_NOT_OFFERED" %}SERVICE NOT OFFERED: "{{ result.error.requested }}" is not a service of this business. Do not check times or book it. Say politely that it is not offered and name the services that are: ${SERVICE_LIST}. Never pick a different service for them.` +
  `{% elif result and result.error and result.error.code == "SERVICE_AMBIGUOUS" %}SERVICE UNCLEAR: "{{ result.error.requested }}" matches more than one service. Ask which one they want: ${SERVICE_LIST}.` +
  `{% elif result and result.error and result.error.code == "SERVICE_REQUIRED" %}SERVICE NEEDED: ask which service they want: ${SERVICE_LIST}.` +
  '{% elif result and result.error and result.error.code == "CUSTOMER_NAME_REQUIRED" %}NOT BOOKED YET: their name is needed. Ask for their name, then book again.' +
  '{% elif result and result.error and result.error.code == "TEST_CALL_NOT_SAVED" %}NOT BOOKED (test call): {{ result.error.message }}. Say this was a test and nothing was booked.' +
  "{% else %}NOT BOOKED{% if result and result.error and result.error.message %} ({{ result.error.message }}){% endif %}. Nothing was booked and nothing was saved. Say the appointment could not be booked. Do not say it is booked, saved or that anyone will call. Offer to have the team call them back; only if they agree, use request_callback.{% endif %}";

const SERVICE_NAME_DESCRIPTION =
  "The service exactly as it is named in services_and_prices. Translate the caller's words in any language to that configured name. Leave empty if the caller has not chosen a service; never invent or substitute one.";

/** Which customer capability switches a tool on (the tool is still created, then disabled when off). */
export type ToolEnabledBy = "always" | "booking" | "callback";

export interface ToolDefinition {
  name: ClickAiToolName;
  /** configure_app_tool.tool_type */
  toolType: ToolType;
  lifecycle: "on_start" | "run" | "on_end";
  enabledBy: ToolEnabledBy;
  description: string;
  /** configure_app_tool.connector_config: no `auth` key, on purpose. */
  connectorConfig: Record<string, unknown>;
}

export function clickAiToolDefinitions(baseUrl: string): ToolDefinition[] {
  const root = `${baseUrl.replace(/\/+$/, "")}/api/public/sarvam/agent`;
  return [
    {
      name: "clickai_business_context",
      toolType: "webhook_on_start",
      lifecycle: "on_start",
      enabledBy: "always",
      description:
        "Loads the business's latest profile, opening hours, services, prices, staff and FAQs from ClickAI before the agent speaks.",
      connectorConfig: {
        url: `${root}/context`,
        method: "POST",
        lifecycle: "on_start",
        body: [INTERACTION, CALLER("caller_number")],
        timeout_seconds: 10,
        save_to_variables: save(CONTEXT_VARIABLES),
      },
    },
    {
      name: "get_business_info",
      toolType: "webhook",
      lifecycle: "run",
      enabledBy: "always",
      description:
        "Re-reads this business's latest information from ClickAI during the call: opening hours, services and prices, staff, address, FAQs and policies. Use it whenever the caller asks about these and the answer is not already known.",
      connectorConfig: {
        url: `${root}/tools/get_business_info`,
        method: "POST",
        lifecycle: "run",
        body: [INTERACTION],
        on_failure:
          "I'm not able to check that right now. I'll have the team confirm and call you back.",
        timeout_seconds: 10,
        resp_template:
          "ClickAI business information. Status: {{context_status}}. {{guidance}} Not configured: {{missing}}. Hours today: {{hours_today}}. Opening hours: {{opening_hours}}. Services and prices: {{services_and_prices}}. Staff: {{staff}}. Address: {{business_address}}. Phone: {{business_phone}}. FAQs: {{faqs}}. Policies: {{policies}}.",
        save_to_variables: save(CONTEXT_VARIABLES.filter((v) => v !== "greeting")),
      },
    },
    {
      name: "check_availability",
      toolType: "webhook",
      lifecycle: "run",
      enabledBy: "booking",
      description:
        "Checks real appointment availability in ClickAI for one configured service. Send the caller's preferred time when they gave one; the reply says whether it is free. Never offer a time this did not return.",
      connectorConfig: {
        url: `${root}/tools/check_availability`,
        method: "POST",
        lifecycle: "run",
        body: [
          INTERACTION,
          LLM(
            "date",
            "The appointment date the caller wants, exactly in YYYY-MM-DD format. Resolve words like today or tomorrow using business_date. Never guess a date the caller did not ask for.",
            true,
          ),
          LLM("service_name", SERVICE_NAME_DESCRIPTION, false),
          LLM(
            "time",
            "The time the caller asked for, as 24-hour HH:mm in the business's local time. Leave empty if they gave no time.",
            false,
          ),
          REQUIRE_SERVICE,
        ],
        on_failure: "I can't check availability right now, so I won't suggest a time.",
        timeout_seconds: 10,
        resp_template: CHECK_AVAILABILITY_TEMPLATE,
      },
    },
    {
      name: "book_appointment",
      toolType: "webhook",
      lifecycle: "run",
      enabledBy: "booking",
      description:
        "Books the appointment in ClickAI. Call it only after the caller confirmed the service, date and a time check_availability returned. Only say the appointment is booked when this tool replies CONFIRMED.",
      connectorConfig: {
        url: `${root}/tools/book_appointment`,
        method: "POST",
        lifecycle: "run",
        body: [
          INTERACTION,
          LLM(
            "date",
            "The appointment date the caller confirmed, exactly in YYYY-MM-DD format. Use the same date you passed to check_availability.",
            true,
          ),
          LLM(
            "time",
            "The start time the caller chose, exactly as check_availability returned it: 24-hour HH:mm in the business's local time. Never send a time that check_availability did not return.",
            true,
          ),
          LLM("service_name", SERVICE_NAME_DESCRIPTION, false),
          LLM(
            "customer_name",
            "The caller's name exactly as they said it. Leave empty if they did not give a name; never invent one.",
            false,
          ),
          CALLER("customer_phone"),
          REQUIRE_SERVICE,
          AGENT_VAR("clickai_call_id", "clickai_call_id"),
        ],
        on_failure: "I couldn't complete the booking just now, so it is not booked.",
        timeout_seconds: 20,
        resp_template: BOOK_APPOINTMENT_TEMPLATE,
      },
    },
    {
      name: "request_callback",
      toolType: "webhook",
      lifecycle: "run",
      enabledBy: "callback",
      description:
        "Saves a callback request for the business team in ClickAI. Use it only after the caller agreed to be called back. Only promise a callback when it replies RECORDED.",
      connectorConfig: {
        url: `${root}/tools/request_callback`,
        method: "POST",
        lifecycle: "run",
        body: [
          INTERACTION,
          CALLER("caller_number"),
          LLM(
            "customer_name",
            "The caller's name exactly as they said it; empty if not given.",
            false,
          ),
          LLM("reason", "In a few English words, what the team should call back about.", true),
          AGENT_VAR("clickai_call_id", "clickai_call_id"),
        ],
        on_failure: "I couldn't record the callback request just now.",
        timeout_seconds: 10,
        resp_template:
          "{% if ok and recorded %}RECORDED: the callback request is saved. You may tell the caller the team will call them back (no time promised).{% else %}NOT RECORDED: the callback request could not be saved. Do not say anyone will call. Apologise and give the business phone number from the business facts so they can call.{% endif %}",
      },
    },
    {
      name: "record_call_outcome",
      toolType: "webhook_on_end",
      lifecycle: "on_end",
      enabledBy: "always",
      description:
        "Records the call's outcome in ClickAI when the call ends (once per call) and saves a lead when the caller left details. Never saves a lead for a caller who opted out.",
      connectorConfig: {
        url: `${root}/tools/record_call_outcome`,
        method: "POST",
        lifecycle: "on_end",
        body: [
          INTERACTION,
          CALLER("caller_number"),
          AGENT_VAR("outcome", "call_outcome"),
          AGENT_VAR("summary", "call_summary"),
          AGENT_VAR("customer_name", "customer_name"),
          AGENT_VAR("interest", "caller_interest"),
          AGENT_VAR("requested_slot", "requested_slot"),
          AGENT_VAR("opted_out", "opted_out"),
        ],
        timeout_seconds: 10,
      },
    },
  ];
}

/**
 * Sarvam's prompt validator refuses lines that tell the agent to choose its reply
 * language (the platform's language identification does that). These are the six
 * bullets of the ClickAI prompt's Language section it rejected; the master was
 * built without them and every customer prompt must be too.
 */
const REJECTED_LANGUAGE_BULLETS = [
  /^- Reply in the language the person is speaking.*\n/m,
  /^- If they change language, change with them.*\n/m,
  /^- If they mix languages.*\n/m,
  /^- Stay in their language for follow-up.*\n/m,
  /^- If you did not understand them, ask them to repeat.*\n/m,
  /^- The opening line is fixed; after.*\n/m,
];

export function sarvamSafePrompt(prompt: string): { text: string; removed: number } {
  let text = prompt;
  let removed = 0;
  for (const re of REJECTED_LANGUAGE_BULLETS)
    if (re.test(text)) {
      text = text.replace(re, "");
      removed++;
    }
  return { text, removed };
}
