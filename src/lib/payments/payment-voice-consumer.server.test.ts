import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handlePaymentEventForVoice } from "./payment-voice-consumer.server.ts";
import type { PaymentDomainEventRow } from "./payment-events.server.ts";

/**
 * globalThis.__env__ (Cloudflare's env binding, see cloudflare-env.server.ts)
 * is unset in this Node test environment, so getCallSessionStub() always
 * returns null here — exercising this consumer's local/dev/test fallback
 * branch (calling voice-runtime.server.ts's injectPaymentEvent directly)
 * rather than the Durable Object RPC branch. That is deliberate and
 * matches how telephony-runtime.ts's own tests exercise its equivalent
 * fallback. Since no real voice session exists for any callId used here,
 * injectPaymentEvent safely no-ops ({handled:false}) without touching
 * STT/TTS/bridge state — this file only needs to prove the CONSUMER's own
 * logic (booking/payment_request lookup, message composition, the no-op
 * conditions) runs correctly and never throws.
 */

function makeFakeSupabase(script: { table: string; op: string; result: unknown }[]) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  let i = 0;
  function next(table: string, op: string, ...args: unknown[]) {
    calls.push({ table, op, args });
    const entry = script[i];
    i++;
    if (!entry) throw new Error(`test bug: no scripted response for call ${i} (${table}.${op})`);
    return entry.result;
  }
  function selectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      maybeSingle: () => Promise.resolve(next(table, "select.maybeSingle", filters)),
    };
    return chain;
  }
  const client = {
    from(table: string) {
      return { select: () => selectChain(table) };
    },
  };
  return { client: client as never, calls };
}

const BASE_EVENT: PaymentDomainEventRow = {
  id: "event-1",
  event_type: "PAYMENT_CAPTURED",
  organization_id: "org-1",
  business_id: "biz-1",
  payment_request_id: "pr-1",
  booking_id: "booking-1",
  payload: {},
};

describe("handlePaymentEventForVoice", () => {
  test("does nothing when the booking has no call_id — never had a live voice session", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: { data: { call_id: null }, error: null },
      },
    ]);
    await handlePaymentEventForVoice(client, BASE_EVENT);
    assert.equal(
      calls.length,
      1,
      "must not look up payment_requests when there's no call to notify",
    );
  });

  test("does nothing when the payment_requests row can't be found (defensive — should not happen for a real event)", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: { data: { call_id: "call-1" }, error: null },
      },
      { table: "payment_requests", op: "select.maybeSingle", result: { data: null, error: null } },
    ]);
    await assert.doesNotReject(() => handlePaymentEventForVoice(client, BASE_EVENT));
  });

  test("does nothing for an unrecognized event type", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: { data: { call_id: "call-1" }, error: null },
      },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: {
          data: { amount_minor_units: 100, currency: "INR", payment_link_url: null },
          error: null,
        },
      },
    ]);
    // @ts-expect-error deliberately passing an event_type outside the union to exercise the default branch
    await handlePaymentEventForVoice(client, { ...BASE_EVENT, event_type: "SOMETHING_ELSE" });
    assert.equal(
      calls.length,
      2,
      "reads both rows, but composes no message and injects nothing further",
    );
  });

  test("PAYMENT_CAPTURED composes a message and safely no-ops via the local fallback (no active session for this callId)", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: { data: { call_id: "call-does-not-exist" }, error: null },
      },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: {
          data: { amount_minor_units: 50000, currency: "INR", payment_link_url: null },
          error: null,
        },
      },
    ]);
    await assert.doesNotReject(() => handlePaymentEventForVoice(client, BASE_EVENT));
  });

  test("PAYMENT_CAPTURED_AFTER_EXPIRY, PAYMENT_FAILED, and PAYMENT_EXPIRED all compose without throwing", async () => {
    for (const eventType of [
      "PAYMENT_CAPTURED_AFTER_EXPIRY",
      "PAYMENT_FAILED",
      "PAYMENT_EXPIRED",
    ] as const) {
      const { client } = makeFakeSupabase([
        {
          table: "bookings",
          op: "select.maybeSingle",
          result: { data: { call_id: "call-x" }, error: null },
        },
        {
          table: "payment_requests",
          op: "select.maybeSingle",
          result: {
            data: {
              amount_minor_units: 1000,
              currency: "INR",
              payment_link_url: "https://rzp.io/i/x",
            },
            error: null,
          },
        },
      ]);
      await assert.doesNotReject(
        () => handlePaymentEventForVoice(client, { ...BASE_EVENT, event_type: eventType }),
        `event type ${eventType} must not throw`,
      );
    }
  });
});
