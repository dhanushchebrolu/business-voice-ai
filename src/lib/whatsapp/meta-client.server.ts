/**
 * WhatsApp-specific Meta Graph API client — the only place in this
 * codebase that talks to WhatsApp Cloud API endpoints. Generic HTTP/error
 * handling now lives in meta-graph-client.server.ts's MetaGraphClientBase
 * (extracted in Phase 5 so Instagram's client can share it — see that
 * file's module doc for the extraction rationale). This file's own public
 * API, request shapes, and error mapping are unchanged from before that
 * extraction: meta-client.server.test.ts (Phase 2) passes unmodified.
 *
 * VERIFICATION STATUS (read before touching this file): WebFetch is fully
 * blocked in this environment for every external domain, including
 * developers.facebook.com itself — this session could not fetch and read
 * a live Meta doc page directly. The endpoint shapes below come from
 * WebSearch snippets cross-checked across Meta's own search-indexed doc
 * text and several independent Tech Provider integration guides
 * (Twilio/Infobip/360dialog), not a byte-for-byte read of the primary
 * source. Specifically verified this way, with multiple corroborating
 * sources:
 *   - GET /{v}/oauth/access_token?client_id=&client_secret=&code= returns
 *     a Business Integration System User access token directly (no
 *     separate long-lived-token exchange step, unlike the older user-token
 *     OAuth flow).
 *   - GET /{v}/{phone-number-id}?fields=... reads phone number metadata,
 *     scoped by whatever the bearer token is authorized for.
 *   - POST /{v}/{phone-number-id}/register registers the number for
 *     Cloud API messaging with a 6-digit two-step-verification PIN,
 *     required within 14 days of Embedded Signup completing.
 *   - POST /{v}/{waba-id}/subscribed_apps with an empty body subscribes
 *     ClickAI's app (via the callback URL already configured once in the
 *     Meta App Dashboard) to that WABA's webhook events — no
 *     per-connection override_callback_uri needed for a single shared
 *     webhook route.
 * NOT independently confirmed: the exact current Graph API version number
 * (see meta-config.server.ts's doc comment on graphApiVersion — this is
 * why it is a required, explicitly-configured value with no hardcoded
 * default rather than a guess), and the byte-for-byte JSON field names of
 * the browser-side FB.login() postMessage/session-info event (this file
 * only implements the server-side exchange, which starts from a `code`
 * string the frontend already extracted — it does not parse that event
 * itself, so this gap does not affect this file's correctness, only the
 * not-yet-built frontend component in a later phase).
 *
 * Every function here is a pure request/response boundary: it builds one
 * request, sends it, and normalizes the response or error. No tenant
 * validation, database access, or credential storage happens in this file
 * — that is whatsapp-onboarding.server.ts's job. `fetchImpl` is always
 * injectable so tests can exercise every branch (success, 4xx/5xx,
 * timeout) without a real network call — Phase 2's explicit requirement
 * is that automated tests never make a real Meta API call.
 *
 * appSecret is placed only in the one token-exchange request's query
 * string, is never logged, and is never included in any thrown error
 * message — every error path below is built from Meta's own response body
 * or a fixed safe string, never from the request URL.
 *
 * Phase 4 addition: sendTextMessage/sendTemplateMessage, POST
 * /{v}/{phone-number-id}/messages. This is the WhatsApp Cloud API's core,
 * most fundamental endpoint — the same verification-status caveat above
 * applies (no live fetch of developers.facebook.com in this session), but
 * this exact request/response shape (messaging_product: "whatsapp",
 * type: "text"|"template", a `messages: [{ id: "wamid...." }]` response
 * array) is corroborated across every independent WhatsApp Cloud API
 * integration guide this session could search, with materially higher
 * corroborating consistency than the narrower onboarding endpoints above.
 */

import { MetaGraphClientBase, MetaApiError } from "../meta/meta-graph-client.server.ts";
import type { MetaGraphClientConfig } from "../meta/meta-graph-client.server.ts";

export { MetaApiError };

export type MetaWhatsAppClientConfig = MetaGraphClientConfig;

export class MetaWhatsAppClient extends MetaGraphClientBase {
  /**
   * Exchanges the short-lived authorization code Embedded Signup v4
   * returned to the browser for a Business Integration System User access
   * token, scoped to exactly the WhatsApp assets the customer granted
   * during signup.
   */
  async exchangeAuthorizationCode(
    code: string,
  ): Promise<{ accessToken: string; tokenType: string | null; expiresIn: number | null }> {
    return this.exchangeAuthorizationCodeCore(code);
  }

