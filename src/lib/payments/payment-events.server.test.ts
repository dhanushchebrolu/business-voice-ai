import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  recordPaymentDomainEvent,
  dispatchPaymentDomainEvent,
  type PaymentDomainEventRow,
} from "./payment-events.server.ts";

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
  const client = {
    from(table: string) {
      const chain = {
        insert(payload: unknown) {
          return {
            select: () => ({
              single: () => Promise.resolve(next(table, "insert.single", payload)),
            }),
          };
        },
        update(payload: unknown) {
          return {
            eq: (col: string, val: unknown) =>
              Promise.resolve(next(table, "update", payload, { [col]: val })),
          };
        },
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}

describe("recordPaymentDomainEvent", () => {
  test("inserts a row with the given event type and returns it", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "payment_domain_events",
        op: "insert.single",
        result: {
          data: {
            id: "event-1",
            event_type: "PAYMENT_CAPTURED",
            organization_id: "org-1",
            business_id: "biz-1",
            payment_request_id: "pr-1",
            booking_id: "booking-1",
            payload: {},
          },
          error: null,
        },
      },
    ]);
    const result = await recordPaymentDomainEvent(client, {
      eventType: "PAYMENT_CAPTURED",
      organizationId: "org-1",
      businessId: "biz-1",
      paymentRequestId: "pr-1",
      bookingId: "booking-1",
    });
    assert.equal(result.id, "event-1");
    assert.equal(result.event_type, "PAYMENT_CAPTURED");
    const payload = calls[0]!.args[0] as Record<string, unknown>;
    assert.equal(payload["event_type"], "PAYMENT_CAPTURED");
  });
});

const BASE_EVENT: PaymentDomainEventRow = {
  id: "event-1",
  event_type: "PAYMENT_CAPTURED",
  organization_id: "org-1",
  business_id: "biz-1",
  payment_request_id: "pr-1",
  booking_id: "booking-1",
  payload: {},
};

describe("dispatchPaymentDomainEvent", () => {
  test("calls every provided consumer in order (calendar, whatsapp, voice) and records each dispatch", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "payment_domain_events", op: "update", result: { error: null } },
      { table: "payment_domain_events", op: "update", result: { error: null } },
      { table: "payment_domain_events", op: "update", result: { error: null } },
    ]);
    const order: string[] = [];
    await dispatchPaymentDomainEvent(client, BASE_EVENT, {
      calendar: async () => {
        order.push("calendar");
      },
      whatsapp: async () => {
        order.push("whatsapp");
      },
      voice: async () => {
        order.push("voice");
      },
    });
    assert.deepEqual(order, ["calendar", "whatsapp", "voice"]);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      const payload = call.args[0] as Record<string, unknown>;
      assert.ok(Object.keys(payload).some((k) => k.endsWith("_dispatched_at")));
    }
  });

  test("skips consumers that were not provided, without treating that as a failure", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "payment_domain_events", op: "update", result: { error: null } },
    ]);
    await dispatchPaymentDomainEvent(client, BASE_EVENT, {
      calendar: async () => {},
    });
    assert.equal(calls.length, 1);
  });

  test("a failing consumer never blocks or is retried against a later consumer (fault isolation)", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "payment_domain_events", op: "update", result: { error: null } }, // calendar error recorded
      { table: "payment_domain_events", op: "update", result: { error: null } }, // whatsapp dispatched
    ]);
    let whatsappCalled = false;
    await dispatchPaymentDomainEvent(client, BASE_EVENT, {
      calendar: async () => {
        throw new Error("Google Calendar temporarily unavailable");
      },
      whatsapp: async () => {
        whatsappCalled = true;
      },
    });
    assert.equal(whatsappCalled, true);
    const calendarUpdatePayload = calls[0]!.args[0] as Record<string, unknown>;
    assert.equal(
      calendarUpdatePayload["calendar_error"],
      "Google Calendar temporarily unavailable",
    );
    const whatsappUpdatePayload = calls[1]!.args[0] as Record<string, unknown>;
    assert.ok(whatsappUpdatePayload["whatsapp_dispatched_at"]);
  });

  test("never throws even when every consumer fails", async () => {
    const { client } = makeFakeSupabase([
      { table: "payment_domain_events", op: "update", result: { error: null } },
      { table: "payment_domain_events", op: "update", result: { error: null } },
    ]);
    await dispatchPaymentDomainEvent(client, BASE_EVENT, {
      calendar: async () => {
        throw new Error("calendar failed");
      },
      whatsapp: async () => {
        throw new Error("whatsapp failed");
      },
    });
  });
});
