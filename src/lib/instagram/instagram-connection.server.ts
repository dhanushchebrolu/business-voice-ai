/**
 * Orchestrates the Instagram connection lifecycle for one tenant: OAuth
 * completion, disconnect, and bot (re)assignment. Mirrors
 * whatsapp-onboarding.server.ts's separation of concerns exactly: callers
 * own authentication and tenant derivation (organizationId/businessId are
 * trusted parameters here, already validated by the caller against the
 * authenticated session via oauth_states — see instagram.functions.ts and
 * the callback route) — this file's own job is orchestration, not auth.
 *
 * META APP REVIEW DEPENDENCY (spec §17 — must be stated plainly, not
 * asserted as "just works"): instagram_manage_messages/
 * instagram_manage_comments are Advanced Access permissions. Until
 * ClickAI's Meta App passes App Review for them, this OAuth flow only
 * succeeds for Instagram accounts that are Meta-registered testers/admins
 * of ClickAI's own Meta App — a real customer's account will be rejected
 * by Meta's consent screen or by these API calls with a permissions error,
 * not by any code in this file. Nothing here fakes success; every failure
 * surfaces through the same InstagramConnectionError path a genuine
 * connectivity problem would.
 *
 * Sequence (see meta-instagram-client.server.ts's own doc comment for
 * exactly what is and is not independently verified about each endpoint):
 *   1. Exchange the authorization code for a short-lived access token.
 *   2. Exchange it for a long-lived token (~60 days) — the browser never
 *      sees either token.
 *   3. Discover which Facebook Page(s)/Instagram account(s) this token
 *      covers. Exactly one linked account is required (see the module's
 *      "ambiguous account" handling below) — this is a deliberate v1 scope
 *      decision (spec: "keep v1 focused"), not a technical limitation:
 *      Meta's own consent screen lets the customer choose which Page(s) to
 *      grant, so asking them to grant exactly one is a legitimate
 *      constraint to state up front rather than building a second
 *      account-picker UI/flow in this phase.
 *   4. Reject if this Meta IG account id is already live on a DIFFERENT
 *      organization (defense-in-depth alongside the unique index).
 *   5. Persist a 'connecting' row before subscribing to webhooks, so a
 *      mid-sequence failure leaves a diagnosable, retryable row.
 *   6. Subscribe to the Page's webhook events. On failure: mark the row
 *      'needs_attention' (the token IS valid and persisted).
 *   7. Only once 6 succeeds: mark 'connected'.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { MetaInstagramClient, MetaApiError } from "./meta-instagram-client.server.ts";
import { encryptCredential } from "./instagram-token-crypto.server.ts";
import { resolveInstagramConfig } from "./instagram-config.server.ts";

type Client = SupabaseClient<Database>;

export class InstagramConnectionError extends Error {
  code:
    | "NOT_CONFIGURED"
    | "NOT_FOUND"
    | "INVALID_BUSINESS"
    | "NO_INSTAGRAM_ACCOUNT"
    | "AMBIGUOUS_ACCOUNT"
    | "DUPLICATE_ACCOUNT"
    | "OAUTH_FAILED"
    | "UNKNOWN";
  constructor(message: string, code: InstagramConnectionError["code"]) {
    super(message);
    this.code = code;
  }
}

export interface CompleteInstagramOAuthInput {
  organizationId: string;
  businessId: string | null;
  code: string;
}

export interface CompleteInstagramOAuthResult {
  connectionId: string;
  status: "connected" | "needs_attention" | "error";
  instagramBusinessAccountId: string;
  username: string | null;
  displayName: string | null;
  webhookSubscribed: boolean;
  lastError: string | null;
}

/** Never leaks a raw Meta/DB error to the returned row or the caller. */
function safeErrorMessage(err: unknown): string {
  if (err instanceof MetaApiError) return err.message;
  if (err instanceof InstagramConnectionError) return err.message;
  return "An unexpected error occurred while contacting Meta.";
}

