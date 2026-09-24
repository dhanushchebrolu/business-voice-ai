/**
 * Instagram-specific Meta Graph API client — built on
 * meta-graph-client.server.ts's MetaGraphClientBase (the shared HTTP/
 * error-handling layer extracted from WhatsApp's client in Phase 5; see
 * that file's module doc for the extraction rationale and
 * meta-client.server.ts for the sibling WhatsApp client this mirrors).
 *
 * VERIFICATION STATUS (read before touching this file — same constraint as
 * meta-client.server.ts: WebFetch to developers.facebook.com is blocked in
 * this sandbox, so nothing below was confirmed against a live fetch of
 * Meta's current documentation):
 *
 *   CORROBORATED (cross-checked across multiple independent, current
 *   "Instagram API with Facebook Login" integration guides this session
 *   could search — the same standard this codebase already applied to
 *   meta-client.server.ts's WhatsApp endpoints):
 *     - GET /{v}/oauth/access_token?grant_type=fb_exchange_token&... —
 *       long-lived token exchange (in the shared base).
 *     - GET /{v}/me/accounts?fields=id,name,instagram_business_account —
 *       lists the Facebook Pages this token administers, with each Page's
 *       linked Instagram professional account id (if any). This is the
 *       standard, long-documented discovery step: a Tech Provider cannot
 *       list "Instagram accounts" directly — it lists Pages, then reads
 *       each Page's instagram_business_account field.
 *     - GET /{v}/{ig-user-id}?fields=id,username,name,profile_picture_url
 *       — basic IG professional account profile fields.
 *     - POST /{v}/{page-id}/subscribed_apps?subscribed_fields=... —
 *       subscribes the app to a Page's webhook events (the same mechanism
 *       meta-client.server.ts already uses for a WABA, applied to a Page
 *       here — Instagram messaging/comments webhooks are delivered via the
 *       linked Facebook Page's subscription, not a separate IG-only
 *       subscription endpoint, per Meta's Tech-Provider integration model).
 *
 *   NOT independently confirmed, isolated behind this client's own narrow
 *   methods so a correction never has to touch calling code:
 *     - The exact `subscribed_fields` values ("messages", "comments") this
 *       account's webhook needs — used verbatim below as the two
 *       documented Instagram webhook topics this integration actually
 *       consumes, but not re-verified live.
 *     - The exact DM-send request shape. Meta's Send API for Instagram
 *       (POST /{ig-user-id}/messages with a Messenger-Platform-shaped
 *       {recipient:{id},message:{text}} body, mirroring the well-
 *       established Messenger Send API this same request shape is
 *       modeled on) is the most consistently corroborated shape across
 *       sources, but Meta has changed Instagram Messaging API request
 *       shapes across versions before — sendDirectMessage below is
 *       therefore a thin, isolated wrapper so only this one method needs
 *       correcting if live testing shows a different shape is required.
 *     - The exact comment-reply endpoint. POST /{comment-id}/replies with
 *       {message: text} is the standard Graph API comment-reply shape used
 *       identically for Facebook Page comments and corroborated for
 *       Instagram comments in the sources this session could search, but
 *       is called out here as the one Instagram-specific endpoint this
 *       session is least confident about byte-for-byte.
 *
 * Every method is a pure request/response boundary — no tenant validation,
 * database access, or credential storage happens here (that is
 * instagram-connection.server.ts's job, mirroring whatsapp-onboarding.
 * server.ts). `fetchImpl` is always injectable; no automated test in this
 * codebase makes a real Meta API call.
 */

import { MetaGraphClientBase, MetaApiError } from "../meta/meta-graph-client.server.ts";
import type { MetaGraphClientConfig } from "../meta/meta-graph-client.server.ts";

export { MetaApiError };

export type MetaInstagramClientConfig = MetaGraphClientConfig;

export interface InstagramPageAccount {
  pageId: string;
  pageName: string | null;
  instagramBusinessAccountId: string | null;
}

export class MetaInstagramClient extends MetaGraphClientBase {
  /** Exchanges a short-lived OAuth authorization code for an access token. */
  async exchangeAuthorizationCode(
    code: string,
  ): Promise<{ accessToken: string; tokenType: string | null; expiresIn: number | null }> {
    return this.exchangeAuthorizationCodeCore(code);
  }

  /** Exchanges a short-lived token for a long-lived one (~60 days), so ClickAI does not need the tenant to re-authorize hourly. */
  async exchangeForLongLivedToken(
    shortLivedToken: string,
  ): Promise<{ accessToken: string; expiresIn: number | null }> {
    return this.exchangeForLongLivedTokenCore(shortLivedToken);
  }

  /**
   * Lists the Facebook Pages this access token administers, each with its
   * linked Instagram professional account id if one exists. This is how a
   * Tech Provider discovers "which Instagram account did the customer just
   * connect" — Meta's OAuth consent screen grants Page-level access, not a
   * direct IG-account grant.
   */
  async listPagesWithInstagramAccounts(accessToken: string): Promise<InstagramPageAccount[]> {
    const parsed = await this.request<Record<string, unknown>>("GET", "/me/accounts", {
      query: { fields: "id,name,instagram_business_account" },
      accessToken,
    });
    const data = parsed["data"];
    if (!Array.isArray(data)) return [];
    const accounts: InstagramPageAccount[] = [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const pageId = row["id"];
      if (typeof pageId !== "string" || !pageId) continue;
      const pageName = typeof row["name"] === "string" ? row["name"] : null;
      const igAccount = row["instagram_business_account"];
      const igAccountId =
        igAccount && typeof igAccount === "object"
          ? ((igAccount as Record<string, unknown>)["id"] as string | undefined)
          : undefined;
      accounts.push({
        pageId,
        pageName,
        instagramBusinessAccountId: typeof igAccountId === "string" ? igAccountId : null,
      });
    }
    return accounts;
  }

