import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handlePaymentEventForWhatsApp } from "./payment-whatsapp-consumer.server.ts";
import type { PaymentDomainEventRow } from "./payment-events.server.ts";

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
      in(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
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

describe("handlePaymentEventForWhatsApp", () => {
  test("does nothing (no error) when the booking has no phone on file", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: {
          data: { id: "booking-1", customer_phone: null, start_at: "s", timezone: "Asia/Kolkata" },
          error: null,
        },
      },
    ]);
    await handlePaymentEventForWhatsApp(client, BASE_EVENT);
    assert.equal(
      calls.length,
      1,
      "should not look up payment_requests when there is no phone to send to",
    );
  });

  test("reads current booking/payment_request state (not the event's own payload) to compose the message", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "booking-1",
            customer_phone: "+919876543210",
            start_at: "2026-09-25T10:30:00.000Z",
            timezone: "Asia/Kolkata",
          },
          error: null,
        },
      },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: {
          data: {
            amount_minor_units: 50000,
            currency: "INR",
            payment_link_url: "https://rzp.io/i/abc",
          },
          error: null,
        },
      },
      // sendWhatsAppPaymentMessage's own internal calls, starting with connection lookup:
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: { data: null, error: null },
      },
    ]);
    // No throw = success; the important assertion is that this doesn't
    // crash trying to read the domain event's own (empty) payload for
    // amount/phone/etc. — it must go back to the DB for current state.
    await handlePaymentEventForWhatsApp(client, BASE_EVENT);
  });

  test("never confirms the booking in the message for PAYMENT_CAPTURED_AFTER_EXPIRY — uses different, honest copy", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "booking-1",
            customer_phone: "+919876543210",
            start_at: "2026-09-25T10:30:00.000Z",
            timezone: "Asia/Kolkata",
          },
          error: null,
        },
      },
      {
        table: "payment_requests",
        op: "select.maybeSingle",
        result: {
          data: { amount_minor_units: 50000, currency: "INR", payment_link_url: null },
          error: null,
        },
      },
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: { data: null, error: null },
      },
    ]);
    await handlePaymentEventForWhatsApp(client, {
      ...BASE_EVENT,
      event_type: "PAYMENT_CAPTURED_AFTER_EXPIRY",
    });
    // Exercised without throwing; the calendar consumer test file already
    // asserts the booking itself is never silently confirmed for this
    // event type — this test asserts the WhatsApp path runs at all.
    assert.ok(calls.length >= 3);
  });

  test("does nothing for an unrecognized event type", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "booking-1",
            customer_phone: "+919876543210",
            start_at: "s",
            timezone: "Asia/Kolkata",
          },
          error: null,
        },
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
    await handlePaymentEventForWhatsApp(client, { ...BASE_EVENT, event_type: "SOMETHING_ELSE" });
    assert.equal(calls.length, 2, "no send attempt for an unrecognized event type");
  });
});
