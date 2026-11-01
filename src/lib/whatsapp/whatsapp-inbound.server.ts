/**
 * Inbound WhatsApp webhook processing (deliveries from Vobiz, ClickAI's BSP):
 *
 *   1. Authentication: every POST must carry a valid X-Webhook-Signature
 *      (hex HMAC-SHA256 of the raw body with VOBIZ_WHATSAPP_WEBHOOK_SECRET) —
 *      verified by the route before anything is parsed or stored
 *      (vobiz-webhook.server.ts).
 *   2. Delivery-status updates (sent/delivered/read/failed, `message.status`)
 *      for messages this codebase sent — scoped to the connection the
 *      payload names and never moved backwards (a late "delivered" can't
 *      undo "read").
 *   3. Inbound customer messages (`message.inbound`) are persisted
 *      (whatsapp_conversations/whatsapp_messages); the ids of NEW inbound
 *      text messages are returned so the route can hand them to the AI reply
 *      worker (whatsapp-ai-reply.server.ts) without blocking the
 *      acknowledgement.
 *
 * Idempotency and recovery: the delivery's `event_id` is claimed in
 * webhook_events (provider='vobiz_whatsapp') with a lease, and each message
 * is unique per (connection, wa_message_id). Event states
 * (20261029090000): processed (processed_at set); deferred (error set,
 * next_attempt_at in the future — no live connection yet, or a status for a
 * message whose WhatsApp id isn't recorded yet); retained for an operator
 * (error set, next_attempt_at NULL — routing conflict, no phone number id,
 * retries exhausted); in progress (error NULL, next_attempt_at = lease end).
 * Due events are replayed by replayDueVobizWebhookEvents (dispatch cron) or
 * by Vobiz's own redelivery, at most WEBHOOK_MAX_ATTEMPTS times in total. A
 * storage failure leaves the event due and propagates (the route answers
 * 5xx). Replays are idempotent: messages already stored are skipped, statuses
 * only move forward, a consent signal is recorded once, and only messages
 * stored for the first time are passed on for a reply.
 *
 * Tenant identity comes only from the connection row matched by the
 * payload's phone_number_id — never from anything else in the payload (a
 * channel_id, where present, must agree with it).
 *
 * A customer's inbound message is never treated as proof of payment,
 * confirmation or anything payment-state-related.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { consentEventTime, recordConsentEvent } from "./whatsapp-consent.server.ts";
import { parseVobizWebhookEnvelope } from "./vobiz-webhook.server.ts";

type Client = SupabaseClient<Database>;

/** The provider name under which Vobiz deliveries are claimed in webhook_events. */
export const VOBIZ_WEBHOOK_PROVIDER = "vobiz_whatsapp";

interface MetaStatusUpdate {
  id?: string;
  status?: string;
  recipient_id?: string;
  timestamp?: string;
  errors?: { code?: number; title?: string }[];
}
interface MetaInboundMessage {
  id?: string;
  from?: string;
  type?: string;
  timestamp?: string;
  text?: { body?: string };
}
interface MetaWebhookValue {
  metadata?: { phone_number_id?: string };
  statuses?: MetaStatusUpdate[];
  messages?: MetaInboundMessage[];
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
}

/**
 * Which stored statuses each Meta status may replace. Statuses only move
 * forward (queued → sent → delivered → read); "failed" can only replace a
 * status that hasn't reached the customer yet. Meta can deliver them out of
 * order and more than once.
 */
const STATUS_MAY_REPLACE: Record<string, readonly string[]> = {
  sent: ["queued"],
  delivered: ["queued", "sent"],
  read: ["queued", "sent", "delivered"],
  failed: ["queued", "sent"],
};

function mapInboundMessageType(metaType: string | undefined): string {
  switch (metaType) {
    case "text":
    case "image":
    case "audio":
    case "video":
    case "document":
    case "interactive":
    case "template":
      return metaType;
    default:
      return "unsupported";
  }
}

