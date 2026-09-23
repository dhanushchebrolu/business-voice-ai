/**
 * Centralized HTTP client for Meta's WhatsApp Business Platform Graph API
 * — the only place in this codebase that talks to graph.facebook.com.
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
 */

export class MetaApiError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export interface MetaWhatsAppClientConfig {
  appId: string;
  appSecret: string;
  /** Graph API version, e.g. "v23.0" — see meta-config.server.ts's doc comment on why this has no hardcoded default. */
  graphApiVersion: string;
  /** Defaults to global fetch — injectable so tests never hit a real network. */
  fetchImpl?: typeof fetch | undefined;
  /** Defaults to 15000ms. */
  timeoutMs?: number | undefined;
}

const GRAPH_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 15_000;

function asPlainObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Meta's error envelope is consistently `{ error: { message, type, code,
 * error_subcode?, fbtrace_id? } }`. Extracts just `message`, truncated —
 * this is Meta's own text describing what was wrong with OUR request, not
 * a reflection of anything secret we sent, so it is safe to surface, but
 * still capped in length defensively.
 */
function extractSafeErrorMessage(parsed: unknown): string | undefined {
  const obj = asPlainObject(parsed);
  const errorObj = asPlainObject(obj?.["error"]);
  const message = errorObj?.["message"];
  return typeof message === "string" && message ? message.slice(0, 300) : undefined;
}

function mapErrorResponse(status: number, parsed: unknown, rawText: string): MetaApiError {
  const safeDetail = extractSafeErrorMessage(parsed) ?? rawText.slice(0, 200);
  const suffix = safeDetail ? ` ${safeDetail}` : "";
  switch (status) {
    case 400:
      return new MetaApiError(`Meta rejected the request as invalid.${suffix}`, 400);
    case 401:
      return new MetaApiError("Meta rejected the credential as invalid or expired.", 401);
    case 403:
      return new MetaApiError(
        `Meta denied access to this WhatsApp asset — the granted permissions may not cover it.${suffix}`,
        403,
      );
    case 429:
      return new MetaApiError("Meta rate-limited this request. Please retry shortly.", 429);
    case 500:
    case 502:
    case 503:
    case 504:
      return new MetaApiError("Meta is temporarily unavailable. Please retry.", 503);
    default:
      return new MetaApiError(`Meta returned an unexpected error (${status}).${suffix}`, status);
  }
}

interface RequestOptions {
  query?: Record<string, string> | undefined;
  body?: Record<string, unknown> | undefined;
  accessToken?: string | undefined;
}

export class MetaWhatsAppClient {
  private readonly config: MetaWhatsAppClientConfig;

  constructor(config: MetaWhatsAppClientConfig) {
    this.config = config;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const url = new URL(`${GRAPH_BASE_URL}/${this.config.graphApiVersion}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {};
    if (options.accessToken) headers["Authorization"] = `Bearer ${options.accessToken}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new MetaApiError("Meta did not respond in time. Please retry.", 503);
      }
      throw new MetaApiError("Could not reach Meta. Please retry.", 503);
    } finally {
      clearTimeout(timer);
    }

    const rawText = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = rawText ? JSON.parse(rawText) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!res.ok) throw mapErrorResponse(res.status, parsed, rawText);
    return parsed as T;
  }

  /**
   * Exchanges the short-lived authorization code Embedded Signup v4
   * returned to the browser for a Business Integration System User access
   * token, scoped to exactly the WhatsApp assets the customer granted
   * during signup. appSecret is sent only here, only in this one request's
   * query string — never logged, never echoed in a thrown error.
   */
  async exchangeAuthorizationCode(
    code: string,
  ): Promise<{ accessToken: string; tokenType: string | null; expiresIn: number | null }> {
    const parsed = await this.request<Record<string, unknown>>("GET", "/oauth/access_token", {
      query: { client_id: this.config.appId, client_secret: this.config.appSecret, code },
    });
    const accessToken = parsed["access_token"];
    if (typeof accessToken !== "string" || !accessToken) {
      throw new MetaApiError(
        "Meta accepted the authorization code but did not return an access token.",
        502,
      );
    }
    const tokenType = typeof parsed["token_type"] === "string" ? parsed["token_type"] : null;
    const expiresIn = typeof parsed["expires_in"] === "number" ? parsed["expires_in"] : null;
    return { accessToken, tokenType, expiresIn };
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
   * Registers the phone number for Cloud API messaging with a Klyro-
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
}
