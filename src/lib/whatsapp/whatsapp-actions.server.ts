/**
 * Bookings, reschedules and payments from a WhatsApp conversation — the
 * model proposes, the customer confirms, the server executes.
 *
 * The model never calls book_appointment / reschedule_appointment /
 * create_payment_required_booking / request_payment directly on WhatsApp.
 * It gets three channel tools instead:
 *   - list_my_bookings: the sender's own upcoming bookings at this business.
 *   - propose_booking / propose_reschedule: validate, check permission and
 *     ownership, and store ONE pending action for the conversation
 *     (whatsapp_pending_actions), then tell the model to ask for YES/NO.
 * When the customer's next message is a clear YES — and the reply that showed
 * them the proposal was actually sent — handlePendingActionReply
 * executes exactly that stored action (claimed once: awaiting → executing)
 * through the existing tool layer (executeAiTool — same capability checks,
 * same atomic availability/overlap re-check in the database), and the
 * reply is composed by the server from the real result, not by the model.
 *
 * Identity: the customer is the WhatsApp sender (wa_id), which Meta
 * verifies. It is injected as the booking's phone — never taken from the
 * model — and a reschedule is only allowed for a booking that number owns
 * (callerOwnsBooking, the same rule voice uses for caller ID), passed as
 * the exact confirmed move (rescheduleAuthorization).
 *
 * Payment: a service with a price, for an agent allowed to take payments,
 * becomes a payment hold plus a Razorpay payment link
 * (createPaymentRequiredBooking + request_payment, unchanged). The amount
 * comes from the service's configured price — never from the model — and
 * the booking is confirmed only by the verified payment webhook.
 *
 * Cancellations are not automated on WhatsApp: the AI hands those to staff.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import type { ChannelTool } from "../shared-agent-reply.server.ts";
import { formatWhen } from "./whatsapp-notifications.server.ts";

type Client = SupabaseClient<Database>;

export const PENDING_ACTION_TTL_MS = 15 * 60_000;
const MAX_APPOINTMENT_MS = 8 * 60 * 60_000;

/** Registry tools the model may not call directly on WhatsApp (they go through propose → YES). */
export const WHATSAPP_DIRECT_TOOL_BLOCKLIST = [
  "book_appointment",
  "reschedule_appointment",
  "create_payment_required_booking",
  "request_payment",
  "check_payment_status",
] as const;

export interface WhatsAppActionContext {
  organizationId: string;
  businessId: string;
  agentConfigId: string;
  conversationId: string;
  /** The verified sender, digits only. */
  waId: string;
  customerDisplayName: string | null;
  inboundMessageId: string;
  timezone: string;
  country: string | null;
  now: Date;
}

