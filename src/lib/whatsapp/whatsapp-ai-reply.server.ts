/**
 * AI replies to inbound WhatsApp messages, using the business's own agent
 * through the shared, channel-agnostic generateSharedAgentReply (the same
 * grounding and tool registry as voice and Instagram — no separate brain).
 *
 * Runs after Meta has been acknowledged (the webhook route hands new
 * inbound message ids to this module in the background), and again from
 * the recovery sweep for anything that was interrupted.
 *
 * Per inbound text message, at most one reply is ever sent:
 *   1. Guard (no reply, nothing written): the message isn't an inbound text.
 *   2. STOP / START (whatsapp-consent.server.ts): recorded in the consent
 *      ledger (STOP for both scopes, START for transactional only) whatever
 *      the AI settings, the connection status or the 24-hour window, and
 *      acknowledged when the number is connected and the window is open.
 *   3. More guards: the connection isn't connected; the 24-hour window has
 *      closed; the conversation was handed to a person
 *      (ai_enabled = false); no agent, or an agent outside the
 *      connection's own organization; more than MAX_AI_REPLIES_PER_WINDOW
 *      recent replies. A message skipped for AI off, no agent or the rate
 *      limit is marked (metadata.ai_reply_skipped) and never answered later.
 *   4. Claim: an outbound row with reply_to_message_id = the inbound id is
 *      inserted ('queued') BEFORE the model or Meta is called. The partial
 *      unique index on reply_to_message_id makes that insert the lock: a
 *      webhook retry or a concurrent worker gets a conflict and stops. A
 *      claim left 'queued' by a worker that crashed before sending (its
 *      content is still empty) can be taken over after STALE_CLAIM_MS, at
 *      most MAX_REPLY_TAKEOVERS times. A claim whose content was written
 *      may already have reached Meta, so it is never retried.
 *   5. A clear YES/NO to a booking or reschedule the AI proposed is acted
 *      on by the server (whatsapp-actions.server.ts) and answered with the
 *      real result — not by the model.
 *   6. Human handoff: a customer asking for a person turns AI off for the
 *      conversation (handoff_requested_at set, visible in the dashboard),
 *      closes any open proposal, and gets a short acknowledgement.
 *   7. Generate: the latest HISTORY_LIMIT text messages, oldest first, with
 *      a timeout and one retry. Bookings, reschedules and payments are only
 *      proposed (propose_booking / propose_reschedule); the registry tools
 *      that would do them directly are not offered on WhatsApp.
 *   8. Send via whatsapp-outbound.server.ts (bounded retries, status kept).
 *
 * Failures never send anything half-made: the reply row ends 'failed' with
 * a reason, and the customer simply gets no reply rather than a wrong one.
 * Tenant identity comes only from rows matched server-side (message →
 * conversation → connection → agent), all filtered by the same
 * organization id.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import type { ChatMessage } from "../sarvam.server.ts";
import {
  deliverWhatsAppMessage,
  isWithinCustomerServiceWindow,
  type DeliveryDeps,
  type OutboundConnection,
} from "./whatsapp-outbound.server.ts";
import type { ChannelTool } from "../shared-agent-reply.server.ts";
import {
  OPT_IN_ACKNOWLEDGEMENT,
  OPT_OUT_ACKNOWLEDGEMENT,
  consentEventTime,
  consentScopesForKeyword,
  parseConsentKeyword,
  recordConsentEvent,
  writeAuditLog,
} from "./whatsapp-consent.server.ts";
import {
  WHATSAPP_DIRECT_TOOL_BLOCKLIST,
  buildWhatsAppActionTools,
  handlePendingActionReply,
  type WhatsAppActionContext,
  type WhatsAppActionDeps,
} from "./whatsapp-actions.server.ts";

type Client = SupabaseClient<Database>;

export const HISTORY_LIMIT = 20;
/** Set on an inbound message the AI deliberately didn't answer; it is never answered later. */
export const AI_REPLY_SKIPPED_KEY = "ai_reply_skipped";
const SETTLED_SKIPS = new Set<ReplyOutcome>([
  "skipped_ai_disabled",
  "skipped_no_agent",
  "skipped_rate_limited",
]);
export const AI_REPLY_TIMEOUT_MS = 25_000;
export const AI_REPLY_ATTEMPTS = 2;
export const STALE_CLAIM_MS = 2 * 60_000;
export const MAX_REPLY_TAKEOVERS = 2;
/** AI replies allowed per conversation within AI_REPLY_RATE_WINDOW_MS. */
export const MAX_AI_REPLIES_PER_WINDOW = 5;
export const AI_REPLY_RATE_WINDOW_MS = 10 * 60_000;
/**
 * Registry tools the model may not call directly on WhatsApp: bookings,
 * reschedules and payments go through propose → customer YES → server
 * (whatsapp-actions.server.ts).
 */
