/**
 * Provider-independent payment abstraction. Mirrors calendar-provider.ts's
 * pattern exactly: RazorpayPaymentProvider (razorpay-payment-provider.
 * server.ts) is the only implementation today; a future Stripe/Cashfree/
 * other provider implements the same interface without any calling code
 * changing.
 *
 * Phase 3 shipped the CONNECTION surface only (connect/disconnect/verify/
 * credentials) — deliberately excluding any payment-transaction method, by
 * design, so it could be extended rather than redesigned once Phase 4
 * needed real transactions. This is that extension: createPaymentRequest/
 * getPaymentRequestStatus below. Still deliberately excluded: refundPayment
 * (not part of the booking-payment flow this phase implements) and a
 * webhook-verification method (signature verification is a static function
 * of raw body + signature + a shared secret, with no per-connection state
 * — it stays a standalone reusable utility, verifySignature() in
 * razorpay.server.ts, reused directly by the webhook route rather than
 * being shoehorned into this connection/transaction-scoped interface).
 */

export type PaymentProviderErrorCode =
  | "AUTH_REQUIRED"
  | "NOT_CONFIGURED"
  | "MERCHANT_NOT_FOUND"
  | "ACCESS_DENIED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";

/** Safe-to-surface, provider-agnostic error — callers never see a raw provider error (mirrors CalendarProviderError). */
export class PaymentProviderError extends Error {
  code: PaymentProviderErrorCode;
  /** Whether a caller may safely retry this exact operation (transient network/5xx/429 — never for auth/permission/not-found). */
  retryable: boolean;
  constructor(code: PaymentProviderErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * This integration's OWN connection health — deliberately separate from
 * whatever account-activation/KYC status the provider itself might report
 * (see MerchantDetails.status below), matching
 * razorpay_connections.connection_status vs merchant_status.
 */
export type PaymentConnectionStatus =
  "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "REAUTH_REQUIRED" | "ERROR";

export interface MerchantDetails {
  accountId: string;
  businessName: string | undefined;
  displayName: string | undefined;
  email: string | undefined;
  phone: string | undefined;
  /** Whatever activation/KYC status string the provider reports, if any. Opaque — not interpreted by ClickAI. */
  status: string | undefined;
}

/**
 * This integration's OWN payment-transaction status — server-authoritative
 * only. Nothing in this codebase may set a payment to CAPTURED except
 * verified webhook processing (or, for EXPIRED, a bounded server-side
 * expiry sweep). No caller — AI tool, frontend, or otherwise — has a way
 * to construct this value directly; it only ever comes back from
 * getPaymentRequestStatus() or a webhook-driven state transition.
 */
export type PaymentStatus = "CREATED" | "PENDING" | "CAPTURED" | "FAILED" | "EXPIRED" | "CANCELLED";

export interface CreatePaymentRequestInput {
  amountMinorUnits: number;
  currency: string;
  description: string;
  customerName: string | undefined;
  customerPhone: string | undefined;
  customerEmail: string | undefined;
  /** Caller-supplied, retry-safe: creating with the same key against the same connection must not create a second live payment request. */
  idempotencyKey: string;
  /** Opaque key/value pairs echoed back by the provider on its webhook payload where supported — used to help (never solely trust) tying a webhook event back to our own record. */
  notes: Record<string, string>;
}

export interface PaymentRequestResult {
  providerPaymentLinkId: string;
  paymentLinkUrl: string;
  status: PaymentStatus;
}

export interface PaymentRequestStatusResult {
  status: PaymentStatus;
  amountPaidMinorUnits: number | undefined;
}

/**
 * A merchant connection abstraction — deliberately not assumed to be a
 * simple API-key pair. Any concrete provider (OAuth-based, like Razorpay's
 * Partner OAuth, or a future platform/partner-onboarding flow) implements
 * this same surface.
 */
export interface PaymentProvider {
  /**
   * Completes a merchant connection from whatever provider-specific
   * authorization artifact the connect flow produced (e.g. an OAuth
   * authorization code). Returns the connected merchant's details.
   */
  connect(authorizationArtifact: string): Promise<MerchantDetails>;

  /** Revokes/clears this provider's locally-held credentials for the connection. Does not delete the connection record itself. */
  disconnect(): Promise<void>;

  /** This integration's own last-known connection health, without making a network call. */
  getConnectionStatus(): PaymentConnectionStatus;

  /** ACTUALLY verifies the connection is currently usable (a real provider call), returning the resulting health status. */
  verifyConnection(): Promise<PaymentConnectionStatus>;

  /** Fetches the connected merchant's current details from the provider. */
  getMerchantDetails(): Promise<MerchantDetails>;

  /** Refreshes locally-held credentials (e.g. an OAuth token refresh), if the provider's connect flow supports it. */
  refreshCredentials(): Promise<void>;

  /** Returns a currently-valid access token/credential for making provider API calls. Never exposed to the browser. */
  getValidAccessToken(): Promise<string>;

  /**
   * Creates a real, payable payment request against the connected
   * merchant's account and returns a link the customer can pay through.
   * Never returns a CAPTURED status — a payment request always starts
   * CREATED/PENDING; only verified webhook processing (or expiry) may
   * later move it further.
   */
  createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequestResult>;

  /** Reads back the current server-verified status of a previously-created payment request. Read-only. */
  getPaymentRequestStatus(providerPaymentLinkId: string): Promise<PaymentRequestStatusResult>;
}
