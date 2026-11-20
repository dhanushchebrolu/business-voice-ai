/**
 * The two Sarvam agent roles every customer has (docs/dual-agent-provisioning-audit.md):
 *
 *   inbound   answers the customer's phone number through its deployment and
 *             gets the tools the customer's capabilities switch on
 *             (universal-agent-config.ts), including booking and callbacks.
 *   outbound  is dialled by ClickAI through instant outbound only. It may read
 *             business data, check availability and record the call's outcome
 *             (which carries opt-outs). It may never create anything.
 *
 * The outbound restriction is enforced in three places, so no single
 * misconfiguration opens it:
 *   1. the outbound template lists only OUTBOUND_AGENT_TOOLS (what the
 *      operator creates in Sarvam);
 *   2. ClickAI's agent API refuses every other endpoint for an
 *      outbound-role credential (roleAllowsAgentApi), whatever the agent sends;
 *   3. booking and callbacks are also refused for any request that carries an
 *      outbound ClickAI call id (sarvam-agent-api.server.ts).
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
  "record_call_outcome",
] as const;

/** Never on an outbound agent: they create bookings, callbacks, messages or hand the call over. */
export const OUTBOUND_FORBIDDEN_TOOLS = [
  "book_appointment",
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
    tool === "record_call_outcome"
  );
}

export const ROLE_LABEL: Record<AgentRole, string> = {
  inbound: "Inbound agent",
  outbound: "Outbound agent",
};
