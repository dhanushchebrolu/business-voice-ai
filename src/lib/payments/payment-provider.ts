/**
 * Provider-independent payment MERCHANT CONNECTION abstraction (Phase 3
 * scope only). Mirrors calendar-provider.ts's pattern exactly:
 * RazorpayPaymentProvider (razorpay-payment-provider.server.ts) is the
 * only implementation today; a future Stripe/Cashfree/other provider
 * implements the same interface without any calling code changing.
 *
 * Deliberately CONNECTION-SURFACE ONLY. This interface intentionally has
 * NO createPaymentRequest/createPaymentLink/createPaymentQr/getPayment/
 * refundPayment/verifyWebhook — those are customer-payment-transaction
 * concerns and belong to Phase 4, which is explicitly out of scope here.
 * Adding them without redesigning this interface is the point of keeping
 * this file narrow now: Phase 4 extends it, it doesn't replace it.
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
}
