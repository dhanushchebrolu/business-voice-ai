/**
 * Comment->DM automation engine (Phase 5 spec PART 11) — the minimal v1
 * the spec explicitly asks for: match one enabled rule per comment, run
 * exactly one action. No visual builder, no rule DSL, no multi-step graph.
 *
 * IDEMPOTENCY + BOT-LOOP PROTECTION (spec §12, mandatory): every comment
 * id is claimed exactly once via an atomic INSERT into
 * instagram_comment_events (organization_id, instagram_connection_id,
 * comment_id) — a 23505 unique-violation means either a duplicate webhook
 * redelivery OR a comment that resulted from our own public reply/action
 * arriving back as a "new" comment webhook, and either way this function
 * returns immediately without taking any action a second time. This is
 * the PRIMARY guard for the "comment -> public reply -> comment webhook
 * -> another reply" loop the spec calls out by name. A SECONDARY guard
 * (skip entirely, recorded as 'skipped_own_comment') additionally checks
 * the comment's own author id against the connection's
 * instagram_business_account_id — our own public replies are authored by
 * that account, so this catches the case even before Meta's webhook would
 * deliver it back at all.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { MetaInstagramClient, MetaApiError } from "./meta-instagram-client.server.ts";
import { decryptCredential } from "./instagram-token-crypto.server.ts";
import { resolveInstagramConfig } from "./instagram-config.server.ts";
import { generateSharedAgentReply } from "../shared-agent-reply.server.ts";

type Client = SupabaseClient<Database>;

interface CommentValue {
  id?: string;
  text?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string };
  parent_id?: string;
}

interface AutomationRule {
  id: string;
  trigger_type: string;
  trigger_config: unknown;
  action_type: string;
  action_config: unknown;
}

function matchesRule(rule: AutomationRule, comment: CommentValue): boolean {
  const config = (rule.trigger_config ?? {}) as { keywords?: string[]; postId?: string };
  if (config.postId && comment.media?.id && config.postId !== comment.media.id) return false;

  if (rule.trigger_type === "comment_any") return true;
  if (rule.trigger_type === "comment_keyword") {
    const text = (comment.text ?? "").toLowerCase();
    return (config.keywords ?? []).some((kw) => text.includes(kw.toLowerCase()));
  }
  return false;
}

async function runAction(
  supabaseAdmin: Client,
  connection: {
    id: string;
    organizationId: string;
    businessId: string | null;
    agentConfigId: string | null;
    instagramBusinessAccountId: string;
    accessToken: string;
  },
  rule: AutomationRule,
  comment: CommentValue,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const config = resolveInstagramConfig();
  if (!config) return "none";
  const client = new MetaInstagramClient({
    appId: config.appId,
    appSecret: config.appSecret,
    graphApiVersion: config.graphApiVersion,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  if (rule.action_type === "public_reply") {
    const actionConfig = (rule.action_config ?? {}) as { replyText?: string };
    if (!actionConfig.replyText || !comment.id) return "none";
    try {
      await client.replyToComment(comment.id, actionConfig.replyText, connection.accessToken);
      return "public_reply";
    } catch (err) {
      console.error(
        "instagram_automation:public_reply_failed",
        err instanceof MetaApiError ? err.message : err,
      );
      return "none";
    }
  }

  if (rule.action_type === "private_dm") {
    const actionConfig = (rule.action_config ?? {}) as { dmText?: string };
    if (!actionConfig.dmText || !comment.id) return "none";
    try {
      await client.sendPrivateReplyToComment(
        comment.id,
        actionConfig.dmText,
        connection.accessToken,
      );
      return "private_dm";
    } catch (err) {
      console.error(
        "instagram_automation:private_dm_failed",
        err instanceof MetaApiError ? err.message : err,
      );
      return "none";
    }
  }

  if (rule.action_type === "ai_dm") {
    if (!comment.id || !comment.text || !connection.businessId) return "none";
    try {
      const result = await generateSharedAgentReply(
        supabaseAdmin,
        {
          organizationId: connection.organizationId,
          businessId: connection.businessId,
          agentConfigId: connection.agentConfigId,
          source: "instagram",
        },
        [{ role: "user", content: comment.text }],
      );
      if (!result.reply) return "none";
      await client.sendPrivateReplyToComment(comment.id, result.reply, connection.accessToken);
      return "ai_dm";
    } catch (err) {
      console.error("instagram_automation:ai_dm_failed", err instanceof Error ? err.message : err);
      return "none";
    }
  }

  return "none";
}

/**
 * Processes every comment change in one webhook batch for one connection.
 * Never throws for an individual comment's action failure — a rule action
 * failing (Meta error, misconfigured rule) is logged and recorded as
 * action_taken='none' on that comment's ledger row, never surfaced as a
 * webhook processing failure (same fault-isolation convention as
 * instagram-inbound.server.ts's AI-reply call).
 */
export async function processInboundComments(
  supabaseAdmin: Client,
  connection: { id: string; organization_id: string; instagram_business_account_id: string },
  comments: CommentValue[],
  fetchImpl?: typeof fetch,
): Promise<void> {
  for (const comment of comments) {
    if (!comment.id) continue;

    // Atomic claim — see this file's module doc. A 23505 means this
    // comment_id was already processed (duplicate delivery or our own
    // loop-inducing action); stop immediately, take no action.
    const { error: claimError } = await supabaseAdmin.from("instagram_comment_events").insert({
      organization_id: connection.organization_id,
      instagram_connection_id: connection.id,
      comment_id: comment.id,
      action_taken: "none",
    });
    if (claimError) {
      if (claimError.code === "23505") continue;
      throw claimError;
    }

    if (comment.from?.id === connection.instagram_business_account_id) {
      await supabaseAdmin
        .from("instagram_comment_events")
        .update({ action_taken: "skipped_own_comment" })
        .eq("instagram_connection_id", connection.id)
        .eq("comment_id", comment.id);
      continue;
    }

    const { data: rules, error: rulesError } = await supabaseAdmin
      .from("instagram_automation_rules")
      .select("id, trigger_type, trigger_config, action_type, action_config")
      .eq("instagram_connection_id", connection.id)
      .eq("enabled", true)
      .order("created_at", { ascending: true });
    if (rulesError) throw rulesError;

    const matched = (rules ?? []).find((r) => matchesRule(r, comment));
    if (!matched) continue;

    const { data: fullConnection, error: connError } = await supabaseAdmin
      .from("instagram_connections")
      .select(
        "id, organization_id, business_id, agent_config_id, instagram_business_account_id, access_token_ciphertext, status",
      )
      .eq("id", connection.id)
      .maybeSingle();
    if (connError) throw connError;
    if (
      !fullConnection ||
      fullConnection.status === "disconnected" ||
      !fullConnection.access_token_ciphertext
    ) {
      continue;
    }

    const actionTaken = await runAction(
      supabaseAdmin,
      {
        id: fullConnection.id,
        organizationId: fullConnection.organization_id,
        businessId: fullConnection.business_id,
        agentConfigId: fullConnection.agent_config_id,
        instagramBusinessAccountId: fullConnection.instagram_business_account_id,
        accessToken: decryptCredential(fullConnection.access_token_ciphertext),
      },
      matched,
      comment,
      fetchImpl,
    );

    await supabaseAdmin
      .from("instagram_comment_events")
      .update({ matched_rule_id: matched.id, action_taken: actionTaken })
      .eq("instagram_connection_id", connection.id)
      .eq("comment_id", comment.id);
  }
}