export const WHATSAPP_EXCLUDED_TOOLS = WHATSAPP_DIRECT_TOOL_BLOCKLIST;

export const HANDOFF_ACKNOWLEDGEMENT =
  "Thanks — I've passed this conversation to our team, and a member of staff will reply here.";
const HANDOFF_PATTERN =
  /\b(?:human|real person|representative|(?:talk|speak|chat) (?:to|with) (?:a |an |the |your )?(?:person|agent|staff|someone|somebody|team|manager|owner))\b/i;

export function isHandoffRequest(text: string): boolean {
  return HANDOFF_PATTERN.test(text);
}

export type ReplyOutcome =
  | "replied"
  | "handoff"
  | "duplicate"
  | "skipped_not_text"
  | "skipped_not_found"
  | "skipped_ai_disabled"
  | "skipped_no_agent"
  | "skipped_window_closed"
  | "skipped_rate_limited"
  | "skipped_empty_reply"
  | "failed_ai"
  | "failed_send"
  | "consent_updated"
  | "action_completed"
  | "action_declined"
  | "action_failed";

export interface ReplyDeps extends DeliveryDeps {
  /** Defaults to generateSharedAgentReply. */
  generateReply?:
    | ((
        supabaseAdmin: Client,
        ctx: {
          organizationId: string;
          businessId: string;
          agentConfigId: string | null;
          source: "whatsapp";
          excludeToolNames: readonly string[];
          extraTools: readonly ChannelTool[];
        },
        history: ChatMessage[],
      ) => Promise<{ reply: string }>)
    | undefined;
  aiTimeoutMs?: number | undefined;
  /** The booking/payment tool layer used by confirmed WhatsApp actions (tests inject it). */
  actions?: WhatsAppActionDeps | undefined;
}

class AiTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AiTimeoutError("AI reply timed out.")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Claims the reply slot for this inbound message, or takes over a stale claim. Returns the reply row id, or null when another worker owns it / it's already done. */
async function claimReply(
  supabaseAdmin: Client,
  inbound: {
    id: string;
    organization_id: string;
    whatsapp_connection_id: string;
    conversation_id: string;
  },
  origin: "ai" | "handoff_ack" | "consent_ack",
  now: Date,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .insert({
      organization_id: inbound.organization_id,
      whatsapp_connection_id: inbound.whatsapp_connection_id,
      conversation_id: inbound.conversation_id,
      direction: "outbound",
      message_type: "text",
      status: "queued",
      reply_to_message_id: inbound.id,
      metadata: { origin, claimed_at: now.toISOString(), takeovers: 0 } as Json,
    })
    .select("id")
    .single();
  if (!error) return data.id;
  if (error.code !== "23505") throw error;

  // Already claimed. Only a 'queued' claim abandoned long enough ago (a
  // crashed worker) may be taken over — and only a bounded number of times.
  const { data: existing, error: readError } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("id, status, content, metadata")
    .eq("reply_to_message_id", inbound.id)
    .eq("organization_id", inbound.organization_id)
    .maybeSingle();
  if (readError) throw readError;
  // Content is written just before sending: past that point Meta may have the message.
  if (!existing || existing.status !== "queued" || existing.content !== null) return null;
  const meta = (existing.metadata ?? {}) as Record<string, unknown>;
  const claimedAt = typeof meta["claimed_at"] === "string" ? meta["claimed_at"] : null;
  const takeovers = typeof meta["takeovers"] === "number" ? meta["takeovers"] : 0;
  if (
    !claimedAt ||
    now.getTime() - new Date(claimedAt).getTime() < STALE_CLAIM_MS ||
    takeovers >= MAX_REPLY_TAKEOVERS
  ) {
    return null;
  }
  const { data: taken, error: takeError } = await supabaseAdmin
    .from("whatsapp_messages")
    .update({
      metadata: { ...meta, claimed_at: now.toISOString(), takeovers: takeovers + 1 } as Json,
    })
    .eq("id", existing.id)
    .eq("status", "queued")
    .is("content", null)
    .eq("metadata->>claimed_at", claimedAt)
    .select("id");
  if (takeError) throw takeError;
  return taken && taken.length > 0 ? existing.id : null;
}

