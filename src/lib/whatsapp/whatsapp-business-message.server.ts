/**
 * Business-initiated WhatsApp messages: booking and payment notifications
 * and campaign messages. One path, so every one of them gets the same
 * rules, checked in this order — and nothing is written or sent until all
 * of them pass:
 *
 *   1. Purpose and consent scope must agree: marketing only with the
 *      marketing scope, booking/payment messages only with the
 *      transactional scope (purposeScopeProblem). Rejected before any
 *      database read.
 *   2. Only through the business's own connected number (exact
 *      organization + business match, and the exact connection when the
 *      caller names one — never another business's number).
 *   3. To a valid number (E.164, normalized with the business's country).
 *   4. At most one live message per idempotency key per number: an early
 *      read, and the unique index idx_whatsapp_messages_idempotency_live
 *      for the race (a concurrent sender gets 23505 → skipped_duplicate).
 *      A send whose outcome is unknown stays 'queued', so it keeps
 *      blocking re-sends of the same key (see deliverWhatsAppMessage).
 *   5. Recipient consent (whatsapp-consent.server.ts): never to a
 *      suppressed or opted-out number; marketing only with an explicit
 *      current opt-in.
 *   6. Business notification settings (requiresNotificationSettings): booking
 *      notifications always, and payment messages outside the 24-hour
 *      window, need the number's notifications switched on with a recorded
 *      transactional consent basis — re-read here, at send time. This is in
 *      addition to step 5, never instead of it. A payment message inside an
 *      open customer-service window is part of a conversation the customer
 *      started, so it doesn't need the business switch.
 *   7. Inside the window: free-form text. Outside it, or for marketing: only
 *      a template that this number's synced registry says is APPROVED, of the
 *      right category (UTILITY for booking/payment, MARKETING for marketing),
 *      with positional parameters matching the message. An environment
 *      variable can name which template to use, but never proves it is
 *      approved. Anything unverifiable fails with the reason; nothing is sent
 *      as free-form text where Meta requires a template, and no template name
 *      is invented.
 *   8. Delivery through deliverWhatsAppMessage (timeouts, bounded retries
 *      only when Meta answered 429/5xx, token never logged).
 *
 * Never throws for a delivery or policy problem — the result says what
 * happened and whether trying again later is safe (`retryable`). Database
 * errors do throw (fail closed), so they're never mistaken for permission.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { deliverWhatsAppMessage, type DeliveryDeps } from "./whatsapp-outbound.server.ts";
import { checkSendPermission, toWaId, type ConsentScope } from "./whatsapp-consent.server.ts";
import {
  TEMPLATE_COLUMNS,
  countBodyParams,
  templateProblem,
  type TemplateFailureCode,
  type TemplateRow,
} from "./whatsapp-templates.server.ts";

type Client = SupabaseClient<Database>;

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** The shortest consent-basis statement that counts as recorded (same rule as the dashboard). */
export const MIN_CONSENT_BASIS_LENGTH = 20;

export const BOOKING_PURPOSES = [
  "booking_confirmed",
  "booking_rescheduled",
  "booking_cancelled",
  "booking_reminder",
] as const;
export const PAYMENT_PURPOSES = [
  "payment_link",
  "payment_confirmation",
  "payment_failed",
  "payment_expired",
] as const;

export type MessagePurpose =
  (typeof BOOKING_PURPOSES)[number] | (typeof PAYMENT_PURPOSES)[number] | "marketing";

const TRANSACTIONAL = new Set<string>([...BOOKING_PURPOSES, ...PAYMENT_PURPOSES]);
const BOOKING = new Set<string>(BOOKING_PURPOSES);

/** Why this purpose can't be sent under this consent scope, or null when they agree. */
export function purposeScopeProblem(purpose: string, scope: string): string | null {
  if (purpose === "marketing") {
    return scope === "marketing" ? null : "Marketing messages require the marketing consent scope.";
  }
  if (TRANSACTIONAL.has(purpose)) {
    return scope === "transactional"
      ? null
      : `"${purpose}" is a booking/payment message and must use the transactional consent scope.`;
  }
  return `Unknown message purpose "${purpose}".`;
}

/**
 * Whether the business's notification switch and consent basis must be in
 * place. Booking notifications are automated, so always. Payment messages
 * only when business-initiated (outside the window); inside it they answer
 * a conversation the customer started. Marketing has its own, stricter
 * per-recipient opt-in rule instead.
 */
