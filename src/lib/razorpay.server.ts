import { createHmac, timingSafeEqual } from "crypto";

/**
 * Server-only Razorpay adapter. Credentials never leave the server.
 * If credentials are absent, every call reports a not-configured state
 * instead of pretending a payment happened.
 */

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export function getRazorpayCredentials(): RazorpayCredentials | null {
  const keyId = process.env["RAZORPAY_KEY_ID"];
  const keySecret = process.env["RAZORPAY_KEY_SECRET"];
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

export function getRazorpayWebhookSecret(): string | null {
  return process.env["RAZORPAY_WEBHOOK_SECRET"] ?? null;
}

export function razorpayConfigured(): boolean {
  return getRazorpayCredentials() !== null;
}

function authHeader({ keyId, keySecret }: RazorpayCredentials) {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string | null;
}

export async function createRazorpayOrder(input: {
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}): Promise<RazorpayOrder> {
  const creds = getRazorpayCredentials();
  if (!creds) throw new Error("PAYMENTS_NOT_CONFIGURED");

  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: authHeader(creds),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: input.amount,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
      payment_capture: 1,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("razorpay:create_order_failed", res.status, detail.slice(0, 500));
    throw new Error("PAYMENT_PROVIDER_ERROR");
  }
  return (await res.json()) as RazorpayOrder;
}

export async function fetchRazorpayPayment(
  paymentId: string,
): Promise<Record<string, unknown> | null> {
  const creds = getRazorpayCredentials();
  if (!creds) return null;
  const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: authHeader(creds) },
  });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: string; // "pending" | "processed" | "failed" per Razorpay's docs
}

/**
 * Creates a refund against a captured payment. Razorpay's refund-creation
 * call is synchronous for the create step, but settlement can still be
 * asynchronous ("pending" for non-instant methods) — the caller must not
 * treat a successful API call as a guarantee the money moved; only a
 * "processed" status (here, or later via the refund.processed webhook) is
 * that confirmation.
 */
export async function createRazorpayRefund(input: {
  paymentId: string;
  amount: number;
  notes: Record<string, string>;
  idempotencyKey: string;
}): Promise<RazorpayRefund> {
  const creds = getRazorpayCredentials();
  if (!creds) throw new Error("PAYMENTS_NOT_CONFIGURED");

  const res = await fetch(
    `https://api.razorpay.com/v1/payments/${encodeURIComponent(input.paymentId)}/refund`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/json",
        "X-Razorpay-Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({ amount: input.amount, notes: input.notes }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("razorpay:create_refund_failed", res.status, detail.slice(0, 500));
    throw new Error("PAYMENT_PROVIDER_ERROR");
  }
  return (await res.json()) as RazorpayRefund;
}

/** Timing-safe HMAC-SHA256 hex comparison used for webhook + checkout signatures. */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