async function loadHistory(
  supabaseAdmin: Client,
  organizationId: string,
  conversationId: string,
): Promise<ChatMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("direction, content, status, message_type, occurred_at")
    .eq("conversation_id", conversationId)
    .eq("organization_id", organizationId)
    .eq("message_type", "text")
    .not("content", "is", null)
    .neq("status", "failed")
    .order("occurred_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) throw error;
  return (data ?? []).reverse().map((m) => ({
    role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
    content: m.content ?? "",
  }));
}

async function defaultGenerateReply(
  supabaseAdmin: Client,
  ctx: Parameters<NonNullable<ReplyDeps["generateReply"]>>[1],
  history: ChatMessage[],
): Promise<{ reply: string }> {
  const { generateSharedAgentReply } = await import("../shared-agent-reply.server.ts");
  return generateSharedAgentReply(supabaseAdmin, ctx, history);
}

export async function replyToInboundWhatsAppMessage(
  supabaseAdmin: Client,
  inboundMessageId: string,
  deps: ReplyDeps = {},
): Promise<ReplyOutcome> {
  const now = (deps.now ?? (() => new Date()))();

  const { data: inbound, error: inboundError } = await supabaseAdmin
    .from("whatsapp_messages")
    .select(
      "id, organization_id, whatsapp_connection_id, conversation_id, direction, message_type, content, occurred_at, metadata",
    )
    .eq("id", inboundMessageId)
    .maybeSingle();
  if (inboundError) throw inboundError;
  if (!inbound) return "skipped_not_found";
  if (inbound.direction !== "inbound" || inbound.message_type !== "text" || !inbound.content) {
    return "skipped_not_text";
  }
  const org = inbound.organization_id;

  const { data: conversation, error: convError } = await supabaseAdmin
    .from("whatsapp_conversations")
    .select("id, wa_id, ai_enabled, customer_display_name")
    .eq("id", inbound.conversation_id)
    .eq("organization_id", org)
    .maybeSingle();
  if (convError) throw convError;
  if (!conversation) return "skipped_not_found";

  const { data: connection, error: connError } = await supabaseAdmin
    .from("whatsapp_connections")
    .select(
      "id, organization_id, business_id, phone_number_id, access_token_ciphertext, status, agent_config_id",
    )
    .eq("id", inbound.whatsapp_connection_id)
    .eq("organization_id", org)
    .maybeSingle();
  if (connError) throw connError;
  if (!connection) return "skipped_no_agent";
  const connected = connection.status === "connected";
  const windowOpen = isWithinCustomerServiceWindow(inbound.occurred_at, now);

  // STOP / START work whatever the AI settings are — and are recorded even
  // when no acknowledgement can be sent (the number isn't connected right
  // now, or this message is being processed after the 24-hour window).
  const keyword = connection.business_id ? parseConsentKeyword(inbound.content) : null;
  if (keyword && connection.business_id) {
    const replyRowId = await claimReply(supabaseAdmin, inbound, "consent_ack", now);
    if (!replyRowId) return "duplicate";
    for (const scope of consentScopesForKeyword(keyword)) {
      await recordConsentEvent(supabaseAdmin, {
        organizationId: org,
        businessId: connection.business_id,
        waId: conversation.wa_id,
        scope,
        action: keyword,
        source: "customer_keyword",
        evidence: `whatsapp_message:${inbound.id}`,
        occurredAt: consentEventTime(inbound.occurred_at, now),
      });
    }
    await writeAuditLog(supabaseAdmin, {
      organizationId: org,
      businessId: connection.business_id,
      actorType: "customer",
      action: keyword === "opt_out" ? "consent.opt_out" : "consent.opt_in",
      subjectType: "whatsapp_conversation",
      subjectId: conversation.id,
      details: { source: "customer_keyword" },
    });
    if (!connected || !windowOpen) {
      // Settle the reply slot so redeliveries and the recovery sweep stop here.
      await supabaseAdmin
        .from("whatsapp_messages")
        .update({
          status: "failed",
          error_message: connected
            ? "Consent change recorded; no acknowledgement sent because the 24-hour window had closed."
            : "Consent change recorded; no acknowledgement sent because the number isn't connected.",
        })
        .eq("id", replyRowId)
        .eq("status", "queued");
      return "consent_updated";
    }
    const body = keyword === "opt_out" ? OPT_OUT_ACKNOWLEDGEMENT : OPT_IN_ACKNOWLEDGEMENT;
    return (await sendClaimedReply(
      supabaseAdmin,
      replyRowId,
      connection,
      conversation,
      body,
      now,
      deps,
    ))
      ? "consent_updated"
      : "failed_send";
  }

  // A message the AI deliberately didn't answer (AI off, no agent, rate
  // limit) is never answered later: turning AI back on, assigning an agent
  // or the rate window passing must not produce stale replies through the
  // recovery sweep or a retry.
  const inboundMeta = (inbound.metadata ?? {}) as Record<string, unknown>;
  const skippedBefore = inboundMeta[AI_REPLY_SKIPPED_KEY];
  if (typeof skippedBefore === "string" && SETTLED_SKIPS.has(skippedBefore as ReplyOutcome)) {
    return skippedBefore as ReplyOutcome;
  }
  const settleSkip = async (reason: ReplyOutcome): Promise<ReplyOutcome> => {
    const { error: markError } = await supabaseAdmin
      .from("whatsapp_messages")
      .update({
        metadata: {
          ...inboundMeta,
          [AI_REPLY_SKIPPED_KEY]: reason,
          ai_reply_skipped_at: now.toISOString(),
        } as Json,
      })
      .eq("id", inbound.id)
      .eq("organization_id", org);
    if (markError) throw markError;
    return reason;
  };

  if (!connected) return "skipped_no_agent";
  if (!windowOpen) return "skipped_window_closed";
  if (!conversation.ai_enabled) return settleSkip("skipped_ai_disabled");
  if (!connection.agent_config_id) return settleSkip("skipped_no_agent");
  const { data: agent, error: agentError } = await supabaseAdmin
    .from("agent_configs")
    .select("id, business_id, organization_id")
    .eq("id", connection.agent_config_id)
    .eq("organization_id", org)
    .maybeSingle();
  if (agentError) throw agentError;
  if (!agent) return settleSkip("skipped_no_agent");

  const { count: recentReplies, error: countError } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversation.id)
    .eq("organization_id", org)
    .not("reply_to_message_id", "is", null)
    .neq("status", "failed")
    .gte("created_at", new Date(now.getTime() - AI_REPLY_RATE_WINDOW_MS).toISOString());
  if (countError) throw countError;
  if ((recentReplies ?? 0) >= MAX_AI_REPLIES_PER_WINDOW) {
    // The count may include this message's own reply claim (a worker that
    // got in under the limit and is still working, or crashed). Then it is
    // not rate-limited: the claim below answers "duplicate" while that claim
    // is live and takes it over once abandoned, so it is still answered once.
    const { data: ownClaim, error: ownClaimError } = await supabaseAdmin
      .from("whatsapp_messages")
      .select("id")
      .eq("reply_to_message_id", inbound.id)
      .eq("organization_id", org)
      .limit(1)
      .maybeSingle();
    if (ownClaimError) throw ownClaimError;
    if (!ownClaim) {
      console.warn("whatsapp_ai_reply:rate_limited", { conversationId: conversation.id });
      return settleSkip("skipped_rate_limited");
    }
  }

  const handoff = isHandoffRequest(inbound.content);
  const replyRowId = await claimReply(supabaseAdmin, inbound, handoff ? "handoff_ack" : "ai", now);
  if (!replyRowId) return "duplicate";

  const failRow = async (message: string) => {
    await supabaseAdmin
      .from("whatsapp_messages")
      .update({ status: "failed", error_message: message })
      .eq("id", replyRowId)
      .eq("status", "queued");
  };
  // A proposal made while answering this message, whose reply never reached
  // the customer, must not stay open for a later "ok" to confirm.
  const closeUnshownProposals = async () => {
    const { error: closeError } = await supabaseAdmin
      .from("whatsapp_pending_actions")
      .update({ status: "superseded" })
      .eq("conversation_id", conversation.id)
      .eq("organization_id", org)
      .eq("proposed_in_message_id", inbound.id)
      .eq("status", "awaiting_confirmation");
    if (closeError) throw closeError;
  };

  const { data: business, error: businessError } = await supabaseAdmin
    .from("businesses")
    .select("timezone, country")
    .eq("id", agent.business_id)
    .eq("organization_id", org)
    .maybeSingle();
  if (businessError) throw businessError;
  const actionCtx: WhatsAppActionContext = {
    organizationId: org,
    businessId: agent.business_id,
    agentConfigId: agent.id,
    conversationId: conversation.id,
    waId: conversation.wa_id,
    customerDisplayName: conversation.customer_display_name,
    inboundMessageId: inbound.id,
    timezone: business?.timezone ?? "UTC",
    country: business?.country ?? null,
    now,
  };

  let body: string;
  let outcome: ReplyOutcome = handoff ? "handoff" : "replied";
  // A YES/NO to a booking the AI proposed is acted on by the server, not the model.
  const pending = handoff
    ? ({ handled: false } as const)
    : await handlePendingActionReply(
        supabaseAdmin,
        { ...actionCtx, messageText: inbound.content },
        { fetchImpl: deps.fetchImpl, ...deps.actions },
      );
  if (pending.handled) {
    if (!pending.reply) {
      await failRow("Another worker is acting on this confirmation.");
      return "duplicate";
    }
    body = pending.reply;
    outcome =
      pending.status === "completed"
        ? "action_completed"
        : pending.status === "declined"
          ? "action_declined"
          : "action_failed";
  } else if (handoff) {
    const { error: handoffError } = await supabaseAdmin
      .from("whatsapp_conversations")
      .update({ ai_enabled: false, handoff_requested_at: now.toISOString() })
      .eq("id", conversation.id)
      .eq("organization_id", org);
    if (handoffError) throw handoffError;
    // A person takes it from here: no open proposal stays confirmable.
    await supabaseAdmin
      .from("whatsapp_pending_actions")
      .update({ status: "superseded" })
      .eq("conversation_id", conversation.id)
      .eq("organization_id", org)
      .eq("status", "awaiting_confirmation");
    body = HANDOFF_ACKNOWLEDGEMENT;
  } else {
    const history = await loadHistory(supabaseAdmin, org, conversation.id);
    const generate = deps.generateReply ?? defaultGenerateReply;
    let reply = "";
    let lastError = "";
    // Only the attempt in progress may store a proposal: a timed-out attempt
    // keeps running in the background and must not leave one behind.
    let liveAttempt = 0;
    for (let attempt = 1; attempt <= AI_REPLY_ATTEMPTS; attempt++) {
      liveAttempt = attempt;
      const extraTools = buildWhatsAppActionTools(supabaseAdmin, actionCtx, {
        fetchImpl: deps.fetchImpl,
        ...deps.actions,
        isActive: () => liveAttempt === attempt,
      });
      try {
        const result = await withTimeout(
          generate(
            supabaseAdmin,
            {
              organizationId: org,
              businessId: agent.business_id,
              agentConfigId: agent.id,
              source: "whatsapp",
              excludeToolNames: WHATSAPP_EXCLUDED_TOOLS,
              extraTools,
            },
            history,
          ),
          deps.aiTimeoutMs ?? AI_REPLY_TIMEOUT_MS,
        );
        reply = result.reply.trim();
        lastError = "";
        liveAttempt = 0;
        break;
      } catch (err) {
        lastError = err instanceof AiTimeoutError ? "timeout" : "error";
        liveAttempt = 0;
        console.warn("whatsapp_ai_reply:generation_failed", {
          inboundMessageId,
          attempt,
          reason: lastError,
        });
      }
    }
    if (lastError) {
      await closeUnshownProposals();
      await failRow(
        lastError === "timeout"
          ? "The AI reply timed out."
          : "The AI reply could not be generated.",
      );
      return "failed_ai";
    }
    if (!reply) {
      await closeUnshownProposals();
      await failRow("The AI returned an empty reply.");
      return "skipped_empty_reply";
    }
    body = reply.slice(0, 4096); // WhatsApp's text body limit
  }

  const sent = await sendClaimedReply(
    supabaseAdmin,
    replyRowId,
    connection,
    conversation,
    body,
    now,
    deps,
  );
  if (!sent) {
    await closeUnshownProposals();
    return "failed_send";
  }
  return outcome;
}