async function resolveConnectionByVobizChannelId(
  supabaseAdmin: Client,
  channelId: string,
): Promise<{ id: string; organization_id: string; business_id: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_connections")
    .select("id, organization_id, business_id")
    .eq("vobiz_channel_id", channelId)
    .neq("status", "disconnected")
    .maybeSingle();
  if (error) throw error;
  return data;
}

function topLevelKeys(rawBody: string): string[] {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed).slice(0, 20)
      : [];
  } catch {
    return ["(not JSON)"];
  }
}

async function resolveConnectionByPhoneNumberId(
  supabaseAdmin: Client,
  phoneNumberId: string,
): Promise<{ id: string; organization_id: string; business_id: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_connections")
    .select("id, organization_id, business_id")
    .eq("phone_number_id", phoneNumberId)
    .neq("status", "disconnected")
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** A short, customer-safe failure reason from Meta's status error (never the raw payload). */
function statusErrorMessage(status: MetaStatusUpdate): string | null {
  const first = status.errors?.[0];
  if (!first) return null;
  const code = typeof first.code === "number" ? ` (${first.code})` : "";
  const title = typeof first.title === "string" ? first.title.slice(0, 200) : "Delivery failed";
  return `${title}${code}`;
}

/** Meta's "this user has stopped marketing messages from businesses" delivery error. */
export const META_MARKETING_OPT_OUT_ERROR = 131050;

/**
 * Applies one status to this connection's message with that WhatsApp id.
 * "unmatched": no message of this connection has the id (yet) — e.g. the
 * status arrived before the send was recorded, or Vobiz returned no
 * meta_message_id at send time. The caller keeps the event for a retry.
 * "stale": the message is already further along (out of order / repeat).
 */
async function applyStatusUpdate(
  supabaseAdmin: Client,
  connection: { id: string; organization_id: string; business_id: string | null },
  status: MetaStatusUpdate,
): Promise<"applied" | "stale" | "unmatched" | "skipped"> {
  const connectionId = connection.id;
  if (!status.id || !status.status) return "skipped";
  const replaceable = STATUS_MAY_REPLACE[status.status];
  if (!replaceable) return "skipped"; // Unrecognized Meta status — never guess, just skip.
  const update: Database["public"]["Tables"]["whatsapp_messages"]["Update"] = {
    status: status.status,
  };
  if (status.status === "failed") update.error_message = statusErrorMessage(status);
  const { data: changed, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .update(update)
    .eq("whatsapp_connection_id", connectionId)
    .eq("wa_message_id", status.id)
    .in("status", [...replaceable])
    .select("id");
  if (error) throw error;
  let outcome: "applied" | "stale" | "unmatched" = "applied";
  if ((changed ?? []).length === 0) {
    // Nothing moved: either the message is already further along (normal), or
    // no stored message of this connection has this wamid (yet).
    const { data: known, error: knownError } = await supabaseAdmin
      .from("whatsapp_messages")
      .select("id")
      .eq("whatsapp_connection_id", connectionId)
      .eq("wa_message_id", status.id)
      .limit(1);
    if (knownError) throw knownError;
    outcome = (known ?? []).length === 0 ? "unmatched" : "stale";
  }

  // The customer told WhatsApp they don't want marketing from businesses:
  // record it so no campaign targets them again.
  if (
    status.status === "failed" &&
    status.errors?.some((e) => e.code === META_MARKETING_OPT_OUT_ERROR) &&
    connection.business_id
  ) {
    const waId = status.recipient_id;
    const evidence = `meta_error:${META_MARKETING_OPT_OUT_ERROR}:${status.id}`;
    // A redelivered or replayed event must not record the same signal twice.
    const { data: already, error: alreadyError } = waId
      ? await supabaseAdmin
          .from("whatsapp_consent_events")
          .select("id")
          .eq("business_id", connection.business_id)
          .eq("wa_id", waId)
          .eq("evidence", evidence)
          .limit(1)
      : { data: [], error: null };
    if (alreadyError) throw alreadyError;
    if (waId && /^[1-9]\d{6,14}$/.test(waId) && (already ?? []).length === 0) {
      await recordConsentEvent(supabaseAdmin, {
        organizationId: connection.organization_id,
        businessId: connection.business_id,
        waId,
        scope: "marketing",
        action: "opt_out",
        source: "meta_signal",
        evidence,
        occurredAt: consentEventTime(status.timestamp, new Date()),
      });
    }
  }
  return outcome;
}

/** Stores one inbound message. Returns its row id when it was stored for the first time, null when it already existed (a Meta retry). */
async function persistInboundMessage(
  supabaseAdmin: Client,
  connection: { id: string; organization_id: string },
  message: MetaInboundMessage,
  contactName: string | undefined,
): Promise<string | null> {
  if (!message.from || !message.id) return null;

  const { data: conversation, error: convError } = await supabaseAdmin
    .from("whatsapp_conversations")
    .upsert(
      {
        organization_id: connection.organization_id,
        whatsapp_connection_id: connection.id,
        wa_id: message.from,
        customer_display_name: contactName ?? null,
      },
      { onConflict: "whatsapp_connection_id,wa_id", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (convError) throw convError;

  const seconds = Number(message.timestamp);
  const occurredAt =
    Number.isFinite(seconds) && seconds > 0
      ? new Date(seconds * 1000).toISOString()
      : new Date().toISOString();
  const text = message.type === "text" ? (message.text?.body ?? null) : null;

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("whatsapp_messages")
    .insert({
      organization_id: connection.organization_id,
      whatsapp_connection_id: connection.id,
      conversation_id: conversation.id,
      wa_message_id: message.id,
      direction: "inbound",
      message_type: mapInboundMessageType(message.type),
      content: text,
      status: "received",
      occurred_at: occurredAt,
    })
    .select("id")
    .single();
  if (insertError) {
    if (insertError.code === "23505") return null; // already stored by an earlier delivery
    throw insertError;
  }

  // The latest inbound message opens Meta's 24-hour customer-service window;
  // a late, out-of-order delivery must not move it backwards.
  const { error: windowError } = await supabaseAdmin
    .from("whatsapp_conversations")
    .update({
      last_inbound_at: occurredAt,
      last_message_at: occurredAt,
      last_message_preview: text?.slice(0, 200) ?? null,
    })
    .eq("id", conversation.id)
    .or(`last_inbound_at.is.null,last_inbound_at.lt."${occurredAt}"`);
  if (windowError) throw windowError;

  return inserted.id;
}

export interface ProcessInboundWebhookResult {
  /**
   * - processed: applied (or nothing in it was for this codebase, e.g. `call.*`
   *   is "ignored")
   * - duplicate: already processed, or another worker holds it right now
   * - deferred: kept for a bounded retry (no live connection yet, or a status
   *   for a message whose WhatsApp id isn't known yet)
   * - retained: kept for an operator, never applied automatically (routing
   *   conflict, no phone number id, retries exhausted)
   * - unrecognized: signed by Vobiz but not the documented envelope; kept
   */
  outcome: "duplicate" | "processed" | "ignored" | "deferred" | "retained" | "unrecognized";
  /** Inbound text messages stored for the first time by this delivery — the ones that may get an AI reply. */
  newInboundTextMessageIds: string[];
}

/** Attempts per event (first delivery included) before it is kept for an operator. */
export const WEBHOOK_MAX_ATTEMPTS = 8;
/** Wait before the next attempt, by attempts made so far (1 → 1 min … 7+ → 6 h). */
const RETRY_DELAYS_MS = [
  60_000,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 3_600_000,
  6 * 3_600_000,
];
/** How long a worker holds an event it is applying before another may take it over. */
export const WEBHOOK_LEASE_MS = 5 * 60_000;
/** The provider name for signed deliveries without the documented envelope (keyed by the body's hash, so they never collide with real event ids). */
export const VOBIZ_UNRECOGNIZED_PROVIDER = "vobiz_whatsapp_unrecognized";

function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1]!;
}

type EventRow = {
  id: string;
  event_id: string;
  event_type: string | null;
  payload: Json;
  attempts: number;
  processed_at: string | null;
  next_attempt_at: string | null;
  error: string | null;
};
const EVENT_COLUMNS =
  "id, event_id, event_type, payload, attempts, processed_at, next_attempt_at, error";

/** What applying one event's change value found. */
type Applied =
  | { kind: "done"; newInboundTextMessageIds: string[] }
  | {
      kind: "defer";
      reason: "no_live_connection" | "status_unmatched";
      newInboundTextMessageIds: string[];
    }
  | { kind: "terminal"; reason: "missing_phone_number_id" | "routing_conflict" };

/**
 * Applies one stored Vobiz envelope. Tenant identity comes only from the live
 * connection matched by `payload.metadata.phone_number_id` (Vobiz's Events
 * Reference: the payload is the WhatsApp Cloud API change value). A
 * `channel_id`, where a delivery carries one, is only a cross-check — never
 * the sole routing key, since that field's placement is not confirmed.
 * Everything here is idempotent, so a replay can't duplicate a message, a
 * status change or a consent record.
 */
async function applyEnvelope(
  supabaseAdmin: Client,
  eventId: string,
  envelope: Record<string, unknown>,
): Promise<Applied> {
  const value = (envelope["payload"] ?? {}) as MetaWebhookValue;
  const phoneNumberId = value.metadata?.phone_number_id ?? null;
  const channelId =
    (typeof envelope["channel_id"] === "string" && envelope["channel_id"]) ||
    (typeof (value as Record<string, unknown>)["channel_id"] === "string" &&
      ((value as Record<string, unknown>)["channel_id"] as string)) ||
    null;
  if (!phoneNumberId) {
    console.error("whatsapp_webhook:payload_without_phone_number_id", {
      eventId,
      keys: value && typeof value === "object" ? Object.keys(value).slice(0, 20) : [],
    });
    return { kind: "terminal", reason: "missing_phone_number_id" };
  }
  const connection = await resolveConnectionByPhoneNumberId(supabaseAdmin, phoneNumberId);
  if (connection && channelId) {
    const byChannel = await resolveConnectionByVobizChannelId(supabaseAdmin, channelId);
    if (!byChannel || byChannel.id !== connection.id) {
      // The two identifiers disagree: never guess which tenant it belongs to.
      console.error("whatsapp_webhook:routing_conflict", { eventId, phoneNumberId, channelId });
      return { kind: "terminal", reason: "routing_conflict" };
    }
  }
  if (!connection) {
    // E.g. the event arrived before onboarding saved the connection.
    console.warn("whatsapp_webhook:no_live_connection", { eventId, phoneNumberId });
    return { kind: "defer", reason: "no_live_connection", newInboundTextMessageIds: [] };
  }

  let unmatched = 0;
  for (const status of value.statuses ?? []) {
    if ((await applyStatusUpdate(supabaseAdmin, connection, status)) === "unmatched") unmatched++;
  }
  const newInboundTextMessageIds: string[] = [];
  for (const message of value.messages ?? []) {
    const contactName = value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name;
    const storedId = await persistInboundMessage(
      supabaseAdmin,
      connection,
      message,
      contactName ?? value.contacts?.[0]?.profile?.name,
    );
    if (storedId && message.type === "text" && message.text?.body) {
      newInboundTextMessageIds.push(storedId);
    }
  }
  if (unmatched > 0) {
    console.warn("whatsapp_webhook:status_unmatched", {
      eventId,
      connectionId: connection.id,
      unmatched,
    });
    return { kind: "defer", reason: "status_unmatched", newInboundTextMessageIds };
  }
  return { kind: "done", newInboundTextMessageIds };
}

/**
 * Applies an event this worker has claimed and records the result on its
 * row: processed, deferred (next attempt scheduled), or terminal (kept, with
 * the reason). A database failure leaves it immediately due again and is
 * rethrown, so the caller can answer 5xx and Vobiz redelivers; attempts are
 * bounded either way.
 */
async function applyClaimed(
  supabaseAdmin: Client,
  row: { id: string; event_id: string; payload: Json; attempts: number },
  now: Date,
): Promise<ProcessInboundWebhookResult> {
  const finish = async (patch: Database["public"]["Tables"]["webhook_events"]["Update"]) => {
    const { error } = await supabaseAdmin.from("webhook_events").update(patch).eq("id", row.id);
    if (error) throw error;
  };
  const exhausted = row.attempts >= WEBHOOK_MAX_ATTEMPTS;
  let applied: Applied;
  try {
    applied = await applyEnvelope(
      supabaseAdmin,
      row.event_id,
      (row.payload ?? {}) as Record<string, unknown>,
    );
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? "unknown";
    await supabaseAdmin
      .from("webhook_events")
      .update({
        error: `retryable:${String(code).slice(0, 40)}`,
        next_attempt_at: exhausted ? null : now.toISOString(),
      })
      .eq("id", row.id);
    throw err;
  }
  if (applied.kind === "done") {
    await finish({ processed_at: now.toISOString(), error: null, next_attempt_at: null });
    return { outcome: "processed", newInboundTextMessageIds: applied.newInboundTextMessageIds };
  }
  if (applied.kind === "terminal") {
    await finish({ error: applied.reason, next_attempt_at: null });
    return { outcome: "retained", newInboundTextMessageIds: [] };
  }
  if (exhausted) {
    console.error("whatsapp_webhook:retries_exhausted", {
      eventId: row.event_id,
      reason: applied.reason,
      attempts: row.attempts,
    });
    await finish({ error: `gave_up:${applied.reason}`, next_attempt_at: null });
    return { outcome: "retained", newInboundTextMessageIds: applied.newInboundTextMessageIds };
  }
  await finish({
    error: applied.reason,
    next_attempt_at: new Date(now.getTime() + retryDelayMs(row.attempts)).toISOString(),
  });
  return { outcome: "deferred", newInboundTextMessageIds: applied.newInboundTextMessageIds };
}

/**
 * Takes an existing, due event for this worker: only when it isn't processed,
 * isn't terminal, and is due (a pending retry, or an in-progress claim whose
 * lease ran out). Optimistic on `attempts`, so two workers can't both take it.
 */
async function claimExisting(
  supabaseAdmin: Client,
  row: EventRow,
  now: Date,
): Promise<{ id: string; event_id: string; payload: Json; attempts: number } | null> {
  if (row.processed_at || !row.next_attempt_at) return null;
  if (new Date(row.next_attempt_at).getTime() > now.getTime()) return null;
  const attempts = row.attempts + 1;
  const { data, error } = await supabaseAdmin
    .from("webhook_events")
    .update({
      attempts,
      next_attempt_at: new Date(now.getTime() + WEBHOOK_LEASE_MS).toISOString(),
    })
    .eq("id", row.id)
    .eq("attempts", row.attempts)
    .is("processed_at", null)
    .select("id");
  if (error) throw error;
  if ((data ?? []).length === 0) return null;
  return { id: row.id, event_id: row.event_id, payload: row.payload, attempts };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Process one already signature-verified Vobiz delivery
 * (vobiz-webhook.server.ts). The envelope's `event_id` is claimed in
 * webhook_events; a redelivery of a processed event is a duplicate, while a
 * redelivery of a deferred one is another (bounded) attempt. Only
 * `message.inbound` and `message.status` carry WhatsApp data; other
 * documented events (`call.*`) are acknowledged and ignored. A delivery
 * without the documented envelope is kept, keyed by the SHA-256 of its
 * exact bytes (never a made-up event id), and never applied.
 * Throws if storage fails, so the caller can answer 5xx and Vobiz retries.
 */
export async function processVobizWhatsAppWebhook(
  supabaseAdmin: Client,
  input: { rawBody: string; now?: Date },
): Promise<ProcessInboundWebhookResult & { eventType: string | null }> {
  const now = input.now ?? new Date();
  const envelope = parseVobizWebhookEnvelope(input.rawBody);
  if (!envelope) {
    // Signed by Vobiz but not the documented envelope (e.g. no event_id):
    // kept for an operator, never applied. Only key names are logged.
    console.error("whatsapp_webhook:envelope_unrecognized", { keys: topLevelKeys(input.rawBody) });
    let stored: Json;
    try {
      stored = JSON.parse(input.rawBody) as Json;
    } catch {
      stored = { unparseable: true, bytes: input.rawBody.length };
    }
    const { error } = await supabaseAdmin.from("webhook_events").insert({
      provider: VOBIZ_UNRECOGNIZED_PROVIDER,
      event_id: `sha256:${await sha256Hex(input.rawBody)}`,
      event_type: null,
      payload: stored,
      attempts: 1,
      error: "unrecognized_envelope",
      next_attempt_at: null,
    });
    if (error && error.code !== "23505") throw error;
    return { outcome: "unrecognized", newInboundTextMessageIds: [], eventType: null };
  }
  if (envelope.eventType !== "message.inbound" && envelope.eventType !== "message.status") {
    return { outcome: "ignored", newInboundTextMessageIds: [], eventType: envelope.eventType };
  }

  // The whole envelope is kept, so a replay applies exactly what Vobiz sent.
  const stored = JSON.parse(input.rawBody) as Json;
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("webhook_events")
    .insert({
      provider: VOBIZ_WEBHOOK_PROVIDER,
      event_id: envelope.eventId,
      event_type: envelope.eventType,
      payload: stored,
      attempts: 1,
      next_attempt_at: new Date(now.getTime() + WEBHOOK_LEASE_MS).toISOString(),
    })
    .select("id")
    .single();
  let claimed: { id: string; event_id: string; payload: Json; attempts: number } | null = null;
  if (insertError) {
    if (insertError.code !== "23505") throw insertError;
    const { data: existing, error: readError } = await supabaseAdmin
      .from("webhook_events")
      .select(EVENT_COLUMNS)
      .eq("provider", VOBIZ_WEBHOOK_PROVIDER)
      .eq("event_id", envelope.eventId)
      .maybeSingle();
    if (readError) throw readError;
    claimed = existing ? await claimExisting(supabaseAdmin, existing as EventRow, now) : null;
    if (!claimed) {
      return { outcome: "duplicate", newInboundTextMessageIds: [], eventType: envelope.eventType };
    }
  } else {
    claimed = { id: inserted.id, event_id: envelope.eventId, payload: stored, attempts: 1 };
  }
  const result = await applyClaimed(supabaseAdmin, claimed, now);
  return { ...result, eventType: envelope.eventType };
}

export interface ReplaySummary {
  examined: number;
  processed: number;
  deferred: number;
  retained: number;
  failed: number;
  /** Inbound texts first stored by a replay (for the AI reply worker). */
  newInboundTextMessageIds: string[];
}

/**
 * Bounded replay of due Vobiz events (deferred ones, and claims whose
 * worker died): at most `limit` per run, each at most WEBHOOK_MAX_ATTEMPTS
 * times in total, so this can never loop. Run from the dispatch cron.
 */
export async function replayDueVobizWebhookEvents(
  supabaseAdmin: Client,
  opts: { now?: Date; limit?: number } = {},
): Promise<ReplaySummary> {
  const now = opts.now ?? new Date();
  const summary: ReplaySummary = {
    examined: 0,
    processed: 0,
    deferred: 0,
    retained: 0,
    failed: 0,
    newInboundTextMessageIds: [],
  };
  const { data: due, error } = await supabaseAdmin
    .from("webhook_events")
    .select(EVENT_COLUMNS)
    .eq("provider", VOBIZ_WEBHOOK_PROVIDER)
    .is("processed_at", null)
    .not("next_attempt_at", "is", null)
    .lte("next_attempt_at", now.toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(opts.limit ?? 50);
  if (error) throw error;
  for (const row of (due ?? []) as EventRow[]) {
    summary.examined++;
    const claimed = await claimExisting(supabaseAdmin, row, now);
    if (!claimed) continue;
    try {
      const r = await applyClaimed(supabaseAdmin, claimed, now);
      if (r.outcome === "processed") summary.processed++;
      else if (r.outcome === "deferred") summary.deferred++;
      else summary.retained++;
      summary.newInboundTextMessageIds.push(...r.newInboundTextMessageIds);
    } catch (err) {
      summary.failed++;
      console.error("whatsapp_webhook:replay_failed", {
        eventId: row.event_id,
        code: (err as { code?: string } | null)?.code ?? null,
      });
    }
  }
  return summary;
}
