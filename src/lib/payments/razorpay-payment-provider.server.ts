/**
 * RazorpayPaymentProvider — the concrete Razorpay implementation of the
 * generic PaymentProvider connection-surface interface
 * (payment-provider.ts). Thin adapter over
 * razorpay-connection.server.ts's already-tested orchestration functions;
 * this class adds no new OAuth/crypto/DB logic of its own — it exists so
 * calling code (and, eventually, a future Stripe/Cashfree provider) can
 * be written against PaymentProvider rather than against Razorpay
 * specifically.
 *
 * Like GoogleCalendarProvider before it, `fetchImpl` is always injectable
 * for testability. Unlike GoogleCalendarProvider (which is constructed
 * with an already-valid access token), a payment connection's status can
 * itself change over the provider's lifetime (disconnect, reauth), so
 * this class is DB-backed: every method re-reads or re-derives state from
 * razorpay_connections via the DI'd supabaseAdmin client rather than
 * caching a token in memory beyond a single call.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  completeRazorpayOAuth,
  disconnectRazorpayConnection,
  verifyRazorpayConnection,
  getValidRazorpayAccessToken,
  RazorpayConnectionError,
} from "../razorpay/razorpay-connection.server.ts";
import { fetchMerchantDetails, RazorpayOAuthError } from "../razorpay/razorpay-oauth.server.ts";
import { resolveRazorpayConfig } from "../razorpay/razorpay-config.server.ts";
import {
  PaymentProviderError,
  type PaymentProvider,
  type PaymentConnectionStatus,
  type MerchantDetails,
} from "./payment-provider.ts";

type Client = SupabaseClient<Database>;

function mapConnectionErrorCode(
  code: RazorpayConnectionError["code"],
): PaymentProviderError["code"] {
  switch (code) {
    case "NOT_CONFIGURED":
      return "NOT_CONFIGURED";
    case "NOT_FOUND":
      return "MERCHANT_NOT_FOUND";
    case "REAUTH_REQUIRED":
      return "AUTH_REQUIRED";
    case "OAUTH_FAILED":
      return "ACCESS_DENIED";
    case "ERROR":
      return "PROVIDER_UNAVAILABLE";
    default:
      return "UNKNOWN";
  }
}

export interface RazorpayPaymentProviderContext {
  supabaseAdmin: Client;
  organizationId: string;
  businessId: string;
  /** Existing connection row id, if one already exists for this (organizationId, businessId). Undefined for a not-yet-connected business. */
  connectionId: string | undefined;
  fetchImpl?: typeof fetch;
}

export class RazorpayPaymentProvider implements PaymentProvider {
  private ctx: RazorpayPaymentProviderContext;
  private status: PaymentConnectionStatus;

  constructor(
    ctx: RazorpayPaymentProviderContext,
    initialStatus: PaymentConnectionStatus = "DISCONNECTED",
  ) {
    this.ctx = ctx;
    this.status = initialStatus;
  }

  private requireConnectionId(): string {
    if (!this.ctx.connectionId) {
      throw new PaymentProviderError(
        "MERCHANT_NOT_FOUND",
        "No Razorpay connection exists for this business yet.",
      );
    }
    return this.ctx.connectionId;
  }

  async connect(authorizationCode: string): Promise<MerchantDetails> {
    try {
      const { connectionId } = await completeRazorpayOAuth(
        this.ctx.supabaseAdmin,
        {
          organizationId: this.ctx.organizationId,
          businessId: this.ctx.businessId,
          code: authorizationCode,
        },
        this.ctx.fetchImpl,
      );
      this.ctx.connectionId = connectionId;
      this.status = "CONNECTED";
    } catch (err) {
      this.status = "ERROR";
      if (err instanceof RazorpayConnectionError) {
        throw new PaymentProviderError(mapConnectionErrorCode(err.code), err.message);
      }
      throw new PaymentProviderError("UNKNOWN", "Failed to connect the Razorpay account.");
    }
    return this.getMerchantDetails();
  }

  async disconnect(): Promise<void> {
    const connectionId = this.requireConnectionId();
    await disconnectRazorpayConnection(this.ctx.supabaseAdmin, {
      organizationId: this.ctx.organizationId,
      connectionId,
    }).catch((err: unknown) => {
      if (err instanceof RazorpayConnectionError) {
        throw new PaymentProviderError(mapConnectionErrorCode(err.code), err.message);
      }
      throw err;
    });
    this.status = "DISCONNECTED";
  }

  getConnectionStatus(): PaymentConnectionStatus {
    return this.status;
  }

  async verifyConnection(): Promise<PaymentConnectionStatus> {
    const connectionId = this.requireConnectionId();
    const { status } = await verifyRazorpayConnection(
      this.ctx.supabaseAdmin,
      { organizationId: this.ctx.organizationId, connectionId },
      this.ctx.fetchImpl,
    );
    this.status = status;
    return status;
  }

  async refreshCredentials(): Promise<void> {
    const connectionId = this.requireConnectionId();
    await this.getValidAccessTokenInternal(connectionId);
  }

  async getValidAccessToken(): Promise<string> {
    const connectionId = this.requireConnectionId();
    return this.getValidAccessTokenInternal(connectionId);
  }

  private async getValidAccessTokenInternal(connectionId: string): Promise<string> {
    try {
      const token = await getValidRazorpayAccessToken(
        this.ctx.supabaseAdmin,
        connectionId,
        this.ctx.fetchImpl,
      );
      this.status = "CONNECTED";
      return token;
    } catch (err) {
      if (err instanceof RazorpayConnectionError) {
        this.status = err.code === "REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : "ERROR";
        throw new PaymentProviderError(mapConnectionErrorCode(err.code), err.message);
      }
      this.status = "ERROR";
      throw new PaymentProviderError("UNKNOWN", "Failed to obtain a valid Razorpay access token.");
    }
  }

  /**
   * Fetches merchant details fresh from Razorpay when a merchant-details
   * endpoint is configured (RAZORPAY_MERCHANT_DETAILS_URL — optional, see
   * razorpay-config.server.ts); otherwise falls back to the connection
   * row's own stored fields (populated at connect time from whatever the
   * token-exchange response provided), never fabricating a value.
   */
  async getMerchantDetails(): Promise<MerchantDetails> {
    const connectionId = this.requireConnectionId();
    const config = resolveRazorpayConfig();

    if (config) {
      const accessToken = await this.getValidAccessTokenInternal(connectionId);
      try {
        const merchant = await fetchMerchantDetails(config, accessToken, this.ctx.fetchImpl);
        if (merchant) return merchant;
      } catch (err) {
        if (err instanceof RazorpayOAuthError && err.status === 401) {
          this.status = "REAUTH_REQUIRED";
          throw new PaymentProviderError("AUTH_REQUIRED", err.message);
        }
        // Fall through to the stored-row fallback below on a non-fatal
        // lookup failure (e.g. the optional endpoint is unreachable).
      }
    }

    const { data, error } = await this.ctx.supabaseAdmin
      .from("razorpay_connections")
      .select("razorpay_account_id, business_name, display_name, email, phone, merchant_status")
      .eq("id", connectionId)
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.razorpay_account_id) {
      throw new PaymentProviderError(
        "MERCHANT_NOT_FOUND",
        "No merchant account information is available for this connection yet.",
      );
    }
    return {
      accountId: data.razorpay_account_id,
      businessName: data.business_name ?? undefined,
      displayName: data.display_name ?? undefined,
      email: data.email ?? undefined,
      phone: data.phone ?? undefined,
      status: data.merchant_status ?? undefined,
    };
  }
}
