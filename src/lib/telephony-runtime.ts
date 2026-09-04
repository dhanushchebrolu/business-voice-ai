/**
 * Runtime handoff boundary between Phase D (telephony) and Phase E (the
 * Sarvam AI voice agent runtime).
 *
 * When an inbound call reaches "answered"/"in_progress", Phase D's webhook
 * (src/routes/api/public/webhooks/telephony.ts) calls `routeToAgentRuntime`
 * exactly as documented when this file was still a stub: it has already
 * verified the call is authorized, resolved which organization/agent owns
 * it, and created the call_logs row. This function re-verifies the
 * authorization gate one more time (defense in depth — a lock applied
 * between the webhook's own check and this call must still block the paid
 * AI runtime from starting), resolves the published agent configuration,
 * and — only if the telephony provider exposes a live audio channel for
 * this call (`adapter.openMediaBridge`, see ./telephony/audio-bridge.ts) —
 * starts the real Sarvam-backed conversation via voice-runtime.server.ts.
 *
 * No provider in this repository implements `openMediaBridge` yet (see the
 * Phase E report's "Known limitations"), so in this environment this
 * function always returns `handled: false` for that reason — never a
 * fabricated success. Everything upstream of this call (the entitlement
 * gate, the call_logs row, the webhook's own control flow) is unchanged
 * from Phase D.
 */

import { checkTelephonyAccess } from "./telephony-guard.server";
import { getTelephonyAdapter } from "./telephony.server";

export interface AgentRuntimeHandoffInput {
  callId: string;
  organizationId: string;
  businessId: string | null;
  agentConfigId: string | null;
  phoneNumberId: string;
  vaaniE164: string;
  callerE164: string | null;
  direction: "inbound" | "outbound";
  provider: string;
  providerCallId: string | null;
}

export interface AgentRuntimeHandoffResult {
  handled: boolean;
  note: string;
}

async function resolveBusinessId(
  organizationId: string,
  businessId: string | null,
): Promise<string | null> {
  if (businessId) return businessId;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("businesses")
    .select("id")
    .eq("organization_id", organizationId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

export async function routeToAgentRuntime(
  input: AgentRuntimeHandoffInput,
): Promise<AgentRuntimeHandoffResult> {
  console.info("telephony:runtime_handoff", {
    callId: input.callId,
    organizationId: input.organizationId,
    direction: input.direction,
  });

  if (input.direction !== "inbound") {
    return { handled: false, note: "The voice runtime only handles inbound calls in this phase." };
  }

  try {
    // Defense in depth: re-derive the same gate the webhook already
    // checked, using the exact same function (never a second, drifting
    // authorization path). See telephony-guard.server.ts.
    const gate = await checkTelephonyAccess(input.organizationId, input.phoneNumberId, "inbound");
    if (!gate.allowed) {
      return { handled: false, note: gate.reason ?? "Telephony is not available for this call." };
    }

    if (!input.providerCallId) {
      return { handled: false, note: "No provider call reference available for this call." };
    }

    const adapter = getTelephonyAdapter(input.provider);
    if (!adapter) {
      return { handled: false, note: `${input.provider} is not connected.` };
    }
    const bridge = (await adapter.openMediaBridge?.(input.providerCallId)) ?? null;
    if (!bridge) {
      return {
        handled: false,
        note: `${input.provider} does not expose a live audio channel yet — the runtime cannot start without one. See PHASE_E_FINAL_REPORT.md "Known limitations".`,
      };
    }

    const businessId = await resolveBusinessId(input.organizationId, input.businessId);
    if (!businessId) {
      return { handled: false, note: "No business is configured for this workspace yet." };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: publishedVersion } = await supabaseAdmin
      .from("agent_versions")
      .select("version, snapshot, instructions")
      .eq("business_id", businessId)
      .eq("status", "active")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    let instructions: string;
    let agentSnapshotAgent: import("./agent-instructions").AgentSnapshot["agent"];
    let agentVersion: number | null;
    let businessName: string;

    if (publishedVersion) {
      const snapshot =
        publishedVersion.snapshot as unknown as import("./agent-instructions").AgentSnapshot;
      instructions = publishedVersion.instructions;
      agentSnapshotAgent = snapshot.agent;
      agentVersion = publishedVersion.version;
      businessName = snapshot.business.name;
    } else {
      // No published version yet — fall back to a live snapshot so an agent
      // mid-configuration can still be exercised, exactly like the existing
      // customer-facing test console (testAgentText) already does.
      const { loadSnapshot } = await import("./agent-service.server");
      const { buildAgentInstructions, validateAgentConfig } = await import("./agent-instructions");
      const snapshot = await loadSnapshot(supabaseAdmin, businessId);
      const issues = validateAgentConfig(snapshot);
      if (issues.length) {
        return {
          handled: false,
          note: `Agent configuration incomplete: ${issues.map((i) => i.field).join(", ")}.`,
        };
      }
      instructions = buildAgentInstructions(snapshot);
      agentSnapshotAgent = snapshot.agent;
      agentVersion = null;
      businessName = snapshot.business.name;
    }

    const { startRuntimeSession } = await import("./voice-runtime.server");
    const handle = await startRuntimeSession({
      callId: input.callId,
      organizationId: input.organizationId,
      businessId,
      agentConfigId: input.agentConfigId,
      agentVersion,
      instructions,
      snapshotAgent: agentSnapshotAgent,
      businessName,
      bridge,
    });

    return {
      handled: handle.state !== "ERROR",
      note:
        handle.state === "ERROR"
          ? "The voice runtime failed to start — see server logs for the specific STT/TTS connection error."
          : `Voice runtime started (runtime session ${handle.runtimeSessionId}).`,
    };
  } catch (err) {
    // Never let a runtime failure escape into the webhook's own control
    // flow — the call itself, and Phase D's billing/finalization, must
    // proceed regardless of what happened to the AI layer.
    console.error("telephony:runtime_handoff_failed", input.callId, (err as Error).message);
    return { handled: false, note: "An unexpected error occurred starting the voice runtime." };
  }
}