function ok(data: Record<string, unknown>) {
  return { content: JSON.stringify({ success: true, ...data }), isError: false };
}
function refuse(code: string, message: string) {
  return { content: JSON.stringify({ success: false, error: { code, message } }), isError: true };
}
function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function validRange(startIso: string | undefined, endIso: string | undefined, now: Date) {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  if (end <= start || end.getTime() - start.getTime() > MAX_APPOINTMENT_MS) return null;
  if (start.getTime() <= now.getTime()) return null;
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function capabilities(supabaseAdmin: Client, ctx: WhatsAppActionContext) {
  const { data, error } = await supabaseAdmin
    .from("agent_configs")
    .select("id, organization_id, business_id, capabilities")
    .eq("id", ctx.agentConfigId)
    .eq("organization_id", ctx.organizationId)
    .eq("business_id", ctx.businessId)
    .maybeSingle();
  if (error) throw error;
  return (data?.capabilities as Record<string, unknown> | null) ?? {};
}

async function storeProposal(
  supabaseAdmin: Client,
  ctx: WhatsAppActionContext,
  action: "book" | "book_with_payment" | "reschedule",
  params: Record<string, unknown>,
  summary: string,
  isActive?: () => boolean,
) {
  // A reply attempt that has already been abandoned (it timed out and the
  // worker moved on) must not leave a proposal behind that nobody was shown.
  if (isActive && !isActive()) {
    return refuse("REPLY_ABANDONED", "This reply attempt was abandoned; nothing was proposed.");
  }
  // One open proposal per conversation: a new one replaces the old.
  const { error: supersedeError } = await supabaseAdmin
    .from("whatsapp_pending_actions")
    .update({ status: "superseded" })
    .eq("conversation_id", ctx.conversationId)
    .eq("organization_id", ctx.organizationId)
    .eq("status", "awaiting_confirmation");
  if (supersedeError) throw supersedeError;
  const { error } = await supabaseAdmin.from("whatsapp_pending_actions").insert({
    organization_id: ctx.organizationId,
    business_id: ctx.businessId,
    conversation_id: ctx.conversationId,
    proposed_in_message_id: ctx.inboundMessageId,
    action,
    params: params as Json,
    summary,
    expires_at: new Date(ctx.now.getTime() + PENDING_ACTION_TTL_MS).toISOString(),
  });
  if (error) throw error;
  return ok({
    status: "awaiting_customer_confirmation",
    summary,
    instruction:
      "Nothing is booked or changed yet. Repeat the summary to the customer and ask them to reply YES to confirm or NO to cancel. Never say it is booked or changed until they confirm.",
  });
}

type ToolOutput = { content: string; isError?: boolean };

/** The existing tool layer, injectable for tests. Defaults to the real modules. */
export interface WhatsAppActionDeps {
  fetchImpl?: typeof fetch | undefined;
  executeTool?: (
    ctx: {
      organizationId: string;
      businessId: string;
      agentConfigId: string;
      source: "whatsapp";
      fetchImpl?: typeof fetch;
    },
    name: string,
    input: Record<string, unknown>,
  ) => Promise<ToolOutput>;
  ownsBooking?: (input: {
    organizationId: string;
    businessId: string;
    bookingId: string;
    callerE164: string;
    country: string | null;
  }) => Promise<boolean>;
  /**
   * Whether the reply this tool call belongs to is still live. Set by the
   * reply worker per generation attempt; a proposal is refused once the
   * attempt was abandoned (e.g. timed out).
   */
  isActive?: (() => boolean) | undefined;
  guardOwnership?: (
    ctx: {
      organizationId: string;
      businessId: string;
      callerE164: string;
      phoneCountry: string | null;
      rescheduleAuthorization: { bookingId: string; newStartIso: string; newEndIso: string };
    },
    input: Record<string, unknown>,
  ) => Promise<ToolOutput | null>;
}

async function realExecuteTool(
  supabaseAdmin: Client,
  ...args: Parameters<NonNullable<WhatsAppActionDeps["executeTool"]>>
): Promise<ToolOutput> {
  const { executeAiTool } = await import("../ai-tools.server.ts");
  return executeAiTool(supabaseAdmin, ...args);
}

/** The channel tools offered to the model on WhatsApp. */
export function buildWhatsAppActionTools(
  supabaseAdmin: Client,
  ctx: WhatsAppActionContext,
  deps: WhatsAppActionDeps = {},
): ChannelTool[] {
  return [
    {
      schema: {
        name: "list_my_bookings",
        description:
          "List this customer's own upcoming bookings at this business (identified by their WhatsApp number). Use before proposing a reschedule.",
        input_schema: { type: "object", properties: {} },
      },
      async execute() {
        const { findCallerUpcomingBookings } =
          await import("../calendar/caller-bookings.server.ts");
        const bookings = await findCallerUpcomingBookings(supabaseAdmin, {
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          callerE164: `+${ctx.waId}`,
          country: ctx.country,
          now: ctx.now,
        });
        return ok({
          bookings: bookings.map((b) => ({
            bookingId: b.id,
            startIso: b.startAt,
            endIso: b.endAt,
            when: formatWhen(b.startAt, b.timezone),
            service: b.serviceName,
            status: b.status,
          })),
        });
      },
    },
    {
      schema: {
        name: "propose_booking",
        description:
          "Propose a NEW appointment for this customer after checking availability. This does not book anything: the customer must reply YES. Use the exact start/end of an available slot.",
        input_schema: {
          type: "object",
          properties: {
            startIso: { type: "string", description: "Start, ISO 8601." },
            endIso: { type: "string", description: "End, ISO 8601." },
            serviceId: { type: "string", description: "The service id, if known." },
            customerName: { type: "string", description: "The customer's name." },
            notes: { type: "string" },
          },
          required: ["startIso", "endIso"],
        },
      },
      async execute(input) {
        const range = validRange(str(input, "startIso"), str(input, "endIso"), ctx.now);
        if (!range) {
          return refuse(
            "INVALID_TOOL_INPUT",
            "A future start and a later end (at most 8 hours) are required.",
          );
        }
        const caps = await capabilities(supabaseAdmin, ctx);
        if (caps["calendar_book"] !== true && caps["booking_payment_required"] !== true) {
          return refuse("TOOL_NOT_PERMITTED", "This business doesn't take bookings over WhatsApp.");
        }
        const serviceId = str(input, "serviceId");
        let service: { id: string; name: string; price: number | null; currency: string } | null =
          null;
        if (serviceId) {
          const { data, error } = await supabaseAdmin
            .from("services")
            .select("id, name, price, currency, is_active")
            .eq("id", serviceId)
            .eq("organization_id", ctx.organizationId)
            .eq("business_id", ctx.businessId)
            .maybeSingle();
          if (error) throw error;
          if (!data || !data.is_active)
            return refuse("INVALID_SERVICE", "That service isn't offered.");
          service = data;
        }
        const needsPayment =
          service !== null &&
          (service.price ?? 0) > 0 &&
          caps["booking_payment_required"] === true &&
          caps["payment_request"] === true;
        if (!needsPayment && caps["calendar_book"] !== true) {
          return refuse("TOOL_NOT_PERMITTED", "This business doesn't take bookings over WhatsApp.");
        }
        const customerName = str(input, "customerName") ?? ctx.customerDisplayName ?? undefined;
        const when = formatWhen(range.startIso, ctx.timezone);
        const amountMinorUnits = needsPayment ? Math.round(service!.price! * 100) : null;
        const summary = needsPayment
          ? `${service!.name} on ${when}, held until you pay ${service!.currency} ${(amountMinorUnits! / 100).toFixed(2)} by the payment link`
          : `${service ? `${service.name} on ` : "An appointment on "}${when}`;
        return storeProposal(
          supabaseAdmin,
          ctx,
          needsPayment ? "book_with_payment" : "book",
          {
            ...range,
            serviceId: service?.id ?? null,
            customerName: customerName ?? null,
            notes: str(input, "notes") ?? null,
            amountMinorUnits,
            currency: needsPayment ? service!.currency : null,
          },
          summary,
          deps.isActive,
        );
      },
    },
    {
      schema: {
        name: "propose_reschedule",
        description:
          "Propose moving one of this customer's own bookings (from list_my_bookings) to a new available time. Nothing changes until the customer replies YES.",
        input_schema: {
          type: "object",
          properties: {
            bookingId: { type: "string" },
            newStartIso: { type: "string" },
            newEndIso: { type: "string" },
          },
          required: ["bookingId", "newStartIso", "newEndIso"],
        },
      },
      async execute(input) {
        const bookingId = str(input, "bookingId");
        const range = validRange(str(input, "newStartIso"), str(input, "newEndIso"), ctx.now);
        if (!bookingId || !range) {
          return refuse("INVALID_TOOL_INPUT", "bookingId and a future new start/end are required.");
        }
        const caps = await capabilities(supabaseAdmin, ctx);
        if (caps["calendar_reschedule"] !== true) {
          return refuse("TOOL_NOT_PERMITTED", "This business doesn't reschedule over WhatsApp.");
        }
        const ownership = {
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          bookingId,
          callerE164: `+${ctx.waId}`,
          country: ctx.country,
        };
        const owned = deps.ownsBooking
          ? await deps.ownsBooking(ownership)
          : await (
              await import("../calendar/caller-bookings.server.ts")
            ).callerOwnsBooking(supabaseAdmin, ownership);
        // Same answer for "not yours" and "doesn't exist": reveals nothing.
        if (!owned) return refuse("NOT_FOUND", "No booking was found for this customer.");
        return storeProposal(
          supabaseAdmin,
          ctx,
          "reschedule",
          { bookingId, newStartIso: range.startIso, newEndIso: range.endIso },
          `Move your booking to ${formatWhen(range.startIso, ctx.timezone)}`,
          deps.isActive,
        );
      },
    },
  ];
}

const YES =
  /^(yes|y|yes please|yeah|yep|ok|okay|sure|confirm|confirmed|go ahead|haan|haa|ha|ji|ji haan|theek hai|👍|✅)[.!\s]*$/iu;
const NO = /^(no|n|nope|cancel|don'?t|do not|stop that|nahi|nahin|na|❌)[.!\s]*$/iu;

export function parseConfirmation(text: string): "yes" | "no" | null {
  const t = text.trim();
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  return null;
}

interface ToolOutcome {
  success: boolean;
  bookingOutcome?: string;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

function parseTool(content: string): ToolOutcome {
  try {
    return JSON.parse(content) as ToolOutcome;
  } catch {
    return { success: false, error: { code: "UNKNOWN" } };
  }
}

function failureText(outcome: ToolOutcome): string {
  switch (outcome.error?.code) {
    case "SLOT_NO_LONGER_AVAILABLE":
    case "SLOT_OUTSIDE_SCHEDULE":
      return "Sorry — that time is no longer available, so nothing was booked. Would you like another time?";
    case "TOOL_NOT_PERMITTED":
    case "PERMISSION_DENIED":
      return "Sorry — I can't do that here. Our team will help you.";
    case "MERCHANT_NOT_CONNECTED":
      return "Sorry — online payment isn't available right now, so nothing was booked. Our team will help you.";
    case "CALLER_CONFIRMATION_REQUIRED":
    case "NOT_FOUND":
      return "Sorry — I couldn't find that booking for this number, so nothing was changed.";
    case "BOOKING_SYNC_PENDING":
      return "That booking is still being updated, so it can't be moved right now. Please try again in a few minutes.";
    default:
      return "Sorry — something went wrong and nothing was changed. Our team will follow up.";
  }
}

export type PendingActionOutcome =
  | { handled: false }
  | { handled: true; status: "completed" | "declined" | "failed" | "busy"; reply: string | null };

/**
 * If the conversation has a proposal waiting and this message is a clear
 * YES or NO, act on it and return the reply text. Anything else leaves the
 * proposal open and lets the AI answer normally.
 */
export async function handlePendingActionReply(
  supabaseAdmin: Client,
  ctx: WhatsAppActionContext & { messageText: string },
  deps: WhatsAppActionDeps = {},
): Promise<PendingActionOutcome> {
  const { data: pending, error } = await supabaseAdmin
    .from("whatsapp_pending_actions")
    .select("*")
    .eq("conversation_id", ctx.conversationId)
    .eq("organization_id", ctx.organizationId)
    .eq("status", "awaiting_confirmation")
    .maybeSingle();
  if (error) throw error;
  if (!pending) return { handled: false };
  if (new Date(pending.expires_at).getTime() <= ctx.now.getTime()) {
    await supabaseAdmin
      .from("whatsapp_pending_actions")
      .update({ status: "expired" })
      .eq("id", pending.id)
      .eq("status", "awaiting_confirmation");
    return { handled: false };
  }
  // A proposal is only confirmed by a later message, never the one that made it.
  if (pending.proposed_in_message_id === ctx.inboundMessageId) return { handled: false };
  const answer = parseConfirmation(ctx.messageText);
  if (!answer) return { handled: false };
  // Only a proposal the customer was actually shown can be confirmed: the
  // reply to the message that produced it must have been sent. A reply that
  // failed, was never generated, or whose delivery is unknown leaves
  // nothing to say YES to.
  let shown = false;
  if (pending.proposed_in_message_id) {
    const { data: shownReply, error: shownError } = await supabaseAdmin
      .from("whatsapp_messages")
      .select("id")
      .eq("reply_to_message_id", pending.proposed_in_message_id)
      .eq("organization_id", ctx.organizationId)
      .in("status", ["sent", "delivered", "read"])
      .limit(1)
      .maybeSingle();
    if (shownError) throw shownError;
    shown = Boolean(shownReply);
  }
  if (!shown) {
    await supabaseAdmin
      .from("whatsapp_pending_actions")
      .update({ status: "superseded" })
      .eq("id", pending.id)
      .eq("status", "awaiting_confirmation");
    return { handled: false };
  }

  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("whatsapp_pending_actions")
    .update({
      status: answer === "yes" ? "executing" : "declined",
      decided_by_message_id: ctx.inboundMessageId,
    })
    .eq("id", pending.id)
    .eq("status", "awaiting_confirmation")
    .select("id");
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) return { handled: true, status: "busy", reply: null };
  if (answer === "no") {
    return {
      handled: true,
      status: "declined",
      reply: "No problem — nothing was booked or changed.",
    };
  }

  const params = pending.params as Record<string, unknown>;
  const toolCtx = {
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    agentConfigId: ctx.agentConfigId,
    source: "whatsapp" as const,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const executeTool = (name: string, input: Record<string, unknown>) =>
    deps.executeTool
      ? deps.executeTool(toolCtx, name, input)
      : realExecuteTool(supabaseAdmin, toolCtx, name, input);
  let reply: string;
  let succeeded = false;
  let result: Record<string, unknown> = {};
  try {
    if (pending.action === "reschedule") {
      const input = {
        bookingId: params["bookingId"],
        newStartIso: params["newStartIso"],
        newEndIso: params["newEndIso"],
      };
      // The exact move the customer confirmed, for the number that owns the booking.
      const guardCtx = {
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        callerE164: `+${ctx.waId}`,
        phoneCountry: ctx.country,
        rescheduleAuthorization: {
          bookingId: String(params["bookingId"]),
          newStartIso: String(params["newStartIso"]),
          newEndIso: String(params["newEndIso"]),
        },
      };
      const refusal = deps.guardOwnership
        ? await deps.guardOwnership(guardCtx, input)
        : await (
            await import("../calendar/caller-bookings.server.ts")
          ).guardBookingOwnership(supabaseAdmin, guardCtx, "reschedule_appointment", input);
      const outcome = parseTool(
        (refusal ?? (await executeTool("reschedule_appointment", input))).content,
      );
      succeeded = outcome.success;
      result = { ...outcome };
      reply = outcome.success
        ? `Done — your booking is moved to ${formatWhen(String(params["newStartIso"]), ctx.timezone)}.`
        : failureText(outcome);
    } else {
      const bookingInput = {
        startIso: params["startIso"],
        endIso: params["endIso"],
        ...(params["serviceId"] ? { serviceId: params["serviceId"] } : {}),
        ...(params["customerName"] ? { customerName: params["customerName"] } : {}),
        ...(params["notes"] ? { notes: params["notes"] } : {}),
        // The verified WhatsApp sender — never a number the model chose.
        customerPhone: `+${ctx.waId}`,
      };
      const when = formatWhen(String(params["startIso"]), ctx.timezone);
      if (pending.action === "book") {
        const outcome = parseTool((await executeTool("book_appointment", bookingInput)).content);
        succeeded = outcome.success;
        result = { ...outcome };
        reply = !outcome.success
          ? failureText(outcome)
          : outcome.bookingOutcome === "confirmed"
            ? `Booked — see you on ${when}.`
            : `Your booking for ${when} is saved; our team will confirm it shortly.`;
      } else {
        const hold = parseTool(
          (await executeTool("create_payment_required_booking", bookingInput)).content,
        );
        result = { hold };
        const bookingId = hold.data?.["id"];
        if (!hold.success || typeof bookingId !== "string") {
          reply = failureText(hold);
        } else {
          const payment = parseTool(
            (
              await executeTool("request_payment", {
                bookingId,
                // The service's own price, captured at proposal time — never the model's.
                amountMinorUnits: params["amountMinorUnits"],
                currency: params["currency"],
              })
            ).content,
          );
          result = { hold, payment };
          succeeded = payment.success;
          const link = payment.data?.["paymentLinkUrl"];
          const linkSent = payment.data?.["whatsappSent"] === true;
          reply = !payment.success
            ? `I've held ${when} for you, but couldn't create the payment link: ${failureText(payment)}`
            : linkSent
              ? `I've held ${when} for you and sent the payment link. Your booking is confirmed once the payment is received.`
              : typeof link === "string"
                ? `I've held ${when} for you. Please pay here to confirm: ${link}`
                : `I've held ${when} for you. We'll send the payment link shortly.`;
        }
      }
    }
  } catch (err) {
    await supabaseAdmin
      .from("whatsapp_pending_actions")
      .update({
        status: "failed",
        error: err instanceof Error ? err.message.slice(0, 500) : "error",
      })
      .eq("id", pending.id);
    return {
      handled: true,
      status: "failed",
      reply: "Sorry — something went wrong and I couldn't confirm that. Our team will follow up.",
    };
  }
  await supabaseAdmin
    .from("whatsapp_pending_actions")
    .update({ status: succeeded ? "completed" : "failed", result: result as Json })
    .eq("id", pending.id);
  return { handled: true, status: succeeded ? "completed" : "failed", reply };
}

/** Closes proposals nobody answered in time (cron). */
export async function expirePendingActions(supabaseAdmin: Client, now: Date): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_pending_actions")
    .update({ status: "expired" })
    .eq("status", "awaiting_confirmation")
    .lt("expires_at", now.toISOString())
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}
