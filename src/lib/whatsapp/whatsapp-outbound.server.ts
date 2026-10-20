/**
 * Server-side WhatsApp sending for conversations (AI replies and staff
 * replies). Payment notifications keep their own path
 * (whatsapp-payments.server.ts); both send through MetaWhatsAppClient.
 *
 * Rules enforced here, server-side, for every send:
 *   - Customer-service window: free-form text only within 24 hours of the
 *     customer's latest inbound message (whatsapp_conversations.
 *     last_inbound_at). Outside it, only a pre-approved Message Template.
 *   - Opt-in: a business-initiated template (outside the window) is sent
 *     only to a number whose latest transactional consent is an opt-in and
 *     that isn't suppressed (whatsapp-consent.server.ts).
 *     Inside the window the customer started the conversation, so a reply
 *     needs no separate opt-in.
 *   - Tenant scoping: the conversation, its connection and its contact are
 *     all read with the caller's organization id, which callers must take
 *     from server-side state (a session's membership, a connection row) —
 *     never from the browser.
 *   - Throughput: at most OUTBOUND_PER_MINUTE_PER_CONVERSATION sends per
 *     conversation per minute (a runaway loop or a stuck button can't spam
 *     a customer); Meta's own 429s are retried with backoff.
 *   - Reliability: a 'queued' row is written before calling Meta; each send
 *     has a timeout and at most WHATSAPP_SEND_MAX_ATTEMPTS attempts, retried
 *     only when Meta answered 429 or 5xx — never for a rejection, and never
 *     when the outcome is unknown (a timeout, a dropped connection, or a
 *     2xx without a message id), since Meta may already have delivered it
 *     and WhatsApp has no idempotency key. The row ends 'sent' (with Meta's
 *     message id) or 'failed' (with a customer-safe reason).
 *
 * The access token is decrypted only here, held in memory for the request,
 * and never logged, stored in plaintext or returned.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { MetaWhatsAppClient, MetaApiError } from "./meta-client.server.ts";
import { resolveMetaWhatsAppConfig } from "./meta-config.server.ts";
import { decryptCredential, CredentialCryptoError } from "./whatsapp-token-crypto.server.ts";
import { checkSendPermission, latestConsent } from "./whatsapp-consent.server.ts";
import { TEMPLATE_COLUMNS, templateProblem } from "./whatsapp-templates.server.ts";

type Client = SupabaseClient<Database>;

export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WHATSAPP_SEND_MAX_ATTEMPTS = 3;
export const OUTBOUND_PER_MINUTE_PER_CONVERSATION = 10;
const SEND_TIMEOUT_MS = 15_000;
const RETRY_BASE_DELAY_MS = 400;

export type OutboundPayload =
  | { kind: "text"; body: string }
  | { kind: "template"; name: string; languageCode: string; bodyParams?: string[] | undefined };

export interface OutboundConnection {
  id: string;
  organization_id: string;
  phone_number_id: string;
  access_token_ciphertext: string | null;
  status: string;
}

export interface DeliveryDeps {
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isWithinCustomerServiceWindow(lastInboundAt: string | null, now: Date): boolean {
  if (!lastInboundAt) return false;
  const at = new Date(lastInboundAt).getTime();
  return Number.isFinite(at) && now.getTime() - at < WHATSAPP_WINDOW_MS;
}

/** Retry only when Meta actually answered with 429/5xx (so it didn't accept the message). */
function isRetryable(err: unknown, httpStatus: number | null): boolean {
  return (
    err instanceof MetaApiError && httpStatus !== null && (httpStatus === 429 || httpStatus >= 500)
  );
}

/**
 * Sends the payload for an already-written 'queued' row and records the
 * outcome on that row. Bounded retries for transient failures only.
 */
export async function deliverWhatsAppMessage(
  supabaseAdmin: Client,
  input: {
    messageRowId: string;
    connection: OutboundConnection;
    to: string;
    payload: OutboundPayload;
  },
  deps: DeliveryDeps = {},
): Promise<
  | { outcome: "sent"; waMessageId: string }
  | { outcome: "failed"; error: string; retryable: boolean; ambiguous?: boolean }
