/**
 * The two Sarvam agent roles every customer has (docs/dual-agent-provisioning-audit.md):
 *
 *   inbound   answers the customer's phone number through its deployment and
 *             gets the tools the customer's capabilities switch on
 *             (universal-agent-config.ts), including booking and callbacks.
 *   outbound  is dialled by ClickAI through instant outbound only. It may read
 *             business data, check availability, book a free slot for the
 *             person ClickAI dialled, and record the call's outcome (which
 *             carries opt-outs). It never arranges callbacks, sends messages or
 *             transfers the call.
 *
 * The outbound restriction is enforced in three places, so no single
 * misconfiguration opens it:
 *   1. the outbound template lists only OUTBOUND_AGENT_TOOLS (what the
 *      operator creates in Sarvam);
 *   2. ClickAI's agent API refuses every other endpoint for an
 *      outbound-role credential (roleAllowsAgentApi), whatever the agent sends;
 *   3. a booking on an outbound call is made only for a call ClickAI itself
 *      placed and that is still open, and only for the number ClickAI dialled
 *      (never the provider's unverified caller id); callbacks are refused for
 *      any request carrying an outbound ClickAI call id
 *      (sarvam-agent-api.server.ts).
 *
 * Pure, no imports: safe for the browser, the Worker and tests.
 */

export const AGENT_ROLES = ["inbound", "outbound"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export function isAgentRole(v: unknown): v is AgentRole {
  return v === "inbound" || v === "outbound";
}

/** Sarvam tools the outbound template carries; nothing else may be added to it. */
export const OUTBOUND_AGENT_TOOLS = [
  "clickai_business_context",
  "get_business_info",
  "check_availability",
  "book_appointment",
  // The person's own appointments, found by the number ClickAI dialled; each is on the
  // template only when the customer's capability for it is on.
  "list_appointments",
  "reschedule_appointment",
  "cancel_appointment",
  "record_call_outcome",
] as const;

/** Never on an outbound agent: they create callbacks, messages or hand the call over. */
export const OUTBOUND_FORBIDDEN_TOOLS = [
  "request_callback",
  "send_reminder",
  "call_transfer",
] as const;

/**
 * ClickAI agent-API endpoints a credential of this role may call.
 * `tool` undefined is the on-start context (POST /api/public/sarvam/agent/context).
 * Fails closed: an unknown role or endpoint is refused for outbound.
 */
export function roleAllowsAgentApi(role: AgentRole, tool: string | undefined): boolean {
  if (role === "inbound") return true;
  if (role !== "outbound") return false;
  return (
    tool === undefined ||
    tool === "get_business_info" ||
    tool === "check_availability" ||
    tool === "book_appointment" ||
    tool === "list_appointments" ||
    tool === "reschedule_appointment" ||
    tool === "cancel_appointment" ||
    tool === "record_call_outcome"
  );
}

/**
 * Hard maximum length of any outbound call, in seconds (decision D2, 2026-11-20).
 * Sarvam's instant-outbound API has no per-call duration override, so the call
 * itself is ended by the outbound agent's own "Max call length" setting; ClickAI
 * refuses to confirm an agent version for more than this, and every call's
 * billing cap and wallet reservation follow from the confirmed value.
 */
export const OUTBOUND_MAX_CALL_SECONDS_CAP = 300;

/**
 * Lengths of the per-call outbound agent variables (campaign_objective,
 * campaign_instructions) and of the business name in the opening line.
 */
export const OUTBOUND_TEXT_LIMITS = { objective: 300, instructions: 1500, businessName: 120 };

export const ROLE_LABEL: Record<AgentRole, string> = {
  inbound: "Inbound agent",
  outbound: "Outbound agent",
};
