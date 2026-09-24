/**
 * Inbound Meta Instagram webhook processing (via the linked Facebook
 * Page's subscription — see meta-instagram-client.server.ts's
 * subscribePageWebhook). Mirrors whatsapp-inbound.server.ts's structure
 * and scope discipline (persist, never let a raw inbound event mutate
 * payment/booking truth) but Instagram has TWO distinct webhook shapes
 * this file must parse, not one:
 *
 *   1. Direct messages — delivered in the Messenger-Platform-style
 *      `entry[].messaging[]` array (sender/recipient/timestamp/message).
 *   2. Comments — delivered in the Graph API change-notification shape
 *      `entry[].changes[].value` with `field: "comments"`.
 *
 * VERIFICATION STATUS (same constraint as meta-client.server.ts /
 * meta-instagram-client.server.ts — no live fetch of
 * developers.facebook.com was possible in this sandbox): the two shapes
 * above are the standard, extensively-documented Meta webhook envelope
 * formats for a Page-linked Instagram professional account (corroborated
 * across multiple independent, current integration guides this session
 * could search), but the exact field names inside each (particularly
 * whether `entry[].id` is the Page id or the Instagram business account
 * id — Meta's own docs are inconsistent about this across API versions in
 * the sources this session could search) were NOT independently
 * confirmed live. This file resolves the owning connection defensively —
 * trying the webhook entry id against BOTH facebook_page_id and
 * instagram_business_account_id — rather than assuming one is correct,
 * and every parsing step is isolated in its own small function so a
 * correction from live testing never has to touch the rest of the
 * pipeline. See instagram.functions.test.ts / instagram-inbound.server.test.ts
 * for the mocked payloads this was built and tested against.
 *
 * BOT-LOOP PROTECTION (spec §12 — mandatory, and the one thing this file
 * treats as non-negotiable rather than best-effort): a message or comment
 * whose sender/author id equals THIS connection's own
 * instagram_business_account_id is never persisted as a new inbound event
 * and never triggers any reply — full stop. This is the PRIMARY guard,
 * independent of Meta's own `is_echo` flag (which is set as a secondary,
 * best-effort signal when present — see instagram_messages.is_echo's own
 * column comment in the migration). Comparing "is this from myself" does
 * not depend on any uncertain endpoint shape — it only requires knowing
 * which connection a webhook entry belongs to, which this file already
 * resolves for routing purposes regardless.
 *
 * A customer's inbound Instagram message/comment is NEVER treated as
 * proof of payment or booking confirmation — same rule as WhatsApp. This
 * module has no code path that reads message/comment content to affect
 * payment_requests or bookings.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

export function getInstagramWebhookVerifyToken(): string | null {
  return process.env["INSTAGRAM_WEBHOOK_VERIFY_TOKEN"] ?? null;
}

/** Meta's GET verification handshake — identical mechanism to WhatsApp's, a separate configured secret. */
export function verifyWebhookHandshake(params: {
  mode: string | null;
  verifyToken: string | null;
  challenge: string | null;
}): string | null {
  const configuredToken = getInstagramWebhookVerifyToken();
  if (!configuredToken) return null;
  if (params.mode !== "subscribe") return null;
  if (params.verifyToken !== configuredToken) return null;
  return params.challenge;
}