  /**
   * Reads back which Instagram professional account this is — the
   * server-side verification step, exactly like meta-client.server.ts's
   * getPhoneNumber: only succeeds if the access token is genuinely
   * authorized for this exact asset, so a tampered id can never be used to
   * attribute a different real account to a tenant than the token
   * legitimately grants.
   */
  async getInstagramAccount(
    instagramBusinessAccountId: string,
    accessToken: string,
  ): Promise<{
    id: string;
    username: string | null;
    name: string | null;
    profilePictureUrl: string | null;
  }> {
    const parsed = await this.request<Record<string, unknown>>(
      "GET",
      `/${encodeURIComponent(instagramBusinessAccountId)}`,
      { query: { fields: "id,username,name,profile_picture_url" }, accessToken },
    );
    const id = parsed["id"];
    if (typeof id !== "string" || !id) {
      throw new MetaApiError("Meta's Instagram account response did not include an id.", 502);
    }
    return {
      id,
      username: typeof parsed["username"] === "string" ? parsed["username"] : null,
      name: typeof parsed["name"] === "string" ? parsed["name"] : null,
      profilePictureUrl:
        typeof parsed["profile_picture_url"] === "string" ? parsed["profile_picture_url"] : null,
    };
  }

  /**
   * Subscribes ClickAI's app to this Page's webhook events for the
   * `messages` and `comments` topics — the two Instagram webhook fields
   * this integration actually consumes (see this file's module doc for
   * what is and is not independently confirmed about the exact field
   * names).
   */
  async subscribePageWebhook(pageId: string, accessToken: string): Promise<{ success: boolean }> {
    const parsed = await this.request<Record<string, unknown>>(
      "POST",
      `/${encodeURIComponent(pageId)}/subscribed_apps`,
      { query: { subscribed_fields: "messages,comments" }, accessToken },
    );
    return { success: parsed["success"] === true };
  }

  /**
   * Sends a direct message to an Instagram-Scoped ID (IGSID). Only
   * deliverable within Meta's messaging window rules for the conversation
   * (analogous to WhatsApp's 24-hour customer-service window — this
   * session could not independently confirm Instagram's exact window
   * policy live; a send outside it fails with a Meta-side error, which
   * this client surfaces as a normal MetaApiError rather than guessing at
   * a template-equivalent fallback that does not exist for Instagram DMs).
   */
  async sendDirectMessage(
    instagramBusinessAccountId: string,
    recipientIgsid: string,
    text: string,
    accessToken: string,
  ): Promise<{ messageId: string }> {
    const parsed = await this.request<Record<string, unknown>>(
      "POST",
      `/${encodeURIComponent(instagramBusinessAccountId)}/messages`,
      {
        body: { recipient: { id: recipientIgsid }, message: { text } },
        accessToken,
      },
    );
    const messageId = parsed["message_id"] ?? parsed["id"];
    if (typeof messageId !== "string" || !messageId) {
      throw new MetaApiError(
        "Meta accepted the direct message request but did not return a message id.",
        502,
      );
    }
    return { messageId };
  }

  /**
   * Sends a "private reply" to a comment — Meta's dedicated mechanism for
   * comment-triggered DMs (POST /{comment-id}/private_replies), distinct
   * from sendDirectMessage above: it is explicitly scoped to responding to
   * one specific public comment and, per Meta's documented behavior for
   * this endpoint (corroborated across the same class of sources as the
   * rest of this file — see the module doc's verification-status note),
   * is not subject to the normal messaging-window restriction that a
   * cold sendDirectMessage would be. This is the endpoint the comment->DM
   * automation feature (spec PART 11) uses for its "private_dm"/"ai_dm"
   * actions — not sendDirectMessage.
   */
  async sendPrivateReplyToComment(
    commentId: string,
    text: string,
    accessToken: string,
  ): Promise<{ messageId: string }> {
    const parsed = await this.request<Record<string, unknown>>(
      "POST",
      `/${encodeURIComponent(commentId)}/private_replies`,
      { body: { message: text }, accessToken },
    );
    const messageId = parsed["message_id"] ?? parsed["id"];
    if (typeof messageId !== "string" || !messageId) {
      throw new MetaApiError(
        "Meta accepted the private reply request but did not return a message id.",
        502,
      );
    }
    return { messageId };
  }

  /** Posts a public reply to a comment — used by the comment->DM automation's "public reply" action. */
  async replyToComment(
    commentId: string,
    text: string,
    accessToken: string,
  ): Promise<{ replyId: string }> {
    const parsed = await this.request<Record<string, unknown>>(
      "POST",
      `/${encodeURIComponent(commentId)}/replies`,
      { body: { message: text }, accessToken },
    );
    const replyId = parsed["id"];
    if (typeof replyId !== "string" || !replyId) {
      throw new MetaApiError("Meta accepted the comment reply but did not return a reply id.", 502);
    }
    return { replyId };
  }
}