export function requiresNotificationSettings(purpose: MessagePurpose, inWindow: boolean): boolean {
  if (purpose === "marketing") return false;
  if (BOOKING.has(purpose)) return true;
  return !inWindow;
}

export function expectedTemplateCategory(purpose: MessagePurpose): "UTILITY" | "MARKETING" {
  return purpose === "marketing" ? "MARKETING" : "UTILITY";
}

// One definition, shared with the template registry checks.
export { countBodyParams };

export interface BusinessMessageInput {
  organizationId: string;
  businessId: string;
  /** Pin the exact number to send from (campaigns). It must still be this business's connected number. */
  connectionId?: string | undefined;
  /** The customer's number as stored (E.164 or national format). */
  customerPhone: string;
  purpose: MessagePurpose;
  scope: ConsentScope;
  idempotencyKey: string;
  /** Free-form text used inside the 24-hour window. */
  bodyText: string;
  /** Body parameters for the template, in order. Defaults to [bodyText]. */
  templateBodyParams?: string[] | undefined;
  /** A specific template from the registry (campaigns). Otherwise resolved from `purpose`. */
  templateId?: string | undefined;
  /** Always send the template, even inside the window (campaigns). */
  forceTemplate?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type SkipReason =
  | "no_connection"
  | "invalid_phone"
  | "suppressed"
  | "opted_out"
  | "no_consent"
  | "notifications_disabled"
  | "no_consent_basis";

export type FailureCode =
  | "invalid_purpose_scope"
  | "template_missing"
  | "template_not_found_for_number"
  | TemplateFailureCode
  | "delivery_failed";

export type BusinessMessageResult =
  | { outcome: "sent"; messageRowId: string; waMessageId: string | null }
  | { outcome: "skipped_duplicate"; existingStatus: string | null }
  | { outcome: "skipped"; reason: SkipReason }
  | {
      outcome: "failed";
      code: FailureCode;
      error: string;
      retryable: boolean;
      messageRowId?: string | undefined;
    };

type TemplateResolution =
  { ok: true; template: TemplateRow } | { ok: false; code: FailureCode; problem: string };

/**
 * The template to use for this message, verified against the number's
 * synced registry: APPROVED, the category the purpose needs, positional
 * parameters only, and the same parameter count as the message.
 *   - templateId (campaigns): that exact registry row, on this number.
 *   - otherwise the registry row mapped to the purpose on this number;
 *     failing that, a WHATSAPP_TEMPLATE_<PURPOSE>_NAME/_LANGUAGE naming a
 *     row in this number's registry (the variable selects; the registry
 *     verifies).
 */
export async function resolveVerifiedTemplate(
  supabaseAdmin: Client,
  input: {
    organizationId: string;
    connectionId: string;
    purpose: MessagePurpose;
    templateId?: string | undefined;
    paramCount: number;
  },
): Promise<TemplateResolution> {
  const base = () =>
    supabaseAdmin
      .from("whatsapp_templates")
      .select(TEMPLATE_COLUMNS)
      .eq("organization_id", input.organizationId)
      .eq("whatsapp_connection_id", input.connectionId);

  let template: TemplateRow | null = null;
  if (input.templateId) {
    const { data, error } = await base().eq("id", input.templateId).maybeSingle();
    if (error) throw error;
    if (!data) {
      return {
        ok: false,
        code: "template_not_found_for_number",
        problem: "The chosen template isn't one of this WhatsApp number's synced templates.",
      };
    }
    template = data;
  } else if (input.purpose === "marketing") {
    return {
      ok: false,
      code: "template_missing",
      problem: "Marketing messages need an explicitly chosen, approved MARKETING template.",
    };
  } else {
    const { data: mapped, error } = await base().eq("purpose", input.purpose).maybeSingle();
    if (error) throw error;
    template = mapped;
    if (!template) {
      const envName = process.env[`WHATSAPP_TEMPLATE_${input.purpose.toUpperCase()}_NAME`];
      const envLanguage =
        process.env[`WHATSAPP_TEMPLATE_${input.purpose.toUpperCase()}_LANGUAGE`] || "en_US";
      if (envName) {
        const { data: named, error: namedError } = await base()
          .eq("name", envName)
          .eq("language", envLanguage)
          .maybeSingle();
        if (namedError) throw namedError;
        if (!named) {
          return {
            ok: false,
            code: "template_not_found_for_number",
            problem: `WHATSAPP_TEMPLATE_${input.purpose.toUpperCase()}_NAME names a template that isn't in this number's synced registry, so its approval can't be verified. Sync templates from Meta first.`,
          };
        }
        template = named;
      }
    }
    if (!template) {
      return {
        ok: false,
        code: "template_missing",
        problem: `A Message Template is required outside the 24h window, but no approved template is mapped to "${input.purpose}" for this number. Sync templates and map one in the dashboard.`,
      };
    }
  }

  const problem = templateProblem(
    template,
    expectedTemplateCategory(input.purpose),
    input.paramCount,
    `"${input.purpose}"`,
  );
  if (problem) return { ok: false, ...problem };
  return { ok: true, template };
}

async function latestInboundAt(
  supabaseAdmin: Client,
  conversation: { id: string; last_inbound_at: string | null },
): Promise<number | null> {
  if (conversation.last_inbound_at) return new Date(conversation.last_inbound_at).getTime();
  // Conversations from before last_inbound_at existed: read the messages.
  const { data, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("occurred_at")
    .eq("conversation_id", conversation.id)
    .eq("direction", "inbound")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? new Date(data.occurred_at).getTime() : null;
}

/** Connected numbers considered for one business (more is a misconfiguration, not a use case). */
const MAX_CONNECTIONS_PER_BUSINESS = 10;

type CandidateConnection = {
  id: string;
  notifications_enabled: boolean | null;
};

/**
 * Picks the number to send from when a business has several connected:
 * for booking and payment notifications only numbers with notifications
 * turned on (if any); then the number this customer already talks to (most
 * recent conversation); otherwise the earliest connected one. Always the
 * same answer for the same state.
 */
async function chooseConnection<C extends CandidateConnection>(
  supabaseAdmin: Client,
  input: BusinessMessageInput,
  candidates: C[],
  waId: string,
): Promise<C> {
  let pool = candidates;
  if (input.scope === "transactional") {
    const enabled = candidates.filter((c) => c.notifications_enabled === true);
    if (enabled.length > 0) pool = enabled;
  }
  if (pool.length === 1) return pool[0]!;
  const { data: conversation, error } = await supabaseAdmin
    .from("whatsapp_conversations")
    .select("whatsapp_connection_id")
    .eq("organization_id", input.organizationId)
    .eq("wa_id", waId)
    .in(
      "whatsapp_connection_id",
      pool.map((c) => c.id),
    )
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return pool.find((c) => c.id === conversation?.whatsapp_connection_id) ?? pool[0]!;
}

export async function sendBusinessWhatsAppMessage(
  supabaseAdmin: Client,
  input: BusinessMessageInput,
  deps: DeliveryDeps = {},
): Promise<BusinessMessageResult> {
  const now = (deps.now ?? (() => new Date()))();

  const scopeProblem = purposeScopeProblem(input.purpose, input.scope);
  if (scopeProblem) {
    return {
      outcome: "failed",
      code: "invalid_purpose_scope",
      error: scopeProblem,
      retryable: false,
    };
  }

  // A business can have more than one connected number: every one is a
  // candidate, in a fixed order (earliest connected first).
  let connectionQuery = supabaseAdmin
    .from("whatsapp_connections")
    .select(
      "id, organization_id, business_id, phone_number_id, waba_id, status, provider, vobiz_channel_id, notifications_enabled, transactional_consent_basis",
    )
    .eq("organization_id", input.organizationId)
    .eq("business_id", input.businessId)
    .eq("status", "connected");
  if (input.connectionId) connectionQuery = connectionQuery.eq("id", input.connectionId);
  const { data: candidates, error: connError } = await connectionQuery
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_CONNECTIONS_PER_BUSINESS);
  if (connError) throw connError;
  if (!candidates || candidates.length === 0)
    return { outcome: "skipped", reason: "no_connection" };

  const { data: business, error: businessError } = await supabaseAdmin
    .from("businesses")
    .select("country")
    .eq("id", input.businessId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (businessError) throw businessError;
  const waId = toWaId(input.customerPhone, business?.country ?? null);
  if (!waId) return { outcome: "skipped", reason: "invalid_phone" };

  const connection = await chooseConnection(supabaseAdmin, input, candidates, waId);

  // The key is checked across every candidate number, so a retry that would
  // pick a different number now still finds the earlier send.
  const { data: existing, error: dupError } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("id, status")
    .in(
      "whatsapp_connection_id",
      candidates.map((c) => c.id),
    )
    .eq("metadata->>idempotency_key", input.idempotencyKey)
    .in("status", ["queued", "sent", "delivered", "read"])
    .limit(1)
    .maybeSingle();
  if (dupError) throw dupError;
  if (existing) return { outcome: "skipped_duplicate", existingStatus: existing.status };

  const permission = await checkSendPermission(supabaseAdmin, input.businessId, waId, input.scope);
  if (!permission.allowed) return { outcome: "skipped", reason: permission.reason };

  // Read (don't create) the conversation until every check has passed.
  const { data: existingConversation, error: findError } = await supabaseAdmin
    .from("whatsapp_conversations")
    .select("id, last_inbound_at")
    .eq("whatsapp_connection_id", connection.id)
    .eq("wa_id", waId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (findError) throw findError;
  const inboundAt = existingConversation
    ? await latestInboundAt(supabaseAdmin, existingConversation)
    : null;
  const inWindow = inboundAt !== null && now.getTime() - inboundAt < WINDOW_MS;

  if (requiresNotificationSettings(input.purpose, inWindow)) {
    if (connection.notifications_enabled !== true) {
      return { outcome: "skipped", reason: "notifications_disabled" };
    }
    if ((connection.transactional_consent_basis ?? "").trim().length < MIN_CONSENT_BASIS_LENGTH) {
      return { outcome: "skipped", reason: "no_consent_basis" };
    }
  }

  const useTemplate = Boolean(input.forceTemplate) || input.purpose === "marketing" || !inWindow;
  const params = input.templateBodyParams ?? [input.bodyText];
  let template: TemplateRow | null = null;
  let templateFailure: { code: FailureCode; problem: string } | null = null;
  if (useTemplate) {
    const resolved = await resolveVerifiedTemplate(supabaseAdmin, {
      organizationId: input.organizationId,
      connectionId: connection.id,
      purpose: input.purpose,
      templateId: input.templateId,
      paramCount: params.length,
    });
    if (resolved.ok) template = resolved.template;
    else templateFailure = { code: resolved.code, problem: resolved.problem };
  }

  const conversation =
    existingConversation ??
    (await (async () => {
      const { data, error } = await supabaseAdmin
        .from("whatsapp_conversations")
        .upsert(
          {
            organization_id: input.organizationId,
            whatsapp_connection_id: connection.id,
            wa_id: waId,
          },
          { onConflict: "whatsapp_connection_id,wa_id", ignoreDuplicates: false },
        )
        .select("id, last_inbound_at")
        .single();
      if (error) throw error;
      return data;
    })());

  const metadata = {
    ...(input.metadata ?? {}),
    purpose: input.purpose,
    idempotency_key: input.idempotencyKey,
  };
  const baseRow = {
    organization_id: input.organizationId,
    whatsapp_connection_id: connection.id,
    conversation_id: conversation.id,
    direction: "outbound",
    content: input.bodyText,
    metadata: metadata as Json,
  };

  if (templateFailure) {
    // Recorded on a failed row so staff see why nothing was sent.
    await supabaseAdmin.from("whatsapp_messages").insert({
      ...baseRow,
      message_type: "template",
      status: "failed",
      error_message: templateFailure.problem,
    });
    return {
      outcome: "failed",
      code: templateFailure.code,
      error: templateFailure.problem,
      retryable: false,
    };
  }

  const { data: row, error: insertError } = await supabaseAdmin
    .from("whatsapp_messages")
    .insert({ ...baseRow, message_type: useTemplate ? "template" : "text", status: "queued" })
    .select("id")
    .single();
  if (insertError) {
    if (insertError.code === "23505") return { outcome: "skipped_duplicate", existingStatus: null };
    throw insertError;
  }

  const result = await deliverWhatsAppMessage(
    supabaseAdmin,
    {
      messageRowId: row.id,
      connection,
      to: waId,
      payload: template
        ? {
            kind: "template",
            name: template.name,
            languageCode: template.language,
            bodyParams: params,
          }
        : { kind: "text", body: input.bodyText },
    },
    deps,
  );
  if (result.outcome === "failed") {
    return {
      outcome: "failed",
      code: "delivery_failed",
      error: result.error,
      retryable: result.retryable,
      messageRowId: row.id,
    };
  }
  await supabaseAdmin
    .from("whatsapp_conversations")
    .update({
      last_message_at: now.toISOString(),
      last_message_preview: input.bodyText.slice(0, 200),
    })
    .eq("id", conversation.id);
  return { outcome: "sent", messageRowId: row.id, waMessageId: result.waMessageId };
}
