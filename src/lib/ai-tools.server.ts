/**
 * The AI tool registry — the one place that (a) declares every tool an
 * agent can be granted (Anthropic tool-use schema), (b) resolves which of
 * them a specific agent is actually permitted to use (default-deny, read
 * from agent_configs.capabilities), and (c) dispatches a model's tool_use
 * request to the real, already-tenant-validated implementation
 * (calendar-tools.server.ts / payment-tools.server.ts).
 *
 * SECURITY BOUNDARY: `organizationId`/`businessId`/`agentConfigId` are
 * NEVER read from the model's tool input — they come exclusively from
 * `ToolExecutionContext`, populated by the server from the authenticated
 * call/session, never from anything the LLM generated. This mirrors the
 * platform-wide rule against trusting a browser- or webhook-supplied
 * tenant id: here the untrusted source is the model's own JSON tool-call
 * arguments instead. Every tool input field below is a domain value
 * (a date, an amount, a booking id) the model is allowed to choose —
 * never an identity/ownership field.
 *
 * No tool in this registry can itself write payment_requests.status =
 * "CAPTURED" or create a Google Calendar event for a payment-required
 * booking — see payment-tools.server.ts's own header comment for where
 * that invariant is actually enforced.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { ClaudeTool } from "./claude.server.ts";
import { check_calendar_availability } from "./calendar/calendar-tools.server.ts";
import {
  create_payment_required_booking,
  request_payment,
  check_payment_status,
} from "./payments/payment-tools.server.ts";

type Client = SupabaseClient<Database>;

export interface ToolExecutionContext {
  organizationId: string;
  businessId: string;
  agentConfigId: string | null;
  /** The live call this turn belongs to, if any — threaded through to create_payment_required_booking so a later PaymentCaptured event can find the right in-progress call. */
  callId?: string | undefined;
  source: "voice" | "whatsapp" | "website" | "manual" | "instagram";
  fetchImpl?: typeof fetch;
}

interface ToolDefinition {
  capability: string;
  schema: ClaudeTool;
  execute: (
    supabaseAdmin: Client,
    ctx: ToolExecutionContext,
    input: Record<string, unknown>,
  ) => Promise<{ content: string; isError?: boolean }>;
}

function asToolOutput(result: { success: boolean } & Record<string, unknown>): {
  content: string;
  isError?: boolean;
} {
  return { content: JSON.stringify(result), isError: !result.success };
}