/**
 * Verifies Meta's X-Hub-Signature-256 header: HMAC-SHA256 of the exact raw
 * request body, keyed by META_APP_SECRET, hex-encoded, prefixed
 * "sha256=". This is Meta's standard webhook payload authenticity
 * mechanism, documented identically across every Meta webhook product
 * (Messenger/Instagram/WhatsApp Business Management webhooks) — applied
 * here because, unlike whatsapp-inbound.server.ts (which predates this
 * check), it is genuinely required for a new webhook route rather than an
 * optional hardening pass on stable code. Returns false (never throws) on
 * a missing secret, missing header, or mismatch — callers reject the
 * request outright rather than processing an unauthenticated payload.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = process.env["META_APP_SECRET"];
  if (!appSecret || !signatureHeader) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length);

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

interface MessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: { type?: string }[];
  };
}

interface CommentChangeValue {
  id?: string;
  text?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string };
  parent_id?: string;
}

interface WebhookEntry {
  id?: string;
  messaging?: MessagingEvent[];
  changes?: { field?: string; value?: CommentChangeValue }[];
}

function extractEntries(rawBody: string): WebhookEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(body["entry"]) ? (body["entry"] as unknown[]) : [];
  return entries.filter((e): e is WebhookEntry => Boolean(e) && typeof e === "object");
}

async function resolveConnectionByEntryId(
  supabaseAdmin: Client,
  entryId: string,
): Promise<{
  id: string;
  organization_id: string;
  instagram_business_account_id: string;
} | null> {
  // Two plain .eq() lookups rather than a single .or() built from an
  // interpolated string — entryId comes from the (signature-verified)
  // webhook payload, and PostgREST's .or() takes a raw filter string, so
  // building it via string interpolation would let a crafted entryId
  // inject additional filter clauses. .eq() parameterizes the value
  // properly and carries no such risk.
  const byAccountId = await supabaseAdmin
    .from("instagram_connections")
    .select("id, organization_id, instagram_business_account_id")
    .eq("instagram_business_account_id", entryId)
    .neq("status", "disconnected")
    .maybeSingle();
  if (byAccountId.error) throw byAccountId.error;
  if (byAccountId.data) return byAccountId.data;

  const byPageId = await supabaseAdmin
    .from("instagram_connections")
    .select("id, organization_id, instagram_business_account_id")
    .eq("facebook_page_id", entryId)
    .neq("status", "disconnected")
    .maybeSingle();
  if (byPageId.error) throw byPageId.error;
  return byPageId.data;
}

function mapAttachmentType(type: string | undefined): string {
  switch (type) {
    case "image":
    case "video":
    case "audio":
    case "share":
      return type;
    default:
      return "unsupported";
  }
}

async function persistInboundDirectMessage(
  supabaseAdmin: Client,
  connection: { id: string; organization_id: string; instagram_business_account_id: string },
  event: MessagingEvent,
): Promise<void> {
  const senderId = event.sender?.id;
  if (!senderId) return;

  // PRIMARY bot-loop guard — see this file's module doc.
  if (senderId === connection.instagram_business_account_id) return;
  if (event.message?.is_echo === true) return;

  const { data: conversation, error: convError } = await supabaseAdmin
    .from("instagram_conversations")
    .upsert(
      {
        organization_id: connection.organization_id,
        instagram_connection_id: connection.id,
        ig_scoped_id: senderId,
      },
      { onConflict: "instagram_connection_id,ig_scoped_id", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (convError) throw convError;

  const occurredAt = event.timestamp
    ? new Date(event.timestamp).toISOString()
    : new Date().toISOString();
  const attachmentType = event.message?.attachments?.[0]?.type;
  const messageType = event.message?.text ? "text" : mapAttachmentType(attachmentType);

  const { error: insertError } = await supabaseAdmin.from("instagram_messages").insert({
    organization_id: connection.organization_id,
    instagram_connection_id: connection.id,
    conversation_id: conversation.id,
    ig_message_id: event.message?.mid ?? null,
    direction: "inbound",
    message_type: messageType,
    content: event.message?.text ?? null,
    status: "received",
    is_echo: false,
    occurred_at: occurredAt,
  });
  if (insertError && insertError.code !== "23505") throw insertError;

  await supabaseAdmin
    .from("instagram_conversations")
    .update({
      last_message_at: occurredAt,
      last_message_preview: event.message?.text?.slice(0, 200) ?? null,
    })
    .eq("id", conversation.id);

  // AI auto-reply — fault-isolated: a failure here (model error, Meta send
  // error, no bot assigned) must never fail the whole webhook batch. The
  // inbound message is already durably persisted above regardless of what
  // happens next. Mirrors the payment-*-consumer.server.ts fan-out
  // convention (Phase 4): one subsystem's failure never blocks another's
  // or the webhook's own 200 ack.
  if (messageType === "text" && event.message?.text) {
    try {
      const { generateAndSendInstagramReply } = await import("./instagram-outbound.server.ts");
      await generateAndSendInstagramReply(supabaseAdmin, {
        connectionId: connection.id,
        conversationId: conversation.id,
        igScopedId: senderId,
      });
    } catch (err) {
      console.error("instagram_inbound:ai_reply_failed", err instanceof Error ? err.message : err);
    }
  }
}

export interface ProcessInboundWebhookResult {
  outcome: "duplicate" | "processed" | "ignored";
}

/**
 * Processes one already-received Instagram webhook POST body. Whole-batch
 * idempotency reuses webhook_events (provider='instagram'), exactly like
 * whatsapp-inbound.server.ts's own convention. Comment events are routed
 * to instagram-automation.server.ts's own idempotency ledger
 * (instagram_comment_events) rather than persisted as messages — comments
 * are not part of instagram_messages/instagram_conversations at all.
 */
export async function processInboundInstagramWebhook(
  supabaseAdmin: Client,
  input: { rawBody: string; eventId: string },
): Promise<ProcessInboundWebhookResult> {
  const { error: dedupeError } = await supabaseAdmin.from("webhook_events").insert({
    provider: "instagram",
    event_id: input.eventId,
    payload: (() => {
      try {
        return JSON.parse(input.rawBody) as Json;
      } catch {
        return { raw: input.rawBody.slice(0, 2000) } as Json;
      }
    })(),
  });
  if (dedupeError) {
    if (dedupeError.code === "23505") return { outcome: "duplicate" };
    throw dedupeError;
  }

  const entries = extractEntries(input.rawBody);
  let didAnything = false;

  for (const entry of entries) {
    const entryId = entry.id;
    if (!entryId) continue;
    const connection = await resolveConnectionByEntryId(supabaseAdmin, entryId);
    if (!connection) continue;

    for (const event of entry.messaging ?? []) {
      await persistInboundDirectMessage(supabaseAdmin, connection, event);
      didAnything = true;
    }

    const commentChanges = (entry.changes ?? []).filter((c) => c.field === "comments" && c.value);
    if (commentChanges.length > 0) {
      const { processInboundComments } = await import("./instagram-automation.server.ts");
      await processInboundComments(
        supabaseAdmin,
        connection,
        commentChanges.map((c) => c.value!),
      );
      didAnything = true;
    }
  }

  await supabaseAdmin
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("provider", "instagram")
    .eq("event_id", input.eventId);

  return { outcome: didAnything ? "processed" : "ignored" };
}