> {
  const fail = async (error: string, attempts: number, retryable = false) => {
    const { error: writeError } = await supabaseAdmin
      .from("whatsapp_messages")
      .update({ status: "failed", error_message: error, attempts })
      .eq("id", input.messageRowId);
    if (writeError) {
      console.error("whatsapp_outbound:failed_status_unrecorded", {
        messageRowId: input.messageRowId,
      });
    }
    return { outcome: "failed" as const, error, retryable };
  };
  /**
   * The request may have reached Meta (no response, or a 2xx without a
   * message id). The row stays 'queued' — still a live message for its
   * idempotency key — so no later attempt with the same key can send it
   * again; the error says why it was never confirmed.
   */
  const unknownOutcome = async (error: string, attempts: number) => {
    const { error: writeError } = await supabaseAdmin
      .from("whatsapp_messages")
      .update({
        error_message: `Delivery outcome unknown (${error}); not retried, Meta may already have delivered it.`,
        attempts,
      })
      .eq("id", input.messageRowId);
    if (writeError) {
      console.error("whatsapp_outbound:unknown_outcome_unrecorded", {
        messageRowId: input.messageRowId,
      });
    }
    return { outcome: "failed" as const, error, retryable: false, ambiguous: true };
  };

  const config = resolveMetaWhatsAppConfig();
  if (!config) return fail("WhatsApp is not configured on this deployment.", 0, true);
  if (input.connection.status !== "connected") {
    return fail("This WhatsApp number is not connected.", 0);
  }
  let accessToken: string;
  try {
    if (!input.connection.access_token_ciphertext) {
      throw new CredentialCryptoError("No credential stored.");
    }
    accessToken = decryptCredential(input.connection.access_token_ciphertext);
  } catch {
    return fail("Could not decrypt the stored WhatsApp credential.", 0);
  }

  // Records Meta's HTTP status for the latest attempt (null: no response).
  let httpStatus: number | null = null;
  const baseFetch = deps.fetchImpl ?? fetch;
  const trackingFetch: typeof fetch = async (...args) => {
    httpStatus = null;
    const res = await baseFetch(...args);
    httpStatus = res.status;
    return res;
  };
  const client = new MetaWhatsAppClient({
    appId: config.appId,
    appSecret: config.appSecret,
    graphApiVersion: config.graphApiVersion,
    fetchImpl: trackingFetch,
    timeoutMs: SEND_TIMEOUT_MS,
  });
  const sleep = deps.sleep ?? defaultSleep;

  let lastError = "Unknown WhatsApp send error.";
  for (let attempt = 1; attempt <= WHATSAPP_SEND_MAX_ATTEMPTS; attempt++) {
    try {
      const { messageId } =
        input.payload.kind === "text"
          ? await client.sendTextMessage(
              input.connection.phone_number_id,
              input.to,
              input.payload.body,
              accessToken,
            )
          : await client.sendTemplateMessage(
              input.connection.phone_number_id,
              input.to,
              input.payload.name,
              input.payload.languageCode,
              input.payload.bodyParams,
              accessToken,
            );
      const { error: writeError } = await supabaseAdmin
        .from("whatsapp_messages")
        .update({
          status: "sent",
          wa_message_id: messageId,
          attempts: attempt,
          error_message: null,
        })
        .eq("id", input.messageRowId);
      if (writeError) {
        // Delivered by Meta, but not recorded: say so in the logs (ids only).
        console.error("whatsapp_outbound:sent_but_unrecorded", {
          messageRowId: input.messageRowId,
          waMessageId: messageId,
        });
      }
      return { outcome: "sent", waMessageId: messageId };
    } catch (err) {
      lastError = err instanceof MetaApiError ? err.message : "Unknown WhatsApp send error.";
      if (!isRetryable(err, httpStatus) || attempt === WHATSAPP_SEND_MAX_ATTEMPTS) {
        console.warn("whatsapp_outbound:send_failed", {
          messageRowId: input.messageRowId,
          attempt,
          status: httpStatus,
        });
        const status: number | null = httpStatus;
        if (status === null || (status >= 200 && status < 300)) {
          return unknownOutcome(lastError, attempt);
        }
        // Retryable later only when Meta answered 429/5xx: it didn't accept the message.
        return fail(lastError, attempt, isRetryable(err, status));
      }
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  return fail(lastError, WHATSAPP_SEND_MAX_ATTEMPTS, true);
}

export type SendConversationMessageOutcome =
  | { outcome: "sent"; messageRowId: string }
  | { outcome: "duplicate" }
  | {
      outcome: "refused";
      reason:
        | "not_found"
        | "not_connected"
        | "window_closed"
        | "no_opt_in"
        | "rate_limited"
        | "empty"
        | "template_unverified";
      detail?: string | undefined;
    }
  | { outcome: "failed"; messageRowId: string; error: string };

/**
 * A staff template outside the window is business-initiated: it needs an
 * explicit transactional opt-in as the customer's latest transactional
 * consent, and the number must not be suppressed.
 */
async function hasRecordedOptIn(
  supabaseAdmin: Client,
  businessId: string | null,
  waId: string,
): Promise<boolean> {
  if (!businessId) return false;
  const permission = await checkSendPermission(supabaseAdmin, businessId, waId, "transactional");
  if (!permission.allowed) return false;
  const latest = await latestConsent(supabaseAdmin, businessId, "transactional", [waId]);
  return latest.get(waId) === "opt_in";
}

/** Outbound sends in this conversation within the last minute (failed ones excluded). */
export async function recentOutboundCount(
  supabaseAdmin: Client,
  conversationId: string,
  now: Date,
): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .neq("status", "failed")
    .gte("created_at", new Date(now.getTime() - 60_000).toISOString());
  if (error) throw error;
  return count ?? 0;
}

/**
 * A business-side send into an existing conversation (staff reply, or a
 * future automated notice). `organizationId` must come from server-side
 * state. Idempotent per `idempotencyKey` within the connection.
 */
export async function sendWhatsAppConversationMessage(
  supabaseAdmin: Client,
  input: {
    organizationId: string;
    conversationId: string;
    payload: OutboundPayload;
    idempotencyKey: string;
    origin: "staff" | "system";
  },
  deps: DeliveryDeps = {},
): Promise<SendConversationMessageOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  if (input.payload.kind === "text" && !input.payload.body.trim()) {
    return { outcome: "refused", reason: "empty" };
  }

  const { data: conversation, error: convError } = await supabaseAdmin
    .from("whatsapp_conversations")
    .select("id, organization_id, whatsapp_connection_id, wa_id, contact_id, last_inbound_at")
    .eq("id", input.conversationId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (convError) throw convError;
  if (!conversation) return { outcome: "refused", reason: "not_found" };

  const { data: connection, error: connError } = await supabaseAdmin
    .from("whatsapp_connections")
    .select("id, organization_id, business_id, phone_number_id, access_token_ciphertext, status")
    .eq("id", conversation.whatsapp_connection_id)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (connError) throw connError;
  if (!connection || connection.status !== "connected") {
    return { outcome: "refused", reason: "not_connected" };
  }

  if (!isWithinCustomerServiceWindow(conversation.last_inbound_at, now)) {
    if (input.payload.kind === "text") return { outcome: "refused", reason: "window_closed" };
    if (!(await hasRecordedOptIn(supabaseAdmin, connection.business_id, conversation.wa_id))) {
      return { outcome: "refused", reason: "no_opt_in" };
    }
  }

  // A template is only sent when this number's synced registry says it is an
  // APPROVED UTILITY template with matching parameters — a caller naming one
  // proves nothing. (Marketing goes through campaigns and their opt-in rules.)
  if (input.payload.kind === "template") {
    const { data: template, error: templateError } = await supabaseAdmin
      .from("whatsapp_templates")
      .select(TEMPLATE_COLUMNS)
      .eq("organization_id", input.organizationId)
      .eq("whatsapp_connection_id", connection.id)
      .eq("name", input.payload.name)
      .eq("language", input.payload.languageCode)
      .maybeSingle();
    if (templateError) throw templateError;
    const problem = template
      ? templateProblem(
          template,
          "UTILITY",
          input.payload.bodyParams?.length ?? 0,
          "A staff template",
        )
      : { problem: "This template isn't in this number's synced, approved templates." };
    if (problem)
      return { outcome: "refused", reason: "template_unverified", detail: problem.problem };
  }

  const { data: existing, error: dupError } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("id")
    .eq("whatsapp_connection_id", connection.id)
    .eq("metadata->>idempotency_key", input.idempotencyKey)
    .in("status", ["queued", "sent", "delivered", "read"])
    .limit(1)
    .maybeSingle();
  if (dupError) throw dupError;
  if (existing) return { outcome: "duplicate" };

  if (
    (await recentOutboundCount(supabaseAdmin, conversation.id, now)) >=
    OUTBOUND_PER_MINUTE_PER_CONVERSATION
  ) {
    return { outcome: "refused", reason: "rate_limited" };
  }

  const { data: row, error: insertError } = await supabaseAdmin
    .from("whatsapp_messages")
    .insert({
      organization_id: input.organizationId,
      whatsapp_connection_id: connection.id,
      conversation_id: conversation.id,
      contact_id: conversation.contact_id,
      direction: "outbound",
      message_type: input.payload.kind,
      content: input.payload.kind === "text" ? input.payload.body : input.payload.name,
      status: "queued",
      metadata: { origin: input.origin, idempotency_key: input.idempotencyKey } as Json,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;

  const result = await deliverWhatsAppMessage(
    supabaseAdmin,
    { messageRowId: row.id, connection, to: conversation.wa_id, payload: input.payload },
    deps,
  );
  if (result.outcome === "failed") {
    return { outcome: "failed", messageRowId: row.id, error: result.error };
  }
  await supabaseAdmin
    .from("whatsapp_conversations")
    .update({
      last_message_at: now.toISOString(),
      last_message_preview: input.payload.kind === "text" ? input.payload.body.slice(0, 200) : null,
    })
    .eq("id", conversation.id);
  return { outcome: "sent", messageRowId: row.id };
}
