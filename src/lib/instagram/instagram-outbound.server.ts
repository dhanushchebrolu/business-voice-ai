/**
 * Outbound Instagram sends — direct messages and comment replies — plus
 * the "generate an AI reply and send it" orchestration for a regular
 * inbound DM. Deliberately separate from instagram-inbound.server.ts
 * (parsing/persistence) and instagram-automation.server.ts (comment
 * trigger matching): this file's only job is "given a connection + what
 * to send, call Meta and record the outcome."
 *
 * Every outbound message this file sends is persisted to
 * instagram_messages with direction='outbound' BEFORE/immediately after
 * the send — this is also the bot-loop-protection ledger
 * instagram-inbound.server.ts's is_echo/self-sender check relies on
 * (see that file's module doc): a message this codebase itself sent is
 * always the connection's own instagram_business_account_id as sender
 * from Meta's perspective, so the primary guard (sender id == our own
 * account id) already covers it independent of this file.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { MetaInstagramClient, MetaApiError } from "./meta-instagram-client.server.ts";
import { decryptCredential } from "./instagram-token-crypto.server.ts";
import { resolveInstagramConfig } from "./instagram-config.server.ts";
import { generateSharedAgentReply } from "../shared-agent-reply.server.ts";
import type { ChatMessage } from "../sarvam.server.ts";

type Client = SupabaseClient<Database>;

export class InstagramOutboundError extends Error {
  code: "NOT_CONFIGURED" | "NOT_CONNECTED" | "SEND_FAILED";
  constructor(message: string, code: InstagramOutboundError["code"]) {
    super(message);
    this.code = code;
  }
}

interface ConnectionCredentials {
  id: string;
  organizationId: string;
  instagramBusinessAccountId: string;
  accessToken: string;
}

async function loadConnectionCredentials(
  supabaseAdmin: Client,
  connectionId: string,
): Promise<ConnectionCredentials> {
  const { data: connection, error } = await supabaseAdmin
    .from("instagram_connections")
    .select("id, organization_id, instagram_business_account_id, status, access_token_ciphertext")
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw error;
  if (!connection || connection.status === "disconnected" || !connection.access_token_ciphertext) {
    throw new InstagramOutboundError("This Instagram connection is not active.", "NOT_CONNECTED");
  }
  return {
    id: connection.id,
    organizationId: connection.organization_id,
    instagramBusinessAccountId: connection.instagram_business_account_id,
    accessToken: decryptCredential(connection.access_token_ciphertext),
  };
}

function buildClient(fetchImpl?: typeof fetch): MetaInstagramClient {
  const config = resolveInstagramConfig();
  if (!config) {
    throw new InstagramOutboundError(
      "Instagram is not configured on this deployment.",
      "NOT_CONFIGURED",
    );
  }
  return new MetaInstagramClient({
    appId: config.appId,
    appSecret: config.appSecret,
    graphApiVersion: config.graphApiVersion,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/** Sends a direct message and persists the outbound row. */
export async function sendInstagramDirectMessage(
  supabaseAdmin: Client,
  input: { connectionId: string; conversationId: string; recipientIgsid: string; text: string },
  fetchImpl?: typeof fetch,
): Promise<{ messageId: string }> {
  const creds = await loadConnectionCredentials(supabaseAdmin, input.connectionId);
  const client = buildClient(fetchImpl);

  let messageId: string;
  try {
    ({ messageId } = await client.sendDirectMessage(
      creds.instagramBusinessAccountId,
      input.recipientIgsid,
      input.text,
      creds.accessToken,
    ));
  } catch (err) {
    const message = err instanceof MetaApiError ? err.message : "Failed to send Instagram message.";
    await supabaseAdmin.from("instagram_messages").insert({
      organization_id: creds.organizationId,
      instagram_connection_id: creds.id,
      conversation_id: input.conversationId,
      direction: "outbound",
      message_type: "text",
      content: input.text,
      status: "failed",
      error_message: message,
      occurred_at: new Date().toISOString(),
    });
    throw new InstagramOutboundError(message, "SEND_FAILED");
  }

  await supabaseAdmin.from("instagram_messages").insert({
    organization_id: creds.organizationId,
    instagram_connection_id: creds.id,
    conversation_id: input.conversationId,
    ig_message_id: messageId,
    direction: "outbound",
    message_type: "text",
    content: input.text,
    status: "sent",
    occurred_at: new Date().toISOString(),
  });
  await supabaseAdmin
    .from("instagram_conversations")
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: input.text.slice(0, 200),
    })
    .eq("id", input.conversationId);

  return { messageId };
}

/**
 * Generates an AI reply via the shared agent core (shared-agent-reply.
 * server.ts) for a conversation that just received an inbound message,
 * and sends it back — the normal DM auto-reply path. No-ops (returns
 * null) when the connection has no bot assigned, so an unconfigured
 * connection never sends anything.
 */
export async function generateAndSendInstagramReply(
  supabaseAdmin: Client,
  input: { connectionId: string; conversationId: string; igScopedId: string },
  fetchImpl?: typeof fetch,
): Promise<{ reply: string } | null> {
  const { data: connection, error: connError } = await supabaseAdmin
    .from("instagram_connections")
    .select("id, organization_id, business_id, agent_config_id")
    .eq("id", input.connectionId)
    .maybeSingle();
  if (connError) throw connError;
  if (!connection || !connection.agent_config_id || !connection.business_id) return null;

  const { data: history, error: historyError } = await supabaseAdmin
    .from("instagram_messages")
    .select("direction, content, message_type")
    .eq("conversation_id", input.conversationId)
    .order("occurred_at", { ascending: false })
    .limit(20);
  if (historyError) throw historyError;

  const messages: ChatMessage[] = (history ?? [])
    .filter((m) => m.message_type === "text" && m.content)
    .reverse()
    .map((m) => ({ role: m.direction === "inbound" ? "user" : "assistant", content: m.content! }));
  if (messages.length === 0) return null;

  const result = await generateSharedAgentReply(
    supabaseAdmin,
    {
      organizationId: connection.organization_id,
      businessId: connection.business_id,
      agentConfigId: connection.agent_config_id,
      source: "instagram",
    },
    messages,
  );
  if (!result.reply) return null;

  await sendInstagramDirectMessage(
    supabaseAdmin,
    {
      connectionId: input.connectionId,
      conversationId: input.conversationId,
      recipientIgsid: input.igScopedId,
      text: result.reply,
    },
    fetchImpl,
  );
  return { reply: result.reply };
}
