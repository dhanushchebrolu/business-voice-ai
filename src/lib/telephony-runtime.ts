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
 * Exotel implements `openMediaBridge` (see ./telephony/exotel-provider.ts
 * and exotel-media-bridge.server.ts) — this stopped being true after the
 * Exotel media-stream work landed; a provider without that method (or one
 * whose `openMediaBridge` genuinely can't produce a bridge for this call,
 * e.g. no live connection arrived in time) still degrades to `handled:
 * false` here, never a fabricated success. Everything upstream of this
 * call (the entitlement gate, the call_logs row, the webhook's own control
 * flow) is unchanged from Phase D. This function itself never references
 * Exotel or any other provider by name — see voice-runtime.server.ts's own
 * module doc for the provider-neutrality boundary this preserves.
 */

import { checkTelephonyAccess, maskPhoneNumber } from "./telephony-guard.server";
import { getTelephonyAdapter } from "./telephony.server";
import { getCallSessionStub } from "./telephony/cloudflare-env.server";
import type {
  StartRuntimeRpcInput,
  AgentRuntimeRpcResult,
} from "./telephony/call-session-durable-object.server";

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
    calledNumber: maskPhoneNumber(input.vaaniE164),
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

    const businessId = await resolveBusinessId(input.organizationId, input.businessId);
    // Diagnostic: call_id + which stage resolved/failed — never the
    // organization/business id itself, only whether one was found.
    console.info("telephony:runtime_stage", {
      callId: input.callId,
      provider_call_id: input.providerCallId,
      stage: "business_resolution",
      resolved: Boolean(businessId),
    });
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
    // Diagnostic: agent config resolved (published version or a valid live
    // snapshot) vs. this branch never being reached (both "incomplete
    // config" returns above happen before this line). Never the agent name
    // or instructions text.
    console.info("telephony:runtime_stage", {
      callId: input.callId,
      provider_call_id: input.providerCallId,
      stage: "agent_resolution",
      resolved: true,
      source: publishedVersion ? "published_version" : "live_snapshot",
      agentVersion,
    });

    const rpcInput: StartRuntimeRpcInput = {
      callId: input.callId,
      organizationId: input.organizationId,
      businessId,
      agentConfigId: input.agentConfigId,
      agentVersion,
      instructions,
      snapshotAgent: agentSnapshotAgent,
      businessName,
      providerCallId: input.providerCallId,
    };

    // Production path: the Exotel media bridge and the Sarvam voice runtime
    // both live inside the CallSessionDurableObject now (see E1 in the
    // production audit — a plain Worker cannot durably hold either across
    // the two independent requests involved: this webhook, and Exotel's own
    // WebSocket connect). When the CALL_SESSION binding isn't configured
    // (local dev, tests), fall back to the exact pre-existing in-process
    // behavior below — correct there because everything runs in one process.
    const doStub = getCallSessionStub();
    if (doStub) {
      const response = await doStub.fetch("https://call-session/internal/start-runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpcInput),
      });
      if (!response.ok) {
        console.error("telephony:runtime_do_rpc_failed", input.callId, response.status);
        return { handled: false, note: "The voice runtime coordinator returned an error." };
      }
      const result = (await response.json()) as AgentRuntimeRpcResult;
      // Diagnostic: this is the closest real signal to "was a live Exotel
      // media session established" — the Durable Object's own
      // handleStartRuntime (call-session-durable-object.server.ts) only
      // returns handled:true after it has actually found/waited for the
      // Exotel WebSocket media bridge AND started the Sarvam runtime on
      // it. There is no separate "generate a media WebSocket URL" step in
      // this codebase — Exotel's Voicebot Applet URL is static, configured
      // once in Exotel's own dashboard, never generated per-call.
      console.info("telephony:runtime_stage", {
        callId: input.callId,
        provider_call_id: input.providerCallId,
        stage: "media_and_runtime_handoff",
        resolved: result.handled,
      });
      return result;
    }

    const bridge = (await adapter.openMediaBridge?.(input.providerCallId)) ?? null;
    console.info("telephony:runtime_stage", {
      callId: input.callId,
      provider_call_id: input.providerCallId,
      stage: "media_bridge_open",
      resolved: Boolean(bridge),
    });
    if (!bridge) {
      return {
        handled: false,
        note: `${input.provider} does not expose a live audio channel yet — the runtime cannot start without one. See PHASE_E_FINAL_REPORT.md "Known limitations".`,
      };
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
      handled: handle.state !== "failed",
      note:
        handle.state === "failed"
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

/**
 * Ends the voice runtime for a call, if one is running. Used by the
 * telephony webhook whenever a call reaches a terminal status.
 *
 * Routes through the same CallSessionDurableObject as routeToAgentRuntime
 * when available (production) so termination always reaches the correct
 * session regardless of which Worker isolate this webhook request landed
 * on — the exact cross-isolate gap identified as E1 in the production
 * audit (a session started by one request could previously be silently
 * unreachable from a later, separate request's termination call). Falls
 * back to calling voice-runtime.server.ts directly when no CALL_SESSION
 * binding is configured (local dev, tests) — correct there because
 * everything runs in one process.
 */
export async function terminateAgentRuntime(callId: string, reason: string): Promise<void> {
  const doStub = getCallSessionStub();
  if (doStub) {
    try {
      const response = await doStub.fetch("https://call-session/internal/terminate-runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId, reason }),
      });
      if (!response.ok) {
        console.error("telephony:terminate_do_rpc_failed", callId, response.status);
      }
    } catch (err) {
      console.error("telephony:terminate_do_rpc_error", callId, (err as Error).message);
    }
    return;
  }

  const { terminateRuntimeSession } = await import("./voice-runtime.server");
  await terminateRuntimeSession(callId, reason);
}
