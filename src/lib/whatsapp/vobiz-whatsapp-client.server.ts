/**
 * Vobiz WhatsApp Business API client (Vobiz is ClickAI's WhatsApp BSP).
 *
 * Contract sources, in order of confidence:
 *   1. Vobiz's own published skill for its WhatsApp API
 *      (github.com/vobiz-ai/vobiz-mcp-server, skills/vobiz-whatsapp/SKILL.md):
 *      base URL `https://api.vobiz.ai/api/v1/messaging`, `X-Auth-ID` +
 *      `X-Auth-Token` headers, the three channel onboarding modes
 *      (`bring_your_own`, `buy_from_vobiz`, `embedded_signup`), the BYON
 *      verify/confirm/create-channel fields, the send request
 *      (`channel_id`, `waba_id`, `to` with a leading `+`, `type`, `text.body`;
 *      `template.name`, `template.language.code`, `components[]`) and its
 *      `201` Message (`id`, `status: "pending"`, `meta_message_id` = the
 *      wamid, `null` until Meta accepts), template sync, and the webhook
 *      events/signature (whatsapp-vobiz-webhook.server.ts).
 *   2. Vobiz docs pages as quoted by search results (vobiz.ai/docs/whatsapp/
 *      api/channels, api/numbers): `number_order_id` (UUID of a completed
 *      order) for `buy_from_vobiz`, `phone_number_id` required unless
 *      buying, the order object (`id`, `status` pending/completed/failed/
 *      cancelled, `selected_phone_number`, `failure_reason`), `POST
 *      /channels/whatsapp/embedded-signup` with the Meta OAuth `code` and
 *      `waba_id`, and the channel object (`id`, `waba_id`, `phone_number_id`,
 *      `phone_number`, `number_onboarding_mode`, `number_order_id`).
 * Vobiz's documentation hosts are not reachable from the environment this
 * was written in, so response bodies that were never seen in full are parsed
 * defensively (see each method): an unexpected shape becomes a clear error,
 * never an assumed success.
 *
 * Every function here is a pure request/response boundary: no tenant logic,
 * no database. Credentials are only ever placed in request headers; the
 * Meta system-user token passed through for BYON is only ever placed in
 * that one request body. Neither is logged or included in an error.
 */

export const DEFAULT_VOBIZ_BASE_URL = "https://api.vobiz.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 15_000;

export type VobizErrorKind = "http" | "timeout" | "network" | "invalid_response";