function invalidInput(message: string): { content: string; isError: boolean } {
  return {
    content: JSON.stringify({ success: false, error: { code: "INVALID_TOOL_INPUT", message } }),
    isError: true,
  };
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}
function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  check_calendar_availability: {
    capability: "calendar_read",
    schema: {
      name: "check_calendar_availability",
      description:
        "Check which appointment slots are available on a given date for this business. Use before offering a time to the caller.",
      input_schema: {
        type: "object",
        properties: {
          dateIso: { type: "string", description: "Date to check, as YYYY-MM-DD." },
          durationMinutes: {
            type: "number",
            description: "Requested appointment length in minutes.",
          },
          bufferMinutes: {
            type: "number",
            description: "Optional buffer time between appointments, in minutes.",
          },
        },
        required: ["dateIso", "durationMinutes"],
      },
    },
    async execute(supabaseAdmin, ctx, input) {
      const dateIso = str(input, "dateIso");
      const durationMinutes = num(input, "durationMinutes");
      if (!dateIso || durationMinutes === undefined) {
        return invalidInput("dateIso and durationMinutes are required.");
      }
      const bufferMinutes = num(input, "bufferMinutes");
      const result = await check_calendar_availability(supabaseAdmin, {
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        dateIso,
        durationMinutes,
        ...(bufferMinutes !== undefined ? { bufferMinutes } : {}),
      });
      return asToolOutput(result);
    },
  },

  create_payment_required_booking: {
    capability: "booking_payment_required",
    schema: {
      name: "create_payment_required_booking",
      description:
        "Place a temporary hold on an appointment slot that requires payment before it is confirmed. This does NOT confirm the booking or create a calendar event yet — call request_payment next to collect payment. The hold expires automatically if payment is not requested/completed in time.",
      input_schema: {
        type: "object",
        properties: {
          customerName: { type: "string" },
          customerPhone: {
            type: "string",
            description: "Customer's phone number, used to send the payment link over WhatsApp.",
          },
          customerEmail: { type: "string" },
          startIso: { type: "string", description: "Appointment start time, ISO 8601." },
          endIso: { type: "string", description: "Appointment end time, ISO 8601." },
          serviceId: { type: "string", description: "Optional service id, if known." },
        },
        required: ["startIso", "endIso"],
      },
    },
    async execute(supabaseAdmin, ctx, input) {
      const startIso = str(input, "startIso");
      const endIso = str(input, "endIso");
      if (!startIso || !endIso) return invalidInput("startIso and endIso are required.");

      const idempotencyKey = ctx.callId
        ? `voice:${ctx.callId}:${startIso}:${endIso}`
        : `${ctx.source}:${crypto.randomUUID()}`;

      const result = await create_payment_required_booking(supabaseAdmin, {
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        agentConfigId: ctx.agentConfigId ?? undefined,
        serviceId: str(input, "serviceId"),
        customerName: str(input, "customerName"),
        customerPhone: str(input, "customerPhone"),
        customerEmail: str(input, "customerEmail"),
        startIso,
        endIso,
        source: ctx.source,
        idempotencyKey,
        callId: ctx.callId,
      });
      return asToolOutput(result);
    },
  },

  request_payment: {
    capability: "payment_request",
    schema: {
      name: "request_payment",
      description:
        "Create a payment request (a Razorpay payment link) for a payment-required booking and send it to the customer over WhatsApp. This does NOT mark the payment as received — the customer must actually pay, and only a verified webhook confirms that. Amount is in the smallest currency unit (e.g. paise for INR, so ₹500 is 50000).",
      input_schema: {
        type: "object",
        properties: {
          bookingId: {
            type: "string",
            description:
              "The id of the payment-required booking returned by create_payment_required_booking.",
          },
          amountMinorUnits: {
            type: "integer",
            description: "Amount to charge, in the smallest currency unit (e.g. paise).",
          },
          currency: { type: "string", description: "ISO currency code, defaults to INR." },
          description: { type: "string" },
        },
        required: ["bookingId", "amountMinorUnits"],
      },
    },
    async execute(supabaseAdmin, ctx, input) {
      const bookingId = str(input, "bookingId");
      const amountMinorUnits = num(input, "amountMinorUnits");
      if (!bookingId || amountMinorUnits === undefined || amountMinorUnits <= 0) {
        return invalidInput("bookingId and a positive amountMinorUnits are required.");
      }
      const result = await request_payment(
        supabaseAdmin,
        {
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          bookingId,
          amountMinorUnits,
          currency: str(input, "currency"),
          description: str(input, "description"),
        },
        ctx.fetchImpl,
      );
      return asToolOutput(result);
    },
  },

  check_payment_status: {
    capability: "payment_request",
    schema: {
      name: "check_payment_status",
      description:
        "Read the current status of a payment request. Only a status of CAPTURED, verified server-side, means the customer has actually paid — never assume payment succeeded because the customer says so.",
      input_schema: {
        type: "object",
        properties: {
          paymentRequestId: { type: "string" },
        },
        required: ["paymentRequestId"],
      },
    },
    async execute(supabaseAdmin, ctx, input) {
      const paymentRequestId = str(input, "paymentRequestId");
      if (!paymentRequestId) return invalidInput("paymentRequestId is required.");
      const result = await check_payment_status(
        supabaseAdmin,
        { organizationId: ctx.organizationId, businessId: ctx.businessId, paymentRequestId },
        ctx.fetchImpl,
      );
      return asToolOutput(result);
    },
  },
};

/**
 * Resolves the ClaudeTool[] an agent is actually permitted to use — a
 * single agent_configs.capabilities read, filtered against
 * TOOL_REGISTRY's capability keys. Default-deny: a tool whose capability
 * key is missing or not exactly `true` is left out of the returned list
 * entirely, so the model never even sees it as an option (defense in
 * depth alongside each tool's own assertToolPermission check at
 * execution time).
 */
export async function resolveAvailableTools(
  supabaseAdmin: Client,
  organizationId: string,
  businessId: string,
): Promise<ClaudeTool[]> {
  const { data: agent, error } = await supabaseAdmin
    .from("agent_configs")
    .select("organization_id, capabilities")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw error;
  if (!agent || agent.organization_id !== organizationId) return [];

  const capabilities = (agent.capabilities as Record<string, unknown>) ?? {};
  return Object.values(TOOL_REGISTRY)
    .filter((def) => capabilities[def.capability] === true)
    .map((def) => def.schema);
}

/**
 * Dispatches one tool_use request by name. An unknown tool name (should
 * never happen — the model can only request names from the list
 * resolveAvailableTools handed it, but defends against a malformed or
 * hallucinated call anyway) returns an error tool result rather than
 * throwing, so a single bad tool call degrades to "the AI is told the
 * tool failed" rather than crashing the whole conversation turn.
 */
export async function executeAiTool(
  supabaseAdmin: Client,
  ctx: ToolExecutionContext,
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError?: boolean }> {
  const def = TOOL_REGISTRY[name];
  if (!def) {
    return {
      content: JSON.stringify({
        success: false,
        error: { code: "UNKNOWN_TOOL", message: `No such tool: ${name}` },
      }),
      isError: true,
    };
  }
  return def.execute(supabaseAdmin, ctx, input);
}
