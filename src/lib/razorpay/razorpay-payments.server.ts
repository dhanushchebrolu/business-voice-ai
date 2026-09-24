/**
 * Razorpay Payment Links API mechanics for tenant CUSTOMER payments
 * (Phase 4) — deliberately separate from razorpay-oauth.server.ts (Phase 3,
 * connection-only) and from razorpay.server.ts (ClickAI's own platform
 * billing, using its own RAZORPAY_KEY_ID/KEY_SECRET Basic-auth credentials
 * against ClickAI's own Razorpay account).
 *
 * What IS verified in this repository (not a guess): the base API host and
 * the Orders API request/response shape at https://api.razorpay.com/v1 —
 * razorpay.server.ts (ClickAI's platform billing, already in production)
 * calls POST https://api.razorpay.com/v1/orders with exactly the
 * amount/currency/receipt/notes body shape used below, and GET
 * https://api.razorpay.com/v1/payments/{id}. Payment Links
 * (https://api.razorpay.com/v1/payment_links) is the same well-documented,
 * stable core Razorpay product family — chosen over the bare Orders API
 * here specifically because it returns a `short_url` that is directly
 * deliverable as a link/QR via WhatsApp, which the plain Orders API alone
 * does not (Orders require a separate Checkout.js frontend integration to
 * actually collect payment).
 *
 * What is NOT verified in this session (no network egress to razorpay.com
 * — see razorpay-config.server.ts's own doc comment for the identical
 * constraint on the OAuth endpoints): the exact "on behalf of a connected/
 * OAuth sub-merchant account" mechanism. This module's best-effort,
 * training-data-informed design is Bearer-token auth (using
 * getValidRazorpayAccessToken() from razorpay-connection.server.ts) plus an
 * `X-Razorpay-Account: <connected_account_id>` header — Razorpay's
 * documented general pattern for a Partner acting "on behalf of" a
 * connected account. BOTH the base URL and the account-header NAME are
 * environment-configurable (RAZORPAY_PAYMENTS_API_BASE_URL,
 * RAZORPAY_ACCOUNT_HEADER_NAME) with the verified-in-repo/best-effort
 * values only as DEFAULTS, never a forced hardcode — so this can be
 * corrected without a redesign once real credentials and live Razorpay
 * Partner OAuth documentation are available. THIS MUST BE VERIFIED AGAINST
 * LIVE RAZORPAY DOCUMENTATION BEFORE PRODUCTION USE.
 *
 * `fetchImpl` is always injectable (defaults to global fetch), matching
 * every other Razorpay/Google/Meta client module in this codebase — tests
 * never hit a real network.
 */

const DEFAULT_API_BASE_URL = "https://api.razorpay.com/v1";
const DEFAULT_ACCOUNT_HEADER_NAME = "X-Razorpay-Account";
const DEFAULT_TIMEOUT_MS = 15_000;

function resolveApiBaseUrl(): string {
  return process.env["RAZORPAY_PAYMENTS_API_BASE_URL"] || DEFAULT_API_BASE_URL;
}

function resolveAccountHeaderName(): string {
  return process.env["RAZORPAY_ACCOUNT_HEADER_NAME"] || DEFAULT_ACCOUNT_HEADER_NAME;
}

export class RazorpayPaymentsApiError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status = 502, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export interface CreatePaymentLinkInput {
  /** The connected merchant's Razorpay account id (razorpay_connections.razorpay_account_id), sent as the on-behalf-of header. */
  razorpayAccountId: string;
  amountMinorUnits: number;
  currency: string;
  description: string;
  customerName: string | undefined;
  customerPhone: string | undefined;
  customerEmail: string | undefined;
  /** Sent as Razorpay's own `reference_id` where supported, and echoed in `notes` — lets a webhook be matched back to our row defensively even if reference_id isn't a real field. */
  referenceId: string;
  notes: Record<string, string>;
}

export interface PaymentLinkResult {
  providerPaymentLinkId: string;
  paymentLinkUrl: string;
  /** Raw provider status string (e.g. "created"), opaque — callers map to their own PaymentStatus via mapProviderPaymentLinkStatus(). */
  rawStatus: string;
}

export type PaymentStatus = "CREATED" | "PENDING" | "CAPTURED" | "FAILED" | "EXPIRED" | "CANCELLED";

export interface PaymentLinkStatusResult {
  status: PaymentStatus;
  rawStatus: string;
  amountPaidMinorUnits: number | undefined;
}

/**
 * Maps Razorpay's own Payment Link status strings (created | partially_paid
 * | paid | expired | cancelled — the well-documented set for this product)
 * to this integration's own PaymentStatus. An unrecognized value maps to
 * PENDING rather than throwing, so an unexpected-but-non-terminal provider
 * status never gets treated as a silent failure.
 */
