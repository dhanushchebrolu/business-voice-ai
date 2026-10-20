/**
 * The WhatsApp notification worker: sends the rows database triggers put in
 * whatsapp_notifications (20261020090000_whatsapp_notifications_and_
 * campaigns.sql) — booking confirmed / rescheduled / cancelled, payment
 * link, payment captured / failed / expired — and enqueues 24-hour
 * reminders.
 *
 * Exactly one logical notification per row:
 *   - A row is claimed with a conditional update (status pending, or a
 *     'sending' claim abandoned for CLAIM_TIMEOUT_MS, and the attempt count
 *     unchanged), so two workers never process it at once.
 *   - The message itself carries an idempotency key (unique per number for
 *     live messages), so the inline fast paths (request_payment, the
 *     payment webhook's consumer) and this worker can't both deliver it.
 *   - Before sending, the CURRENT booking/payment state is re-read: a
 *     confirmation for a booking cancelled since, a reschedule superseded
 *     by a later one, a reminder for a moved booking, a payment link for a
 *     paid or closed request — all end 'skipped' with the reason.
 *   - Payment truth is never touched here: this only reads payment_requests
 *     and bookings, and only a verified Razorpay webhook changes them.
 *
 * Failures: retried with exponential backoff up to MAX_ATTEMPTS when safe
 * (Meta answered 429/5xx, or a transient database error); a send whose
 * outcome is unknown (timeout after the request left) is never repeated.
 * Rows older than STALE_AFTER_MS are skipped rather than sent late.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { DeliveryDeps } from "./whatsapp-outbound.server.ts";
import {
  sendBusinessWhatsAppMessage,
  type BusinessMessageResult,
  type MessagePurpose,
} from "./whatsapp-business-message.server.ts";
import { sendWhatsAppPaymentMessage, paymentLinkMessageText } from "./whatsapp-payments.server.ts";
import { composePaymentNotification } from "../payments/payment-whatsapp-consumer.server.ts";
import type { PaymentDomainEventType } from "../payments/payment-events.server.ts";

type Client = SupabaseClient<Database>;
type NotificationRow = Database["public"]["Tables"]["whatsapp_notifications"]["Row"];

export const MAX_ATTEMPTS = 5;
export const CLAIM_TIMEOUT_MS = 5 * 60_000;
export const STALE_AFTER_MS = 48 * 60 * 60_000;
export const BATCH_SIZE = 50;
export const REMINDER_LEAD_MS = 24 * 60 * 60_000;
/** Reminders are enqueued for bookings starting in [lead - window, lead]. */
export const REMINDER_WINDOW_MS = 60 * 60_000;

const ACTIVE_STATUSES = ["CONFIRMED", "RESCHEDULED", "CALENDAR_SYNC_FAILED"];

const PAYMENT_EVENT_FOR_KIND: Record<string, PaymentDomainEventType> = {
  payment_captured: "PAYMENT_CAPTURED",
  payment_captured_after_expiry: "PAYMENT_CAPTURED_AFTER_EXPIRY",
  payment_failed: "PAYMENT_FAILED",
  payment_expired: "PAYMENT_EXPIRED",
};

export function backoffMs(attempts: number): number {
  return Math.min(60, 2 ** attempts) * 60_000;
}