/** Writes the reply text onto the claimed row, sends it, and updates the conversation preview. */
async function sendClaimedReply(
  supabaseAdmin: Client,
  replyRowId: string,
  connection: OutboundConnection,
  conversation: { id: string; wa_id: string },
  body: string,
  now: Date,
  deps: ReplyDeps,
): Promise<boolean> {
  const { error: contentError } = await supabaseAdmin
    .from("whatsapp_messages")
    .update({ content: body })
    .eq("id", replyRowId);
  if (contentError) throw contentError;

  const sent = await deliverWhatsAppMessage(
    supabaseAdmin,
    {
      messageRowId: replyRowId,
      connection,
      to: conversation.wa_id,
      payload: { kind: "text", body },
    },
    deps,
  );
  if (sent.outcome === "failed") return false;

  await supabaseAdmin
    .from("whatsapp_conversations")
    .update({ last_message_at: now.toISOString(), last_message_preview: body.slice(0, 200) })
    .eq("id", conversation.id)
    .eq("organization_id", connection.organization_id);
  return true;
}

/** Error text for logs; PostgREST errors are plain objects, not Error instances. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** Replies to several inbound messages one at a time; one failure never stops the rest. */
export async function replyToInboundWhatsAppMessages(
  supabaseAdmin: Client,
  inboundMessageIds: string[],
  deps: ReplyDeps = {},
): Promise<Record<string, ReplyOutcome | "error">> {
  const results: Record<string, ReplyOutcome | "error"> = {};
  for (const id of inboundMessageIds) {
    try {
      results[id] = await replyToInboundWhatsAppMessage(supabaseAdmin, id, deps);
    } catch (err) {
      results[id] = "error";
      console.error("whatsapp_ai_reply:error", {
        inboundMessageId: id,
        message: errorMessage(err),
      });
    }
  }
  return results;
}

