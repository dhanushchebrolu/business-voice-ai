/**
 * Shared HTTP/error-handling base for every Meta Graph API client in this
 * codebase — the generic request plumbing (`graph.facebook.com/{version}`,
 * bearer auth, timeout/abort, JSON parsing, Meta's `{error:{message,...}}`
 * envelope) that every product-specific client (WhatsApp, Instagram) needs
 * identically. Extracted from meta-client.server.ts (Phase 2, WhatsApp)
 * during Phase 5 so Instagram's client does not duplicate this logic —
 * per the approved Phase 5 architecture:
 *
 *   MetaGraphClientBase
 *       ├── MetaWhatsAppClient   (meta-client.server.ts)
 *       └── MetaInstagramClient  (meta-instagram-client.server.ts)
 *
 * This extraction is a pure refactor: MetaWhatsAppClient's public API,
 * request shapes, and error mapping are unchanged byte-for-byte from
 * before this file existed — meta-client.server.test.ts (Phase 2) passes
 * unmodified against it, which is the regression guard for "do not
 * unnecessarily rewrite existing WhatsApp behavior."
 *
 * Also carries the one piece of OAuth mechanics genuinely shared by both
 * products: the authorization-code exchange at GET /{v}/oauth/access_token
 * (same endpoint, same request shape, for any Meta app — WhatsApp's
 * Embedded Signup code exchange and Instagram's Facebook Login code
 * exchange both call it identically) and the long-lived-token exchange at
 * the same endpoint with grant_type=fb_exchange_token (Instagram-only in
 * this codebase today, but not WhatsApp-specific — Meta's own
 * general-purpose token-exchange mechanism for any app, well-documented
 * and stable). Only WhatsApp-specific endpoints (phone number lookup,
 * register, subscribe, send) stay in MetaWhatsAppClient; only
 * Instagram-specific endpoints (Page/IG account discovery, comment reply,
 * DM send) go in MetaInstagramClient.
 *
 * `fetchImpl` is always injectable (defaults to global fetch) — no
 * automated test in this codebase makes a real Meta API call.
 */

export class MetaApiError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export interface MetaGraphClientConfig {
  appId: string;
  appSecret: string;
  /** Graph API version, e.g. "v23.0" — no hardcoded default (see meta-config.server.ts's doc comment on why). */
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
        `Meta denied access to this asset — the granted permissions may not cover it.${suffix}`,
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

export interface MetaGraphRequestOptions {
  query?: Record<string, string> | undefined;
  body?: Record<string, unknown> | undefined;
  accessToken?: string | undefined;
}

export abstract class MetaGraphClientBase {
  protected readonly config: MetaGraphClientConfig;

  constructor(config: MetaGraphClientConfig) {
    this.config = config;
  }

  protected async request<T>(
    method: "GET" | "POST",
    path: string,
    options: MetaGraphRequestOptions = {},
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
   * Exchanges a short-lived OAuth authorization code for an access token.
   * Same endpoint/request shape for any Meta app (WhatsApp Embedded Signup
   * and Instagram Facebook Login both use it identically) — see this
   * file's module doc. appSecret is sent only here, only in this one
   * request's query string — never logged, never echoed in a thrown error.
   */
  protected async exchangeAuthorizationCodeCore(
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
   * Exchanges a short-lived (or already long-lived) user/page access token
   * for a long-lived one (grant_type=fb_exchange_token) — Meta's own
   * general token-exchange mechanism, not product-specific. Used by
   * Instagram in this codebase today (a long-lived Page/IG token is what
   * lets ClickAI act on a tenant's behalf without asking them to
   * re-authorize every ~1 hour); WhatsApp's Embedded Signup token exchange
   * already returns a long-lived Business Integration System User token
   * directly and does not need this second step.
   */
  protected async exchangeForLongLivedTokenCore(
    shortLivedToken: string,
  ): Promise<{ accessToken: string; expiresIn: number | null }> {
    const parsed = await this.request<Record<string, unknown>>("GET", "/oauth/access_token", {
      query: {
        grant_type: "fb_exchange_token",
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        fb_exchange_token: shortLivedToken,
      },
    });
    const accessToken = parsed["access_token"];
    if (typeof accessToken !== "string" || !accessToken) {
      throw new MetaApiError(
        "Meta accepted the token-exchange request but did not return an access token.",
        502,
      );
    }
    const expiresIn = typeof parsed["expires_in"] === "number" ? parsed["expires_in"] : null;
    return { accessToken, expiresIn };
  }
}
