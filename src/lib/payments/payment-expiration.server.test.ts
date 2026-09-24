import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { expirePendingPayments } from "./payment-expiration.server.ts";

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
      lt(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(next(table, "select", filters)).then(resolve, reject);
      },
    };
    return chain;
  }

  function updateChain(table: string, payload: unknown) {
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
      select() {
        return {
          maybeSingle: () =>
            Promise.resolve(next(table, "update.select.maybeSingle", payload, filters)),
          then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
            return Promise.resolve(next(table, "update.select", payload, filters)).then(
              resolve,
              reject,
            );
          },
        };
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(next(table, "update", payload, filters)).then(resolve, reject);
      },
    };
    return chain;
  }

  function insertChain(table: string, payload: unknown) {
    return {
      select: () => ({
        single: () => Promise.resolve(next(table, "insert.single", payload)),
      }),
    };
  }

  const client = {
    from(table: string) {
      return {
        select: () => selectChain(table),
        update: (payload: unknown) => updateChain(table, payload),
        insert: (payload: unknown) => insertChain(table, payload),
      };
    },
  };
  return { client: client as never, calls };
}

describe("expirePendingPayments", () => {
  test("no candidates: zero counts, no further calls", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "bookings", op: "select", result: { data: [], error: null } },
    ]);
    const result = await expirePendingPayments(client, {});
    assert.deepEqual(result, {
      candidatesFound: 0,
      bookingsExpired: 0,
      paymentRequestsExpired: 0,
      domainEventsDispatched: 0,
    });
    assert.equal(calls.length, 1);
  });

  test("happy path: an expired booking with an open payment request is transitioned and a domain event is dispatched", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select",
        result: {
          data: [{ id: "booking-1", organization_id: "org-1", business_id: "biz-1" }],
          error: null,
        },
      },
      {
        table: "bookings",
        op: "update.select.maybeSingle",
        result: { data: { id: "booking-1" }, error: null },
      },
      {
        table: "payment_requests",
        op: "update.select",
        result: { data: [{ id: "pr-1" }], error: null },
      },
      {
        table: "payment_domain_events",
        op: "insert.single",
        result: {
          data: {
            id: "event-1",
            event_type: "PAYMENT_EXPIRED",
            organization_id: "org-1",
            business_id: "biz-1",
            payment_request_id: "pr-1",
            booking_id: "booking-1",
            payload: { reason: "hold_expired" },
          },
          error: null,
        },
      },
    ]);
    const result = await expirePendingPayments(client, {});
    assert.equal(result.candidatesFound, 1);
    assert.equal(result.bookingsExpired, 1);
    assert.equal(result.paymentRequestsExpired, 1);
    assert.equal(result.domainEventsDispatched, 1);

    const bookingUpdate = calls.find(
      (c) => c.table === "bookings" && c.op === "update.select.maybeSingle",
    );
    assert.deepEqual(bookingUpdate!.args[0], { status: "PAYMENT_EXPIRED" });
    const prUpdate = calls.find((c) => c.table === "payment_requests" && c.op === "update.select");
    assert.deepEqual(prUpdate!.args[0], { status: "EXPIRED" });
    assert.deepEqual((prUpdate!.args[1] as Record<string, unknown>)["status"], [
      "CREATED",
      "PENDING",
    ]);
  });

  test("lost the race to a concurrent capture: the booking's conditional update matches nothing, so nothing else is touched for it", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select",
        result: {
          data: [{ id: "booking-1", organization_id: "org-1", business_id: "biz-1" }],
          error: null,
        },
      },
      { table: "bookings", op: "update.select.maybeSingle", result: { data: null, error: null } },
    ]);
    const result = await expirePendingPayments(client, {});
    assert.equal(result.bookingsExpired, 0);
    assert.equal(result.paymentRequestsExpired, 0);
    assert.equal(result.domainEventsDispatched, 0);
    assert.equal(
      calls.length,
      2,
      "never touches payment_requests for a booking that already moved on",
    );
  });

  test("a booking with no payment_requests row still expires, but no domain event is dispatched (nothing to attach it to)", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select",
        result: {
          data: [{ id: "booking-1", organization_id: "org-1", business_id: "biz-1" }],
          error: null,
        },
      },
      {
        table: "bookings",
        op: "update.select.maybeSingle",
        result: { data: { id: "booking-1" }, error: null },
      },
      { table: "payment_requests", op: "update.select", result: { data: [], error: null } },
    ]);
    const result = await expirePendingPayments(client, {});
    assert.equal(result.bookingsExpired, 1);
    assert.equal(result.paymentRequestsExpired, 0);
    assert.equal(result.domainEventsDispatched, 0);
    assert.ok(!calls.some((c) => c.table === "payment_domain_events"));
  });

  test("processes multiple candidate bookings independently", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "bookings",
        op: "select",
        result: {
          data: [
            { id: "booking-1", organization_id: "org-1", business_id: "biz-1" },
            { id: "booking-2", organization_id: "org-1", business_id: "biz-1" },
          ],
          error: null,
        },
      },
      {
        table: "bookings",
        op: "update.select.maybeSingle",
        result: { data: { id: "booking-1" }, error: null },
      },
      {
        table: "payment_requests",
        op: "update.select",
        result: { data: [{ id: "pr-1" }], error: null },
      },
      {
        table: "payment_domain_events",
        op: "insert.single",
        result: {
          data: {
            id: "event-1",
            event_type: "PAYMENT_EXPIRED",
            organization_id: "org-1",
            business_id: "biz-1",
            payment_request_id: "pr-1",
            booking_id: "booking-1",
            payload: {},
          },
          error: null,
        },
      },
      // booking-2 lost the race
      { table: "bookings", op: "update.select.maybeSingle", result: { data: null, error: null } },
    ]);
    const result = await expirePendingPayments(client, {});
    assert.equal(result.candidatesFound, 2);
    assert.equal(result.bookingsExpired, 1);
    assert.equal(result.domainEventsDispatched, 1);
  });
});