export async function completeInstagramOAuth(
  supabaseAdmin: Client,
  input: CompleteInstagramOAuthInput,
  fetchImpl: typeof fetch = fetch,
): Promise<CompleteInstagramOAuthResult> {
  const { organizationId, businessId, code } = input;

  const config = resolveInstagramConfig();
  if (!config) {
    throw new InstagramConnectionError(
      "Instagram is not configured on this deployment yet.",
      "NOT_CONFIGURED",
    );
  }

  // businessId, if supplied, must genuinely belong to this organization —
  // same defense-in-depth as whatsapp-onboarding.server.ts.
  if (businessId) {
    const { data: business, error: businessError } = await supabaseAdmin
      .from("businesses")
      .select("id, organization_id")
      .eq("id", businessId)
      .maybeSingle();
    if (businessError) throw businessError;
    if (!business || business.organization_id !== organizationId) {
      throw new InstagramConnectionError(
        "That business does not belong to your workspace.",
        "INVALID_BUSINESS",
      );
    }
  }

  const metaClient = new MetaInstagramClient({
    appId: config.appId,
    appSecret: config.appSecret,
    graphApiVersion: config.graphApiVersion,
    fetchImpl,
  });

  // 1-2. Code exchange + long-lived token. No row exists yet, so failures throw.
  let shortLivedToken: string;
  try {
    ({ accessToken: shortLivedToken } = await metaClient.exchangeAuthorizationCode(code));
  } catch (err) {
    throw new InstagramConnectionError(safeErrorMessage(err), "OAUTH_FAILED");
  }

  let accessToken: string;
  try {
    ({ accessToken } = await metaClient.exchangeForLongLivedToken(shortLivedToken));
  } catch (err) {
    throw new InstagramConnectionError(safeErrorMessage(err), "OAUTH_FAILED");
  }

  // 3. Discover the connected Page(s)/Instagram account(s).
  let pages;
  try {
    pages = await metaClient.listPagesWithInstagramAccounts(accessToken);
  } catch (err) {
    throw new InstagramConnectionError(safeErrorMessage(err), "OAUTH_FAILED");
  }
  const withInstagram = pages.filter((p) => p.instagramBusinessAccountId);
  if (withInstagram.length === 0) {
    throw new InstagramConnectionError(
      "No Instagram professional account is linked to the Facebook Page(s) you granted access to. Link your Instagram account to a Facebook Page in Meta Business Suite first, then try again.",
      "NO_INSTAGRAM_ACCOUNT",
    );
  }
  if (withInstagram.length > 1) {
    throw new InstagramConnectionError(
      "You granted access to more than one Facebook Page with a linked Instagram account. Please reconnect and grant access to only the one Page/Instagram account you want ClickAI to manage.",
      "AMBIGUOUS_ACCOUNT",
    );
  }
  const page = withInstagram[0]!;
  const igAccountId = page.instagramBusinessAccountId!;

  let verified: {
    id: string;
    username: string | null;
    name: string | null;
    profilePictureUrl: string | null;
  };
  try {
    verified = await metaClient.getInstagramAccount(igAccountId, accessToken);
  } catch (err) {
    throw new InstagramConnectionError(safeErrorMessage(err), "OAUTH_FAILED");
  }

  // 4. Cross-tenant duplicate check, before any write.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("instagram_connections")
    .select("id, organization_id, status")
    .eq("instagram_business_account_id", verified.id)
    .neq("status", "disconnected")
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing && existing.organization_id !== organizationId) {
    throw new InstagramConnectionError(
      "This Instagram account is already connected to a different ClickAI account.",
      "DUPLICATE_ACCOUNT",
    );
  }

  // 5. Persist identifiers immediately.
  const connectingPatch = {
    organization_id: organizationId,
    business_id: businessId,
    instagram_business_account_id: verified.id,
    facebook_page_id: page.pageId,
    username: verified.username,
    display_name: verified.name,
    profile_picture_url: verified.profilePictureUrl,
    status: "connecting" as const,
    last_error: null,
  };

  let connectionId: string;
  if (existing) {
    const { error: updateError } = await supabaseAdmin
      .from("instagram_connections")
      .update(connectingPatch)
      .eq("id", existing.id);
    if (updateError) throw updateError;
    connectionId = existing.id;
  } else {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("instagram_connections")
      .insert(connectingPatch)
      .select("id")
      .single();
    if (insertError) {
      if ((insertError as { code?: string }).code === "23505") {
        throw new InstagramConnectionError(
          "This Instagram account is already connected to a different ClickAI account.",
          "DUPLICATE_ACCOUNT",
        );
      }
      throw insertError;
    }
    connectionId = inserted.id;
  }

  const baseResult = {
    connectionId,
    instagramBusinessAccountId: verified.id,
    username: verified.username,
    displayName: verified.name,
  };

  // 6. Subscribe to the Page's webhook events.
  const accessTokenCiphertext = encryptCredential(accessToken);
  let webhookSubscribed = false;
  let lastError: string | null = null;
  try {
    const subscribed = await metaClient.subscribePageWebhook(page.pageId, accessToken);
    webhookSubscribed = subscribed.success;
    if (!webhookSubscribed) lastError = "Meta did not confirm the webhook subscription.";
  } catch (err) {
    lastError = safeErrorMessage(err);
  }

  const finalStatus: CompleteInstagramOAuthResult["status"] = webhookSubscribed
    ? "connected"
    : "needs_attention";

  const { error: finalUpdateError } = await supabaseAdmin
    .from("instagram_connections")
    .update({
      status: finalStatus,
      access_token_ciphertext: accessTokenCiphertext,
      webhook_subscribed: webhookSubscribed,
      last_connected_at: finalStatus === "connected" ? new Date().toISOString() : null,
      last_error: lastError,
    })
    .eq("id", connectionId);
  if (finalUpdateError) throw finalUpdateError;

  return { ...baseResult, status: finalStatus, webhookSubscribed, lastError };
}