function sameInstant(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

/** "Mon, 20 Oct, 10:30 am" in the booking's own timezone. */
export function formatWhen(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}

function firstName(name: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first.slice(0, 40) : "there";
}

/**
 * The text of a booking notification and its template body parameters
 * ({{1}} customer first name, {{2}} business name, {{3}} date and time).
 */
export function bookingNotificationText(
  kind: "booking_confirmed" | "booking_rescheduled" | "booking_cancelled" | "booking_reminder",
  params: { customerName: string | null; businessName: string; startAt: string; timezone: string },
): { bodyText: string; templateBodyParams: string[] } {
  const name = firstName(params.customerName);
  const when = formatWhen(params.startAt, params.timezone);
  const business = params.businessName.slice(0, 60);
  const bodyText = {
    booking_confirmed: `Hi ${name}, your appointment at ${business} is confirmed for ${when}.`,
    booking_rescheduled: `Hi ${name}, your appointment at ${business} has been moved to ${when}.`,
    booking_cancelled: `Hi ${name}, your appointment at ${business} on ${when} has been cancelled.`,
    booking_reminder: `Hi ${name}, this is a reminder of your appointment at ${business} on ${when}.`,
  }[kind];
  return { bodyText, templateBodyParams: [name, business, when] };
}

type Decision =
  | { status: "sent"; messageRowId: string | null }
  | { status: "skipped"; reason: string }
  | { status: "retry"; error: string }
  | { status: "failed"; error: string };

function decide(result: BusinessMessageResult): Decision {
  switch (result.outcome) {
    case "sent":
      return { status: "sent", messageRowId: result.messageRowId };
    case "skipped":
      return { status: "skipped", reason: result.reason };
    case "skipped_duplicate":
      // Another path holds this message. Delivered → this notification is
      // done; still queued (in flight, or a crashed sender) → check later.
      return result.existingStatus && result.existingStatus !== "queued"
        ? { status: "sent", messageRowId: null }
        : { status: "retry", error: "Another sender holds this message; outcome not yet known." };
    case "failed":
      return result.retryable
        ? { status: "retry", error: result.error }
        : { status: "failed", error: result.error };
  }
}

/** Map the payment module's (older) result shape onto the same decision. */
function decidePayment(result: Awaited<ReturnType<typeof sendWhatsAppPaymentMessage>>): Decision {
  switch (result.outcome) {
    case "sent":
      return { status: "sent", messageRowId: null };
    case "skipped_duplicate":
      return { status: "sent", messageRowId: null };
    case "skipped_no_connection":
      return { status: "skipped", reason: "no_connection" };
    case "skipped_not_permitted":
      return { status: "skipped", reason: result.reason ?? "not_permitted" };
    case "failed":
      return result.retryable
        ? { status: "retry", error: result.error ?? "send failed" }
        : { status: "failed", error: result.error ?? "send failed" };
  }
}

async function notificationsEnabled(
  supabaseAdmin: Client,
  organizationId: string,
  businessId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_connections")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("business_id", businessId)
    .eq("status", "connected")
    .eq("notifications_enabled", true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function processBookingNotification(
  supabaseAdmin: Client,
  row: NotificationRow,
  now: Date,
  deps: DeliveryDeps,
): Promise<Decision> {
  const kind = row.kind as
    "booking_confirmed" | "booking_rescheduled" | "booking_cancelled" | "booking_reminder";
  const { data: booking, error } = await supabaseAdmin
    .from("bookings")
    .select("id, status, start_at, timezone, customer_name, customer_phone")
    .eq("id", row.booking_id ?? "")
    .eq("organization_id", row.organization_id)
    .eq("business_id", row.business_id)
    .maybeSingle();
  if (error) throw error;
  if (!booking) return { status: "skipped", reason: "booking_not_found" };
  if (!booking.customer_phone) return { status: "skipped", reason: "no_phone" };

  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const future = new Date(booking.start_at).getTime() > now.getTime();
  const active = ACTIVE_STATUSES.includes(booking.status);
  const current =
    kind === "booking_cancelled"
      ? booking.status === "CANCELLED" && future
      : kind === "booking_confirmed"
        ? active && future
        : active && future && sameInstant(payload["start_at"], booking.start_at);
  if (!current) return { status: "skipped", reason: "superseded" };

  const { data: business, error: businessError } = await supabaseAdmin
    .from("businesses")
    .select("name")
    .eq("id", row.business_id)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (businessError) throw businessError;

  const text = bookingNotificationText(kind, {
    customerName: booking.customer_name,
    businessName: business?.name ?? "us",
    startAt: booking.start_at,
    timezone: booking.timezone,
  });
  return decide(
    await sendBusinessWhatsAppMessage(
      supabaseAdmin,
      {
        organizationId: row.organization_id,
        businessId: row.business_id,
        customerPhone: booking.customer_phone,
        purpose: kind as MessagePurpose,
        scope: "transactional",
        idempotencyKey: row.dedupe_key,
        bodyText: text.bodyText,
        templateBodyParams: text.templateBodyParams,
        metadata: { booking_id: booking.id, notification_id: row.id },
      },
      deps,
    ),
  );
}

async function processPaymentNotification(
  supabaseAdmin: Client,
  row: NotificationRow,
  deps: DeliveryDeps,
): Promise<Decision> {
  const { data: pr, error } = await supabaseAdmin
    .from("payment_requests")
    .select("id, booking_id, status, payment_link_url")
    .eq("id", row.payment_request_id ?? "")
    .eq("organization_id", row.organization_id)
    .eq("business_id", row.business_id)
    .maybeSingle();
  if (error) throw error;
  if (!pr) return { status: "skipped", reason: "payment_request_not_found" };
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (row.kind === "payment_link") {
    // Only an open request with a link: a paid, expired or cancelled one
    // must not get a "please pay" message.
    if (!["CREATED", "PENDING"].includes(pr.status) || !pr.payment_link_url) {
      return { status: "skipped", reason: "superseded" };
    }
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from("bookings")
      .select("customer_phone, status")
      .eq("id", pr.booking_id)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    if (bookingError) throw bookingError;
    if (!booking?.customer_phone) return { status: "skipped", reason: "no_phone" };
    if (booking.status !== "PENDING_PAYMENT") return { status: "skipped", reason: "superseded" };
    return decidePayment(
      await sendWhatsAppPaymentMessage(
        supabaseAdmin,
        {
          organizationId: row.organization_id,
          businessId: row.business_id,
          bookingId: pr.booking_id,
          paymentRequestId: pr.id,
          customerPhone: booking.customer_phone,
          purpose: "payment_link",
          bodyText: paymentLinkMessageText(pr.payment_link_url),
        },
        fetchImpl,
      ),
    );
  }

  const eventType = PAYMENT_EVENT_FOR_KIND[row.kind];
  if (!eventType) return { status: "skipped", reason: "unknown_kind" };
  const notification = await composePaymentNotification(supabaseAdmin, {
    event_type: eventType,
    booking_id: pr.booking_id,
    payment_request_id: pr.id,
  });
  if (!notification) return { status: "skipped", reason: "nothing_to_send" };
  return decidePayment(
    await sendWhatsAppPaymentMessage(
      supabaseAdmin,
      {
        organizationId: row.organization_id,
        businessId: row.business_id,
        bookingId: pr.booking_id,
        paymentRequestId: pr.id,
        customerPhone: notification.customerPhone,
        purpose: notification.purpose,
        bodyText: notification.bodyText,
      },
      fetchImpl,
    ),
  );
}

/**
 * Claims one row; null when another worker has it or it changed. Two plain
 * conditional updates (a pending row, or a 'sending' claim abandoned for
 * CLAIM_TIMEOUT_MS), each also requiring the attempt count it read — real
 * PostgREST rejects an or() filter on an UPDATE, so none is used here.
 */
async function claim(
  supabaseAdmin: Client,
  row: NotificationRow,
  now: Date,
): Promise<NotificationRow | null> {
  const staleCutoff = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString();
  const update = { status: "sending", locked_at: now.toISOString(), attempts: row.attempts + 1 };
  const fresh = await supabaseAdmin
    .from("whatsapp_notifications")
    .update(update)
    .eq("id", row.id)
    .eq("attempts", row.attempts)
    .eq("status", "pending")
    .select("*");
  if (fresh.error) throw fresh.error;
  if (fresh.data && fresh.data.length > 0) return fresh.data[0]!;
  const stale = await supabaseAdmin
    .from("whatsapp_notifications")
    .update(update)
    .eq("id", row.id)
    .eq("attempts", row.attempts)
    .eq("status", "sending")
    .lt("locked_at", staleCutoff)
    .select("*");
  if (stale.error) throw stale.error;
  return stale.data && stale.data.length > 0 ? stale.data[0]! : null;
}

export type NotificationOutcome = "sent" | "skipped" | "retry" | "failed" | "busy";

export async function processNotification(
  supabaseAdmin: Client,
  row: NotificationRow,
  deps: DeliveryDeps = {},
): Promise<NotificationOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const claimed = await claim(supabaseAdmin, row, now);
  if (!claimed) return "busy";

  let decision: Decision;
  if (now.getTime() - new Date(claimed.created_at).getTime() > STALE_AFTER_MS) {
    decision = { status: "skipped", reason: "stale" };
  } else {
    try {
      decision = !(await notificationsEnabled(
        supabaseAdmin,
        claimed.organization_id,
        claimed.business_id,
      ))
        ? { status: "skipped", reason: "notifications_disabled" }
        : claimed.kind.startsWith("booking_")
          ? await processBookingNotification(supabaseAdmin, claimed, now, deps)
          : await processPaymentNotification(supabaseAdmin, claimed, deps);
    } catch (err) {
      decision = {
        status: "retry",
        error:
          err instanceof Error
            ? err.message
            : String((err as { message?: unknown })?.message ?? err),
      };
    }
  }

  const update: Database["public"]["Tables"]["whatsapp_notifications"]["Update"] = {
    locked_at: null,
  };
  let outcome: NotificationOutcome;
  switch (decision.status) {
    case "sent":
      outcome = "sent";
      update.status = "sent";
      update.sent_at = now.toISOString();
      update.last_error = null;
      if (decision.messageRowId) update.whatsapp_message_id = decision.messageRowId;
      break;
    case "skipped":
      outcome = "skipped";
      update.status = "skipped";
      update.skip_reason = decision.reason;
      break;
    case "retry":
      if (claimed.attempts >= MAX_ATTEMPTS) {
        outcome = "failed";
        update.status = "failed";
      } else {
        outcome = "retry";
        update.status = "pending";
        update.next_attempt_at = new Date(
          now.getTime() + backoffMs(claimed.attempts),
        ).toISOString();
      }
      update.last_error = decision.error.slice(0, 500);
      break;
    case "failed":
      outcome = "failed";
      update.status = "failed";
      update.last_error = decision.error.slice(0, 500);
      break;
  }
  const { error } = await supabaseAdmin
    .from("whatsapp_notifications")
    .update(update)
    .eq("id", claimed.id)
    .eq("status", "sending");
  if (error) {
    console.error("whatsapp_notifications:result_unrecorded", { id: claimed.id, outcome });
  }
  if (outcome === "failed") {
    console.warn("whatsapp_notifications:failed", { id: claimed.id, kind: claimed.kind });
  }
  return outcome;
}

/**
 * Enqueues 24-hour reminders: active bookings starting within the next
 * [REMINDER_LEAD_MS - REMINDER_WINDOW_MS, REMINDER_LEAD_MS], created at
 * least an hour ago (a booking made just now already got its
 * confirmation). The key includes the start time, so a moved booking gets
 * a reminder for its new time. Businesses without notifications enabled
 * are filtered by the database function itself.
 */
export async function enqueueDueReminders(supabaseAdmin: Client, now: Date): Promise<number> {
  const from = new Date(now.getTime() + REMINDER_LEAD_MS - REMINDER_WINDOW_MS).toISOString();
  const to = new Date(now.getTime() + REMINDER_LEAD_MS).toISOString();
  const createdBefore = new Date(now.getTime() - 60 * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select("id, organization_id, business_id, start_at, end_at, status, customer_phone")
    .in("status", ACTIVE_STATUSES)
    .gte("start_at", from)
    .lte("start_at", to)
    .lte("created_at", createdBefore)
    .not("customer_phone", "is", null)
    .limit(500);
  if (error) throw error;
  let enqueued = 0;
  for (const b of data ?? []) {
    const epoch = Math.floor(new Date(b.start_at).getTime() / 1000);
    const { error: rpcError } = await supabaseAdmin.rpc("enqueue_whatsapp_notification", {
      p_organization_id: b.organization_id,
      p_business_id: b.business_id,
      p_booking_id: b.id,
      p_payment_request_id: null,
      p_kind: "booking_reminder",
      p_dedupe_key: `booking_reminder:${b.id}:${epoch}`,
      p_payload: { start_at: b.start_at, end_at: b.end_at, status: b.status },
      p_delay: "0 seconds",
    });
    if (rpcError) throw rpcError;
    enqueued++;
  }
  return enqueued;
}

export async function processDueNotifications(
  supabaseAdmin: Client,
  deps: DeliveryDeps = {},
): Promise<Record<NotificationOutcome, number>> {
  const now = (deps.now ?? (() => new Date()))();
  const counts: Record<NotificationOutcome, number> = {
    sent: 0,
    skipped: 0,
    retry: 0,
    failed: 0,
    busy: 0,
  };
  const { data, error } = await supabaseAdmin
    .from("whatsapp_notifications")
    .select("*")
    .in("status", ["pending", "sending"])
    .lte("next_attempt_at", now.toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;
  for (const row of data ?? []) {
    try {
      counts[await processNotification(supabaseAdmin, row, deps)]++;
    } catch (err) {
      // A claim/bookkeeping failure on one row never stops the batch.
      counts.retry++;
      console.error("whatsapp_notifications:error", {
        id: row.id,
        message:
          err instanceof Error
            ? err.message
            : String((err as { message?: unknown })?.message ?? err),
      });
    }
  }
  return counts;
}
