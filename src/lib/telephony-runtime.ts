/**
 * Runtime handoff boundary between Phase D (telephony) and Phase E (the
 * Sarvam AI voice agent runtime — NOT implemented here).
 *
 * When an inbound call is answered on a Vaani number, Phase D's job stops at
 * this interface: it has verified the call is authorized, resolved which
 * organization/agent owns it, and created the call_logs row. What happens on
 * the audio itself (speech-to-text, the LLM conversation loop, text-to-speech,
 * barge-in) is Phase E's responsibility and is intentionally not implemented
 * in this module — see the Phase D report's "Known limitations" section.
 *
 * `routeToAgentRuntime` is the single call site the inbound webhook uses. It
 * never fabricates a successful AI interaction: today it only records that a
 * call reached this boundary, and returns `handled: false` so callers (and
 * the admin UI) never mistake "authorized and routed" for "the agent picked
 * up." Phase E replaces this function's body with the real runtime dispatch
 * without changing its signature or anything upstream of it.
 */

export interface AgentRuntimeHandoffInput {
  callId: string;
  organizationId: string;
  businessId: string | null;
  agentConfigId: string | null;
  phoneNumberId: string;
  vaaniE164: string;
  callerE164: string | null;
  direction: "inbound" | "outbound";
}

export interface AgentRuntimeHandoffResult {
  handled: boolean;
  note: string;
}

export async function routeToAgentRuntime(
  input: AgentRuntimeHandoffInput,
): Promise<AgentRuntimeHandoffResult> {
  console.info("telephony:runtime_handoff_pending_phase_e", {
    callId: input.callId,
    organizationId: input.organizationId,
    direction: input.direction,
  });
  return {
    handled: false,
    note: "Phase E (Sarvam AI voice runtime) is not implemented yet — this call was authorized and logged only.",
  };
}