/**
 * Recovery sweep: inbound text messages from the last RECOVERY_LOOKBACK_MS
 * that have no reply row, or whose reply claim was abandoned, are retried
 * through the same path (all its guards and the claim still apply, so
 * nothing is ever answered twice). Bounded per run.
 */
export const RECOVERY_LOOKBACK_MS = 30 * 60_000;
export const RECOVERY_BATCH_SIZE = 50;

export async function recoverPendingWhatsAppReplies(
  supabaseAdmin: Client,
  deps: ReplyDeps = {},
): Promise<{
  examined: number;
  attempted: number;
  results: Record<string, ReplyOutcome | "error">;
}> {
  const now = (deps.now ?? (() => new Date()))();
  const { data: inbound, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("id")
    .eq("direction", "inbound")
    .eq("message_type", "text")
    .is(`metadata->>${AI_REPLY_SKIPPED_KEY}`, null)
    .gte("occurred_at", new Date(now.getTime() - RECOVERY_LOOKBACK_MS).toISOString())
    .lte("occurred_at", new Date(now.getTime() - 60_000).toISOString())
    .order("occurred_at", { ascending: true })
    .limit(RECOVERY_BATCH_SIZE);
  if (error) throw error;
  const ids = (inbound ?? []).map((m) => m.id);
  if (ids.length === 0) return { examined: 0, attempted: 0, results: {} };

  const { data: replies, error: replyError } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("reply_to_message_id, status")
    .in("reply_to_message_id", ids);
  if (replyError) throw replyError;
  const settled = new Set(
    (replies ?? [])
      .filter((r) => r.status !== "queued")
      .map((r) => r.reply_to_message_id as string),
  );
  const pending = ids.filter((id) => !settled.has(id));
  const results = await replyToInboundWhatsAppMessages(supabaseAdmin, pending, deps);
  return { examined: ids.length, attempted: pending.length, results };
}