/** Reassigns which bot (agent_config) handles a connection — the one self-service mutation customers get, matching whatsapp-connection.functions.ts. */
export async function assignInstagramBot(
  supabaseAdmin: Client,
  input: { organizationId: string; connectionId: string; agentConfigId: string | null },
): Promise<void> {
  const { data: existing, error: readError } = await supabaseAdmin
    .from("instagram_connections")
    .select("id, organization_id")
    .eq("id", input.connectionId)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing || existing.organization_id !== input.organizationId) {
    throw new InstagramConnectionError(
      "That connection does not belong to your workspace.",
      "NOT_FOUND",
    );
  }

  if (input.agentConfigId) {
    const { data: agent, error: agentError } = await supabaseAdmin
      .from("agent_configs")
      .select("id, organization_id")
      .eq("id", input.agentConfigId)
      .maybeSingle();
    if (agentError) throw agentError;
    if (!agent || agent.organization_id !== input.organizationId) {
      throw new InstagramConnectionError(
        "That bot does not belong to your workspace.",
        "NOT_FOUND",
      );
    }
  }

  const { error } = await supabaseAdmin
    .from("instagram_connections")
    .update({ agent_config_id: input.agentConfigId })
    .eq("id", input.connectionId);
  if (error) throw error;
}

/** Disconnects ClickAI's access. Conversation/message history is kept, not deleted — same convention as WhatsApp's disconnect. */
export async function disconnectInstagramConnection(
  supabaseAdmin: Client,
  input: { organizationId: string; connectionId: string },
): Promise<void> {
  const { data: existing, error: readError } = await supabaseAdmin
    .from("instagram_connections")
    .select("id, organization_id")
    .eq("id", input.connectionId)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing || existing.organization_id !== input.organizationId) {
    throw new InstagramConnectionError(
      "That connection does not belong to your workspace.",
      "NOT_FOUND",
    );
  }

  const { error } = await supabaseAdmin
    .from("instagram_connections")
    .update({
      status: "disconnected",
      access_token_ciphertext: null,
      webhook_subscribed: false,
      disconnected_at: new Date().toISOString(),
    })
    .eq("id", input.connectionId);
  if (error) throw error;
}