export class VobizApiError extends Error {
  kind: VobizErrorKind;
  /** HTTP status Vobiz answered with; null when there was no response. */
  status: number | null;
  constructor(message: string, kind: VobizErrorKind, status: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
  /** Vobiz answered and refused: never worth repeating unchanged. */
  get isRejection(): boolean {
    return this.kind === "http" && this.status !== null && this.status < 500 && this.status !== 429;
  }
  /** Vobiz answered 429/5xx: it did not act, a later retry is safe. */
  get isRetryable(): boolean {
    return (
      this.kind === "http" && this.status !== null && (this.status === 429 || this.status >= 500)
    );
  }
}

export interface VobizClientConfig {
  authId: string;
  authToken: string;
  /** e.g. https://api.vobiz.ai/api/v1 (VOBIZ_BASE_URL); `/messaging` is appended. */
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export type NumberOnboardingMode = "bring_your_own" | "buy_from_vobiz" | "embedded_signup";

export interface VobizChannel {
  id: string;
  wabaId: string | null;
  phoneNumberId: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  numberOnboardingMode: string | null;
  numberOrderId: string | null;
}

export type VobizOrderStatus = "pending" | "completed" | "failed" | "cancelled";

export interface VobizNumberOrder {
  id: string;
  status: VobizOrderStatus | string;
  selectedPhoneNumber: string | null;
  failureReason: string | null;
}

export interface VobizSentMessage {
  /** Vobiz's own message id. */
  id: string;
  status: string | null;
  /** The WhatsApp wamid, or null until Meta has accepted the message. */
  metaMessageId: string | null;
}

export interface VobizTemplate {
  id: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string | null;
}

export type VobizSendPayload =
  | { kind: "text"; body: string }
  | { kind: "template"; name: string; languageCode: string; bodyParams?: string[] | undefined };

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
/** The object itself, or the same object nested under a common envelope key. */
function unwrap(body: unknown, keys: string[]): Json | null {
  if (!isRecord(body)) return null;
  for (const key of keys) if (isRecord(body[key])) return body[key] as Json;
  return body;
}
/** An array body, or the first array under a common envelope key. */
function unwrapList(body: unknown, keys: string[]): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return [];
  for (const key of keys) if (Array.isArray(body[key])) return body[key] as unknown[];
  return [];
}

/** A short, credential-free reason from a Vobiz error body, or a fixed message by status. */
function errorMessage(status: number, body: unknown): string {
  let detail: string | null = null;
  if (isRecord(body)) {
    const candidates = [body["message"], body["error"], body["detail"], body["error_message"]];
    if (isRecord(body["error"])) candidates.unshift((body["error"] as Json)["message"]);
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) {
        detail = c.trim();
        break;
      }
    }
  }
  if (detail) {
    // Never echo anything that looks like a Meta token or our own credentials back.
    detail = detail.replace(/EAA[A-Za-z0-9]{10,}/g, "[redacted]").slice(0, 200);
    return `Vobiz: ${detail}`;
  }
  if (status === 401 || status === 403) return "Vobiz rejected ClickAI's API credentials.";
  if (status === 404) return "Vobiz could not find that resource.";
  if (status === 409) return "Vobiz reports this already exists.";
  if (status === 429) return "Vobiz is rate limiting requests. Please try again shortly.";
  if (status >= 500) return "Vobiz is temporarily unavailable. Please try again.";
  return "Vobiz rejected the request.";
}

export function parseChannel(body: unknown): VobizChannel | null {
  const c = unwrap(body, ["channel", "data"]);
  if (!c) return null;
  const id = str(c["id"]);
  if (!id) return null;
  return {
    id,
    wabaId: str(c["waba_id"]),
    phoneNumberId: str(c["phone_number_id"]),
    phoneNumber: str(c["phone_number"]),
    displayName: str(c["display_name"]),
    numberOnboardingMode: str(c["number_onboarding_mode"]),
    numberOrderId: str(c["number_order_id"]),
  };
}

export function parseOrder(body: unknown): VobizNumberOrder | null {
  const o = unwrap(body, ["order", "data"]);
  if (!o) return null;
  const id = str(o["id"]);
  const status = str(o["status"]);
  if (!id || !status) return null;
  return {
    id,
    status,
    selectedPhoneNumber: str(o["selected_phone_number"]) ?? str(o["phone_number"]),
    failureReason: str(o["failure_reason"]),
  };
}

const E164 = /^\+?[1-9]\d{6,14}$/;

/**
 * The availability response's field names were never seen in full, so this
 * collects every E.164-looking string from the returned items (one level of
 * nesting) instead of trusting one field name. Nothing else is inferred.
 */
export function parseAvailableNumbers(body: unknown): string[] {
  const items = unwrapList(body, ["numbers", "data", "available_numbers", "results", "items"]);
  const found = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (typeof v === "string") {
      if (E164.test(v)) found.add(v.startsWith("+") ? v : `+${v}`);
      return;
    }
    if (depth > 1 || !isRecord(v)) return;
    for (const value of Object.values(v)) visit(value, depth + 1);
  };
  for (const item of items) visit(item, 0);
  return [...found].slice(0, 50);
}

export function parseTemplates(body: unknown): { templates: VobizTemplate[]; skipped: number } {
  const items = unwrapList(body, ["templates", "data", "items", "results"]);
  const templates: VobizTemplate[] = [];
  let skipped = 0;
  for (const item of items) {
    if (!isRecord(item)) {
      skipped++;
      continue;
    }
    const name = str(item["name"]);
    const lang = item["language"];
    const language = str(lang) ?? (isRecord(lang) ? str(lang["code"]) : null);
    const category = str(item["category"]);
    const status = str(item["status"]);
    if (!name || !language || !category || !status) {
      skipped++;
      continue;
    }
    let bodyText = str(item["body_text"]) ?? str(item["body"]);
    if (!bodyText && Array.isArray(item["components"])) {
      for (const comp of item["components"]) {
        if (isRecord(comp) && String(comp["type"]).toUpperCase() === "BODY") {
          bodyText = str(comp["text"]);
          break;
        }
      }
    }
    templates.push({
      id: str(item["id"]),
      name,
      language,
      category: category.toUpperCase(),
      status: status.toUpperCase(),
      bodyText,
    });
  }
  return { templates, skipped };
}