export function mapProviderPaymentLinkStatus(rawStatus: string): PaymentStatus {
  switch (rawStatus) {
    case "paid":
      return "CAPTURED";
    case "expired":
      return "EXPIRED";
    case "cancelled":
      return "CANCELLED";
    case "created":
    case "partially_paid":
      return "PENDING";
    default:
      return "PENDING";
  }
}

interface RazorpayApiErrorBody {
  error?: { code?: string; description?: string };
}

function mapApiErrorResponse(
  status: number,
  parsed: RazorpayApiErrorBody | undefined,
): RazorpayPaymentsApiError {
  const description = parsed?.error?.description;
  if (status === 401 || status === 403) {
    return new RazorpayPaymentsApiError(
      "Razorpay rejected this request as unauthorized for the connected account.",
      status,
      false,
    );
  }
  if (status === 429) {
    return new RazorpayPaymentsApiError(
      "Razorpay rate-limited this request. Please retry shortly.",
      429,
      true,
    );
  }
  if (status >= 500) {
    return new RazorpayPaymentsApiError(
      "Razorpay is temporarily unavailable. Please retry.",
      503,
      true,
    );
  }
  return new RazorpayPaymentsApiError(
    `Razorpay rejected the request${description ? `: ${description}` : ""}.`,
    status,
    false,
  );
}

async function callRazorpayApi(
  path: string,
  init: { method: "GET" | "POST"; accessToken: string; razorpayAccountId?: string; body?: unknown },
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${init.accessToken}`,
  };
  if (init.razorpayAccountId) {
    headers[resolveAccountHeaderName()] = init.razorpayAccountId;
  }
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetchImpl(`${resolveApiBaseUrl()}${path}`, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RazorpayPaymentsApiError(
        "Razorpay did not respond in time. Please retry.",
        503,
        true,
      );
    }
    throw new RazorpayPaymentsApiError("Could not reach Razorpay. Please retry.", 503, true);
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!res.ok) {
    throw mapApiErrorResponse(res.status, parsed as RazorpayApiErrorBody | undefined);
  }
  return (parsed as Record<string, unknown>) ?? {};
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" ? value : undefined;
}

/** Creates a Razorpay Payment Link for the connected merchant account. Amount must already be in integer minor units (paise for INR). */
export async function createPaymentLink(
  accessToken: string,
  input: CreatePaymentLinkInput,
  fetchImpl: typeof fetch = fetch,
): Promise<PaymentLinkResult> {
  const body = await callRazorpayApi(
    "/payment_links",
    {
      method: "POST",
      accessToken,
      razorpayAccountId: input.razorpayAccountId,
      body: {
        amount: input.amountMinorUnits,
        currency: input.currency,
        description: input.description,
        reference_id: input.referenceId,
        ...(input.customerName || input.customerPhone || input.customerEmail
          ? {
              customer: {
                ...(input.customerName ? { name: input.customerName } : {}),
                ...(input.customerPhone ? { contact: input.customerPhone } : {}),
                ...(input.customerEmail ? { email: input.customerEmail } : {}),
              },
            }
          : {}),
        notify: { sms: Boolean(input.customerPhone), email: Boolean(input.customerEmail) },
        notes: input.notes,
      },
    },
    fetchImpl,
  );

  const id = readString(body, "id");
  const shortUrl = readString(body, "short_url");
  const status = readString(body, "status");
  if (!id || !shortUrl || !status) {
    throw new RazorpayPaymentsApiError(
      "Razorpay returned an unexpected payment link response.",
      502,
      false,
    );
  }
  return { providerPaymentLinkId: id, paymentLinkUrl: shortUrl, rawStatus: status };
}

/** Reads back the current status of a previously-created payment link. Read-only — never mutates provider state, safe to call for a status-check tool or reconciliation sweep. */
export async function getPaymentLinkStatus(
  accessToken: string,
  razorpayAccountId: string,
  providerPaymentLinkId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PaymentLinkStatusResult> {
  const body = await callRazorpayApi(
    `/payment_links/${encodeURIComponent(providerPaymentLinkId)}`,
    { method: "GET", accessToken, razorpayAccountId },
    fetchImpl,
  );
  const rawStatus = readString(body, "status");
  if (!rawStatus) {
    throw new RazorpayPaymentsApiError(
      "Razorpay returned an unexpected payment link status response.",
      502,
      false,
    );
  }
  return {
    status: mapProviderPaymentLinkStatus(rawStatus),
    rawStatus,
    amountPaidMinorUnits: readNumber(body, "amount_paid"),
  };
}
