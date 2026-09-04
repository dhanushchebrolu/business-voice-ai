import { createHmac, timingSafeEqual, randomUUID } from "crypto";
import type {
  InitiateOutboundCallInput,
  InitiatedCall,
  NormalizedCallEvent,
  ProvisionNumberInput,
  ProvisionedNumber,
  TelephonyProviderAdapter,
} from "./adapter";

/**
 * Deterministic, entirely local test provider. It never calls a network,
 * never charges anything real, and never pretends a production number or
 * call is live.
 *
 * Per the Phase D brief §28 ("do not fake provider success"): this adapter
 * only exists at all when `TELEPHONY_ALLOW_MOCK=true` is explicitly set
 * (getTelephonyAdapter() in telephony.server.ts enforces this), and every
 * number/call it produces is tagged in `metadata`/`provider_metadata` with
 * `{ mock: true }` so it can never be mistaken for a real provisioning or
 * call event in the admin UI or in the database. It exists so the rest of
 * the Phase D stack (entitlement gate, wallet debit, state machine,
 * webhook idempotency) can be exercised end-to-end without live telephony
 * credentials.
 */
const MOCK_SECRET = "mock-webhook-secret";

export class MockTelephonyAdapter implements TelephonyProviderAdapter {
  id = "mock";
  supportsPurchase = true;

  async provisionNumber(input: ProvisionNumberInput): Promise<ProvisionedNumber> {
    const suffix = Math.floor(1000000 + Math.random() * 8999999);
    const e164 = `+${input.country === "IN" ? "91" : "1"}${suffix}`;
    return {
      providerNumberId: `mock_num_${randomUUID()}`,
      e164,
      displayNumber: e164,
      monthlyPrice: 0,
      capabilities: ["voice"],
    };
  }

  async releaseNumber(): Promise<void> {
    // no-op: nothing external to tear down
  }

  async initiateOutboundCall(_input: InitiateOutboundCallInput): Promise<InitiatedCall> {
    return { providerCallId: `mock_call_${randomUUID()}`, status: "initiated" };
  }

  verifyWebhookSignature(rawBody: string, headers: Record<string, string | null>): boolean {
    const signature = headers["x-webhook-signature"];
    if (!signature) return false;
    const expected = createHmac("sha256", MOCK_SECRET).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  normalizeWebhookEvent(rawBody: string): NormalizedCallEvent | null {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }
    const callId = typeof body["call_id"] === "string" ? (body["call_id"] as string) : null;
    if (!callId) return null;
    return {
      eventId: typeof body["event_id"] === "string" ? (body["event_id"] as string) : undefined,
      providerCallId: callId,
      status: (body["status"] as NormalizedCallEvent["status"]) ?? "completed",
      direction: body["direction"] === "outbound" ? "outbound" : "inbound",
      vaaniE164:
        typeof body["vaani_number"] === "string" ? (body["vaani_number"] as string) : undefined,
      fromE164: typeof body["from"] === "string" ? (body["from"] as string) : undefined,
      toE164: typeof body["to"] === "string" ? (body["to"] as string) : undefined,
      durationSeconds:
        typeof body["duration_seconds"] === "number" ? (body["duration_seconds"] as number) : 0,
      recordingUrl: null,
      failureReason: typeof body["error"] === "string" ? (body["error"] as string) : null,
      occurredAt: new Date().toISOString(),
      raw: { ...body, mock: true },
    };
  }
}

/** Signs a payload the same way the mock adapter's verifier expects — test/dev only. */
export function signMockWebhook(rawBody: string): string {
  return createHmac("sha256", MOCK_SECRET).update(rawBody).digest("hex");
}
