/**
 * The agent's view of klyro for one call: session start/end and the
 * BookingBackend over klyro's existing, validated tools
 * (check_calendar_availability, book_appointment — src/lib/ai-tools.server.ts).
 * Nothing here decides availability or booking success: it maps klyro's
 * answers into the agent's types and nothing else.
 */
import { KlyroClient, KlyroError } from "./klyro-client.ts";
import type { AvailabilityResult, BookResult, BookingBackend, BookingOutcome } from "./types.ts";

export interface SessionBusiness {
  name: string;
  timezone: string;
  country: string | null;
  currency: string;
  services: { id: string; name: string; price: number | null; durationMinutes: number | null }[];
  agentName: string;
  primaryLanguage: string;
  extraLanguages: string[];
  greetings: Record<string, string>;
  voiceId: string;
  speakingPace: number;
  instructions: string;
}

export type StartSessionResponse =
  | {
      allowed: true;
      callId: string;
      business: SessionBusiness;
      tools: string[];
      callerNumber: string | null;
      /** klyro's maximum call duration (seconds); absent from older klyro versions. */
      maxCallSeconds?: number;
    }
  | { allowed: false; reason: string; callId: string | null };

export const PATHS = {
  session: "/api/internal/voice-agent/session",
  tool: "/api/internal/voice-agent/tool",
  sessionEnd: "/api/internal/voice-agent/session-end",
  outboundClaim: "/api/internal/voice-agent/outbound-claim",
} as const;

export interface OutboundClaim {
  ok: true;
  callId: string;
  /** Authoritative, from klyro's call row. */
  toNumber: string;
  /** The organization's own number (caller ID), from klyro's call row. */
  fromNumber: string;
}

/**
 * Claims an outbound call row before dialling. Idempotent per LiveKit job
 * id, so retries are safe; klyro refuses (409/404) any other job, an expired
 * row, or a call that already ended. Throws KlyroError on refusal.
 */
export async function claimOutbound(
  client: KlyroClient,
  p: { callId: string; roomName: string; jobId: string },
): Promise<OutboundClaim> {
  return client.post<OutboundClaim>(PATHS.outboundClaim, p, { idempotent: true });
}

export async function startSession(
  client: KlyroClient,
  p: {
    sipCallId: string;
    roomName: string;
    calledNumber: string;
    callerNumber: string | null;
    direction: "inbound" | "outbound";
    outboundCallLogId?: string;
    /** This agent's own MAX_CALL_SECONDS: klyro records min(klyro's, this) per call. */
    maxCallSeconds?: number;
  },
): Promise<StartSessionResponse> {
  return client.post<StartSessionResponse>(PATHS.session, p, { idempotent: true });
}

export async function endSession(
  client: KlyroClient,
  p: {
    callId: string;
    reason: string;
    /** Required by klyro to close a call this job is dialling. */
    jobId?: string;
    summary?: string;
    language?: string;
    outcome?: string;
    /** The call's LiveKit room and sip.callID: klyro refuses a report that does not match. */
    roomName?: string;
    sipCallId?: string;
  },
): Promise<void> {
  await client.post(PATHS.sessionEnd, p, { idempotent: true });
}

interface ToolResponse {
  ok: true;
  content: string;
  isError: boolean;
}

export class KlyroBookingBackend implements BookingBackend {
  private readonly client: KlyroClient;
  private readonly callId: string;
  private readonly timeZone: string;
  private readonly tools: ReadonlySet<string>;

  constructor(client: KlyroClient, callId: string, timeZone: string, tools: string[]) {
    this.client = client;
    this.callId = callId;
    this.timeZone = timeZone;
    this.tools = new Set(tools);
  }

  private async tool(name: string, input: Record<string, unknown>, idempotent: boolean) {
    const r = await this.client.post<ToolResponse>(
      PATHS.tool,
      { callId: this.callId, tool: name, input },
      { idempotent },
    );
    let parsed: {
      success?: boolean;
      data?: unknown;
      error?: { code?: string; message?: string };
      bookingOutcome?: string;
    };
    try {
      parsed = JSON.parse(r.content);
    } catch {
      parsed = { success: false, error: { code: "BAD_TOOL_OUTPUT" } };
    }
    return parsed;
  }

  async checkAvailability(
    q: Parameters<BookingBackend["checkAvailability"]>[0],
  ): Promise<AvailabilityResult> {
    if (!this.tools.has("check_calendar_availability"))
      return { ok: false, error: "not_allowed", retryable: false };
    try {
      const r = await this.tool(
        "check_calendar_availability",
        { dateIso: q.date, durationMinutes: q.durationMinutes },
        true,
      );
      if (!r.success) {
        const code = r.error?.code ?? "UNKNOWN";
        return { ok: false, error: code, retryable: /UNAVAILABLE|RATE_LIMITED/.test(code) };
      }
      const slots = ((r.data as { slots?: { start: string; end: string }[] })?.slots ?? []).map(
        (s) => ({
          startIso: s.start,
          endIso: s.end,
        }),
      );
      const local = (iso: string) =>
        new Intl.DateTimeFormat("en-GB", {
          timeZone: this.timeZone,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(iso));
      return {
        ok: true,
        slots: slots.filter(
          (s) =>
            (!q.notBefore || local(s.startIso) >= q.notBefore) &&
            (!q.notAfter || local(s.startIso) <= q.notAfter),
        ),
      };
    } catch (e) {
      return { ok: false, error: e instanceof KlyroError ? e.code : "network", retryable: true };
    }
  }

  async book(req: Parameters<BookingBackend["book"]>[0]): Promise<BookResult> {
    if (!this.tools.has("book_appointment")) {
      return {
        ok: false,
        error: "not_allowed",
        retryable: false,
        message: "Booking is not enabled for this business.",
      };
    }
    try {
      const r = await this.tool(
        "book_appointment",
        {
          customerName: req.customerName,
          customerPhone: req.customerPhone,
          startIso: req.slot.startIso,
          endIso: req.slot.endIso,
          ...(req.serviceId ? { serviceId: req.serviceId } : {}),
          notes: `Booked by phone (voice agent): ${req.serviceName}`,
        },
        true, // klyro keys voice bookings by call + slot: a retry returns the same booking
      );
      if (r.success) {
        const data = r.data as { id?: string };
        const outcome = (
          ["confirmed", "saved_calendar_sync_failed", "pending"].includes(r.bookingOutcome ?? "")
            ? r.bookingOutcome
            : "pending"
        ) as BookingOutcome;
        return { ok: true, bookingId: data.id ?? "unknown", outcome, slot: req.slot };
      }
      const code = r.error?.code ?? "UNKNOWN";
      if (code === "SLOT_NO_LONGER_AVAILABLE" || code === "CALENDAR_CONFLICT") {
        return {
          ok: false,
          error: "slot_taken",
          retryable: false,
          message: "That time was just taken.",
        };
      }
      if (/UNAVAILABLE|RATE_LIMITED/.test(code)) {
        return {
          ok: false,
          error: "backend_unavailable",
          retryable: true,
          message: "The booking system did not respond.",
        };
      }
      return {
        ok: false,
        error: "invalid_request",
        retryable: false,
        message: r.error?.message ?? "The booking was not accepted.",
      };
    } catch (e) {
      return {
        ok: false,
        error: "backend_unavailable",
        retryable: true,
        message: e instanceof KlyroError ? e.code : "network",
      };
    }
  }
}
