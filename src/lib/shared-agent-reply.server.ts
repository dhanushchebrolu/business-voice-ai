/**
 * The ONE shared entry point for "give the business's AI agent a
 * conversation and get back a reply" outside the voice runtime — built in
 * Phase 5 specifically so Instagram does NOT get its own AI brain (spec
 * PART 11, verbatim: "Do NOT create instagramGenerateReply()/
 * whatsappGenerateReply()/voiceGenerateReply() as separate AI brains").
 *
 * This function is channel-agnostic by construction: it takes only
 * server-trusted identity (organizationId/businessId/agentConfigId) plus
 * a plain conversation history, and returns plain text. It reuses, byte-
 * for-byte, the exact same building blocks voice-runtime.server.ts's
 * `getReply` already uses for phone calls:
 *   - agent-service.server.ts's loadSnapshot + agent-instructions.ts's
 *     buildAgentInstructions for the system prompt (business hours,
 *     services, FAQs, rules, knowledge base — identical grounding data,
 *     no channel-specific copy of any of it)
 *   - ai-tools.server.ts's resolveAvailableTools/executeAiTool for the
 *     default-deny capability-gated tool registry (identical tools,
 *     identical default-deny check — Instagram gains no tool permission a
 *     WhatsApp or voice conversation wouldn't also have for the same
 *     agent_configs row)
 *   - claude.server.ts's runConversationWithTools/runConversation for the
 *     actual model call and single-round tool-execution loop
 *
 * SECURITY BOUNDARY (unchanged from ai-tools.server.ts's own rule,
 * restated here because this is the new call site): `ctx.organizationId`/
 * `ctx.businessId`/`ctx.agentConfigId` must always come from server-
 * resolved state (a webhook payload already matched to a connection row,
 * or an authenticated session) — never from the model, never from
 * anything a channel's own webhook payload claims about tenant identity.
 * Callers (instagram-inbound.server.ts, instagram-automation.server.ts)
 * resolve these from instagram_connections rows, exactly like voice
 * resolves them from the call's own already-validated context.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { ChatMessage } from "./sarvam.server.ts";

type Client = SupabaseClient<Database>;

export interface SharedAgentReplyContext {
  organizationId: string;
  businessId: string;
  agentConfigId: string | null;
  /** Threaded through to tools exactly like voice's callId — e.g. so a payment tool can be traced back to the originating conversation. Optional; channels without a call concept simply omit it. */
  callId?: string | undefined;
  source: "voice" | "whatsapp" | "website" | "manual" | "instagram";
}

export interface SharedAgentReplyResult {
  reply: string;
  toolCalls: { name: string; input: Record<string, unknown>; isError: boolean }[];
}

/**
 * `history` is the conversation so far, oldest first, roles "user"/
 * "assistant" only (no system message — this function builds and injects
 * that itself from the business's own agent config, the same as voice
 * does). Callers should cap history length themselves for very long
 * threads (voice caps at the last 20 turns — instagram-inbound.server.ts
 * follows the same convention).
 */
export async function generateSharedAgentReply(
  supabaseAdmin: Client,
  ctx: SharedAgentReplyContext,
  history: ChatMessage[],
): Promise<SharedAgentReplyResult> {
  const { loadSnapshot } = await import("./agent-service.server.ts");
  const { buildAgentInstructions } = await import("./agent-instructions.ts");
  const { resolveAvailableTools, executeAiTool } = await import("./ai-tools.server.ts");
  const { claude } = await import("./claude.server.ts");

  const snapshot = await loadSnapshot(supabaseAdmin, ctx.businessId);
  const systemPrompt = buildAgentInstructions(snapshot);
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...history];

  const tools = await resolveAvailableTools(supabaseAdmin, ctx.organizationId, ctx.businessId);
  if (tools.length === 0) {
    const { reply } = await claude.runConversation(messages);
    return { reply, toolCalls: [] };
  }

  const toolCtx = {
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    agentConfigId: ctx.agentConfigId,
    callId: ctx.callId,
    source: ctx.source,
  };
  const result = await claude.runConversationWithTools(messages, tools, (name, input) =>
    executeAiTool(supabaseAdmin, toolCtx, name, input),
  );
  return { reply: result.reply, toolCalls: result.toolCalls };
}
