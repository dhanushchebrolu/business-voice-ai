import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getCallRuntimeStub } from "./cloudflare-env.server.ts";
import { handlePaymentEventForVoice } from "../payments/payment-voice-consumer.server.ts";

/**
 * Which calls reach a Durable Object. Only Vobiz holds its live session in one. Sarvam and
 * every other provider must never send a request to any object, the CALL_SESSION stub included.
 */

type Sent = { binding: string; url: string };
function bindBoth(): Sent[] {
  const sent: Sent[] = [];
  const namespace = (binding: string) => ({
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({
      fetch: async (url: Request | string) => {
        sent.push({ binding, url: String(url) });
        return new Response(JSON.stringify({ handled: false }));
      },
    }),
  });
  (globalThis as { __env__?: unknown }).__env__ = {
    CALL_SESSION: namespace("CALL_SESSION"),
    VOBIZ_CALL_SESSION: namespace("VOBIZ_CALL_SESSION"),
  };
  return sent;
}
afterEach(() => {
  delete (globalThis as { __env__?: unknown }).__env__;
});

const OTHERS = ["sarvam", "exotel", "twilio", "livekit_sip", "Vobiz ", "", null, undefined];

describe("getCallRuntimeStub", () => {
  test("a Vobiz call gets the Vobiz object", async () => {
    const sent = bindBoth();
    await getCallRuntimeStub("vobiz")!.fetch("https://call-session/internal/x");
    assert.deepEqual(sent, [
      { binding: "VOBIZ_CALL_SESSION", url: "https://call-session/internal/x" },
    ]);
  });

  test("no other provider gets any object, even with both bound", () => {
    const sent = bindBoth();
    for (const provider of OTHERS) assert.equal(getCallRuntimeStub(provider), null, `${provider}`);
    assert.deepEqual(sent, []);
  });

  test("without bindings (local development) Vobiz gets none either", () => {
    assert.equal(getCallRuntimeStub("vobiz"), null);
  });
});

describe("payment events", () => {
  const event = {
    id: "event-1",
    event_type: "PAYMENT_CAPTURED" as const,
    organization_id: "org-1",
    business_id: "biz-1",
    payment_request_id: "pr-1",
    booking_id: "booking-1",
    payload: {},
  };
  const database = (provider: string) => {
    const rows: Record<string, unknown> = {
      bookings: { call_id: "call-without-session" },
      call_logs: { provider },
      payment_requests: { amount_minor_units: 100, currency: "INR", payment_link_url: null },
    };
    const chain = (table: string) => {
      const q = {
        eq: () => q,
        maybeSingle: async () => ({ data: rows[table], error: null }),
      };
      return q;
    };
    return { from: (table: string) => ({ select: () => chain(table) }) } as never;
  };

  test("a Sarvam call's payment event reaches no Durable Object", async () => {
    const sent = bindBoth();
    await handlePaymentEventForVoice(database("sarvam"), event);
    assert.deepEqual(sent, []);
  });

  test("a Vobiz call's payment event goes to the Vobiz object, once", async () => {
    const sent = bindBoth();
    await handlePaymentEventForVoice(database("vobiz"), event);
    assert.deepEqual(sent, [
      { binding: "VOBIZ_CALL_SESSION", url: "https://call-session/internal/payment-event" },
    ]);
  });
});
