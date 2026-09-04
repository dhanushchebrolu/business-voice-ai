/**
 * Provider-agnostic telephony adapter boundary.
 *
 * Nothing outside this module and its concrete adapters may call a
 * telephony provider's API or import a provider SDK directly. Every other
 * part of Vaani — admin server functions, the outbound-call server function,
 * the inbound webhook route — talks to `getTelephonyAdapter()` in
 * `telephony.server.ts`, never to a provider. Swapping the underlying
 * provider means writing one new class that implements this interface; it
 * never touches the rest of the codebase.
 *
 * Credentials for every adapter live only in server-side environment
 * variables (see telephony.server.ts's TELEPHONY_PROVIDERS registry) and are
 * never returned to a caller or serialized into a client-visible response.
 */

import type { AudioMediaBridge } from "./audio-bridge";

export interface ProvisionNumberInput {
  country: string;
  prefix?: string | undefined;
}

export interface ProvisionedNumber {
  providerNumberId: string;
  e164: string;
  displayNumber: string;
  monthlyPrice: number | null;
  capabilities: string[];
}

export interface InitiateOutboundCallInput {
  fromE164: string;
  toE164: string;
  /** Server-side webhook URL the provider must call back with status events. */
  callbackUrl: string;
  metadata?: Record<string, string> | undefined;
}

export interface InitiatedCall {
  providerCallId: string;
  status: "initiated" | "ringing";
}

export type NormalizedCallStatus =
  | "initiated"
  | "ringing"
  | "answered"
  | "in_progress"
  | "completed"
  | "failed"
  | "busy"
  | "no_answer"
  | "cancelled";

/** A provider's webhook event, translated into Vaani's internal shape. */
export interface NormalizedCallEvent {
  /** Uniquely identifies this specific event for idempotency, if the provider sends one. */
  eventId?: string | undefined;
  providerCallId: string;
  status: NormalizedCallStatus;
  direction?: "inbound" | "outbound" | undefined;
  /** E.164 of the Vaani number involved (the number the event is routed by). */
  vaaniE164?: string | undefined;
  fromE164?: string | undefined;
  toE164?: string | undefined;
  durationSeconds?: number | undefined;
  recordingUrl?: string | null | undefined;
  failureReason?: string | null | undefined;
  occurredAt: string;
  /** Raw provider payload, kept for audit/debugging — never shown to a customer. */
  raw: Record<string, unknown>;
}

export interface TelephonyProviderAdapter {
  id: string;
  supportsPurchase: boolean;

  provisionNumber(input: ProvisionNumberInput): Promise<ProvisionedNumber>;
  releaseNumber(providerNumberId: string): Promise<void>;
  initiateOutboundCall(input: InitiateOutboundCallInput): Promise<InitiatedCall>;

  /**
   * Timing-safe signature/authenticity check. Must be called before the
   * payload is trusted. `url` is optional and exists only because not
   * every provider signs webhooks via a header the way Razorpay/the
   * generic adapter do — Exotel's documented model instead compares a
   * shared verify-token value the admin configures, which Exotel is only
   * confirmed to carry as a URL query parameter (see the Phase D.1
   * report §8/§verification-notes). Header-based adapters simply ignore it.
   */
  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | null>,
    url?: URL,
  ): boolean;
  /** Returns null for an event this adapter does not recognize (never throws on unknown shapes). */
  normalizeWebhookEvent(
    rawBody: string,
    headers: Record<string, string | null>,
  ): NormalizedCallEvent | null;

  /**
   * Opens the live audio channel for an answered call (Phase E). Optional
   * because this is call-*media* transport, a different capability from
   * everything above (call *control*) — a provider can be fully wired for
   * dialing/webhooks and still not implement this. Returning `null` (or
   * omitting the method) means "no live audio path for this call," which
   * the voice runtime treats as a normal, non-fatal reason not to start —
   * never as a crash. See ./audio-bridge.ts.
   */
  openMediaBridge?(providerCallId: string): Promise<AudioMediaBridge | null>;
}

export class TelephonyAdapterError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}