  /**
   * Reads phone number metadata. This is the server-side verification
   * step: the browser tells us which phone_number_id the customer
   * connected, but this call is what actually proves it — it only
   * succeeds if the exchanged access token is genuinely authorized for
   * that exact asset. A client-tampered phone_number_id simply fails here
   * (403/404), it can never be used to attribute a different real number
   * to this tenant than what the token legitimately grants.
   */
  async getPhoneNumber(
    phoneNumberId: string,
    accessToken: string,
  ): Promise<{
    id: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    qualityRating: string | null;
  }> {
    const parsed = await this.request<Record<string, unknown>>(
      "GET",
      `/${encodeURIComponent(phoneNumberId)}`,
      {
        query: { fields: "id,display_phone_number,verified_name,quality_rating" },
        accessToken,
      },
    );
    const id = parsed["id"];
    if (typeof id !== "string" || !id) {
      throw new MetaApiError("Meta's phone number response did not include an id.", 502);
    }
    return {
      id,
      displayPhoneNumber:
        typeof parsed["display_phone_number"] === "string" ? parsed["display_phone_number"] : null,
      verifiedName: typeof parsed["verified_name"] === "string" ? parsed["verified_name"] : null,
      qualityRating: typeof parsed["quality_rating"] === "string" ? parsed["quality_rating"] : null,
    };
  }

  /**
   * Registers the phone number for Cloud API messaging with a ClickAI-
   * generated 6-digit two-step-verification PIN. Must happen within 14
   * days of Embedded Signup completing (Meta's own requirement — this
   * client does not enforce that window itself; the caller is responsible
   * for calling this immediately after onboarding, not deferring it).
   */
  async registerPhoneNumber(
    phoneNumberId: string,
    pin: string,
    accessToken: string,
  ): Promise<{ success: boolean }> {
    const parsed = await this.request<Record<string, unknown>>(
      "POST",
      `/${encodeURIComponent(phoneNumberId)}/register`,
      { body: { messaging_product: "whatsapp", pin }, accessToken },
    );
    return { success: parsed["success"] === true };
  }

  /**
   * Subscribes ClickAI's app to this WABA's webhook events. An empty body
   * is sufficient when the app-level callback URL is already configured
   * once in the Meta App Dashboard (ClickAI's single shared route,
   * https://clickai.in/api/public/webhooks/whatsapp, disambiguated by
   * phone_number_id in each incoming payload) — no per-connection
   * override_callback_uri.
   */
  async subscribeApp(wabaId: string, accessToken: string): Promise<{ success: boolean }> {
    const parsed = await this.request<Record<string, unknown>>(
      "POST",
      `/${encodeURIComponent(wabaId)}/subscribed_apps`,
      { accessToken },
    );
    return { success: parsed["success"] === true };
  }

  /** Sends a free-form text message. Only deliverable within Meta's 24-hour customer-service window (i.e. the customer messaged this number recently) — outside that window Meta itself rejects the send; use sendTemplateMessage instead. */
  async sendTextMessage(
    phoneNumberId: string,
    to: string,
    body: string,
    accessToken: string,
  ): Promise<{ messageId: string }> {
    const parsed = await this.request<Record<string, unknown>>(
      "POST",
      `/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        body: { messaging_product: "whatsapp", to, type: "text", text: { body } },
        accessToken,
      },
    );
    return extractMessageId(parsed);
  }

  /** Sends a pre-approved Message Template — the only send path Meta allows outside the 24-hour customer-service window. templateName/languageCode/bodyParams must reference a template already approved for this WABA in Meta Business Manager; this client does not (and cannot) create or verify templates. */
  async sendTemplateMessage(
    phoneNumberId: string,
    to: string,
    templateName: string,
    languageCode: string,
    bodyParams: string[] | undefined,
    accessToken: string,
  ): Promise<{ messageId: string }> {
    const parsed = await this.request<Record<string, unknown>>(
      "POST",
      `/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        body: {
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: templateName,
            language: { code: languageCode },
            ...(bodyParams && bodyParams.length > 0
              ? {
                  components: [
                    {
                      type: "body",
                      parameters: bodyParams.map((text) => ({ type: "text", text })),
                    },
                  ],
                }
              : {}),
          },
        },
        accessToken,
      },
    );
    return extractMessageId(parsed);
  }
}

function extractMessageId(parsed: Record<string, unknown>): { messageId: string } {
  const messages = parsed["messages"];
  const first =
    Array.isArray(messages) && messages.length > 0 && typeof messages[0] === "object"
      ? (messages[0] as Record<string, unknown>)
      : undefined;
  const id = first?.["id"];
  if (typeof id !== "string" || !id) {
    throw new MetaApiError("Meta accepted the send request but did not return a message id.", 502);
  }
  return { messageId: id };
}