export class VobizWhatsAppClient {
  private readonly config: VobizClientConfig;
  constructor(config: VobizClientConfig) {
    this.config = config;
  }

  private url(path: string): string {
    const base = (this.config.baseUrl ?? DEFAULT_VOBIZ_BASE_URL).replace(/\/+$/, "");
    return `${base}/messaging${path}`;
  }

  /** One request. Throws VobizApiError; never includes credentials in a message. */
  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Json,
  ): Promise<unknown> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(this.url(path), {
        method,
        headers: {
          "X-Auth-ID": this.config.authId,
          "X-Auth-Token": this.config.authToken,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new VobizApiError("Vobiz did not respond in time.", "timeout");
      }
      throw new VobizApiError("Could not reach Vobiz.", "network");
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) throw new VobizApiError(errorMessage(res.status, parsed), "http", res.status);
    return parsed;
  }

  private channelOrThrow(body: unknown): VobizChannel {
    const channel = parseChannel(body);
    if (!channel)
      throw new VobizApiError("Vobiz returned an unexpected channel response.", "invalid_response");
    return channel;
  }

  /** BYON step 1: Vobiz sends an OTP to the number (`sms` or `voice`). */
  async startByonVerification(input: {
    phoneNumber: string;
    method: "sms" | "voice";
  }): Promise<void> {
    await this.request("POST", "/numbers/whatsapp/bring-your-own/verify", {
      phone_number: input.phoneNumber,
      verification_method: input.method,
    });
  }

  /** BYON step 2: confirm the OTP the business received. */
  async confirmByonVerification(input: { phoneNumber: string; otpCode: string }): Promise<void> {
    await this.request("POST", "/numbers/whatsapp/bring-your-own/confirm", {
      phone_number: input.phoneNumber,
      otp_code: input.otpCode,
    });
  }

  /** BYON step 3 / buy step 3: create the WhatsApp channel. */
  async createChannel(
    input:
      | {
          mode: "bring_your_own";
          wabaId: string;
          phoneNumberId: string;
          phoneNumber: string;
          accessToken: string;
          displayName?: string | undefined;
        }
      | {
          mode: "buy_from_vobiz";
          wabaId: string;
          numberOrderId: string;
          phoneNumber: string;
          displayName?: string | undefined;
        },
  ): Promise<VobizChannel> {
    const body: Json =
      input.mode === "bring_your_own"
        ? {
            number_onboarding_mode: "bring_your_own",
            waba_id: input.wabaId,
            phone_number_id: input.phoneNumberId,
            phone_number: input.phoneNumber,
            number_provider: "meta_direct",
            access_token: input.accessToken,
          }
        : {
            number_onboarding_mode: "buy_from_vobiz",
            waba_id: input.wabaId,
            number_order_id: input.numberOrderId,
            phone_number: input.phoneNumber,
          };
    if (input.displayName) body["display_name"] = input.displayName;
    return this.channelOrThrow(await this.request("POST", "/channels/whatsapp", body));
  }

  /** Embedded Signup: hand Vobiz the Meta OAuth code from the browser popup. */
  async completeEmbeddedSignup(input: {
    code: string;
    wabaId: string;
    phoneNumberId?: string | undefined;
  }): Promise<VobizChannel> {
    const body: Json = { code: input.code, waba_id: input.wabaId };
    if (input.phoneNumberId) body["phone_number_id"] = input.phoneNumberId;
    return this.channelOrThrow(
      await this.request("POST", "/channels/whatsapp/embedded-signup", body),
    );
  }

  /** All WhatsApp channels on ClickAI's Vobiz account (used to recover a channel created by an interrupted request). */
  async listChannels(): Promise<VobizChannel[]> {
    const body = await this.request("GET", "/channels/whatsapp");
    return unwrapList(body, ["channels", "data", "items", "results"])
      .map((c) => parseChannel(c))
      .filter((c): c is VobizChannel => c !== null);
  }

  async deleteChannel(channelId: string): Promise<void> {
    await this.request("DELETE", `/channels/whatsapp/${encodeURIComponent(channelId)}`);
  }

  async searchAvailableNumbers(input: { country: string }): Promise<string[]> {
    const qs = new URLSearchParams({ country: input.country });
    return parseAvailableNumbers(
      await this.request("GET", `/numbers/whatsapp/availability?${qs.toString()}`),
    );
  }

  /** Buys a number (Vobiz debits the account). Callers must guard against repeats. */
  async createNumberOrder(input: { phoneNumber: string }): Promise<VobizNumberOrder> {
    const order = parseOrder(
      await this.request("POST", "/numbers/whatsapp/orders", { phone_number: input.phoneNumber }),
    );
    if (!order)
      throw new VobizApiError("Vobiz returned an unexpected order response.", "invalid_response");
    return order;
  }

  async sendMessage(input: {
    channelId: string;
    wabaId: string;
    /** E.164; a leading `+` is added if missing. */
    to: string;
    payload: VobizSendPayload;
  }): Promise<VobizSentMessage> {
    const to = input.to.startsWith("+") ? input.to : `+${input.to}`;
    const body: Json = { channel_id: input.channelId, waba_id: input.wabaId, to };
    if (input.payload.kind === "text") {
      body["type"] = "text";
      body["text"] = { body: input.payload.body };
    } else {
      const template: Json = {
        name: input.payload.name,
        language: { code: input.payload.languageCode },
      };
      if (input.payload.bodyParams && input.payload.bodyParams.length > 0) {
        template["components"] = [
          {
            type: "body",
            parameters: input.payload.bodyParams.map((text) => ({ type: "text", text })),
          },
        ];
      }
      body["type"] = "template";
      body["template"] = template;
    }
    const res = unwrap(await this.request("POST", "/messages", body), ["message", "data"]);
    const id = res ? str(res["id"]) : null;
    if (!res || !id) {
      // Accepted (2xx) but no message id: the outcome is unknown, not a success.
      throw new VobizApiError(
        "Vobiz accepted the request but returned no message id.",
        "invalid_response",
      );
    }
    return { id, status: str(res["status"]), metaMessageId: str(res["meta_message_id"]) };
  }

  /** Pulls the latest template statuses from Meta into Vobiz (`{ synced: n }`). */
  async syncTemplates(channelId: string): Promise<void> {
    await this.request("POST", `/channels/${encodeURIComponent(channelId)}/templates/sync`);
  }

  async listTemplates(channelId: string): Promise<{ templates: VobizTemplate[]; skipped: number }> {
    return parseTemplates(
      await this.request("GET", `/channels/${encodeURIComponent(channelId)}/templates`),
    );
  }
}

export interface VobizWhatsAppConfig {
  authId: string;
  authToken: string;
  baseUrl: string | undefined;
}

/**
 * The same Vobiz account credentials the voice integration uses
 * (VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN / optional VOBIZ_BASE_URL), read at call
 * time and never cached or logged. Null when either credential is missing.
 */
export function resolveVobizWhatsAppConfig(): VobizWhatsAppConfig | null {
  const authId = process.env["VOBIZ_AUTH_ID"];
  const authToken = process.env["VOBIZ_AUTH_TOKEN"];
  if (!authId || !authToken) return null;
  return { authId, authToken, baseUrl: process.env["VOBIZ_BASE_URL"] || undefined };
}

/** Names (never values) of missing Vobiz WhatsApp settings, for logs and the admin checklist. */
export function missingVobizWhatsAppSettings(): string[] {
  return ["VOBIZ_AUTH_ID", "VOBIZ_AUTH_TOKEN", "VOBIZ_WHATSAPP_WEBHOOK_SECRET"].filter(
    (name) => !process.env[name],
  );
}
