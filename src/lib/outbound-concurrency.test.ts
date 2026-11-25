import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  changeNote,
  concurrencyOptions,
  effectiveCap,
  orgLimitFromError,
  parseOrgConcurrency,
  validateSelection,
} from "./outbound-concurrency.ts";
import { readOrgCap, saveOrgConcurrency } from "./outbound-concurrency.server.ts";

/** A database stand-in: one organization row, the allowance RPC, an audit table. */
function fakeDb(o: {
  selected: number | null;
  limit?: number;
  active?: number;
  rpcFails?: boolean;
}) {
  const state = { selected: o.selected, audit: [] as Record<string, unknown>[] };
  const limit = o.limit ?? 4;
  const db = {
    rpc: async (fn: string) => {
      if (o.rpcFails) return { data: null, error: { message: "boom" } };
      assert.equal(fn, "outbound_org_concurrency");
      const cap = effectiveCap(state.selected, limit);
      const n = o.active ?? 0;
      return {
        data: [
          {
            selected: state.selected,
            cap,
            slot_limit: limit,
            global_in_use: n,
            active_outbound: n,
            remaining: Math.max(Math.min(cap - n, limit - n), 0),
            reserved_inbound: limit - cap,
          },
        ],
        error: null,
      };
    },
    from: (table: string) => ({
      update: (v: { outbound_concurrency: number }) => ({
        eq: async () => {
          state.selected = v.outbound_concurrency;
          return { error: null };
        },
      }),
      insert: async (row: Record<string, unknown>) => {
        assert.equal(table, "audit_logs");
        state.audit.push(row);
        return { error: null };
      },
    }),
  };
  return { db: db as never, state };
}

describe("outbound concurrency arithmetic", () => {
  test("unchosen is 2; a choice is held between 1 and the platform limit", () => {
    assert.equal(effectiveCap(null, 4), 2);
    assert.equal(effectiveCap(undefined, 4), 2);
    assert.equal(effectiveCap(3, 4), 3);
    assert.equal(effectiveCap(9, 4), 4);
    assert.equal(effectiveCap(0, 4), 1);
    assert.equal(effectiveCap(null, 1), 1);
  });

  test("the options follow the platform limit", () => {
    assert.deepEqual(concurrencyOptions(4), [1, 2, 3, 4]);
    assert.deepEqual(concurrencyOptions(2), [1, 2]);
    assert.deepEqual(concurrencyOptions(6), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(concurrencyOptions(0), [1]);
    assert.equal(concurrencyOptions(500).length, 10);
  });

  test("reserved incoming capacity is the limit minus the choice", () => {
    for (const n of [1, 2, 3, 4]) {
      const s = parseOrgConcurrency({ selected: n, slot_limit: 4, reserved_inbound: 4 - n });
      assert.equal(s.cap, n);
      assert.equal(s.reservedInbound, 4 - n);
    }
    assert.equal(parseOrgConcurrency({ selected: null, slot_limit: 4 }).defaultValue, 2);
    assert.equal(parseOrgConcurrency(null).slotLimit, 4);
  });

  test("selection validation", () => {
    assert.deepEqual(validateSelection(3, 4), { ok: true, value: 3 });
    assert.deepEqual(validateSelection("2", 4), { ok: true, value: 2 });
    for (const bad of [0, -1, 1.5, "x", null, undefined, NaN, 5]) {
      assert.equal(validateSelection(bad, 4).ok, false, String(bad));
    }
    assert.deepEqual(validateSelection(5, 6), { ok: true, value: 5 });
  });

  test("the note about running calls only appears when they exceed the new limit", () => {
    assert.equal(changeNote(2, 2), null);
    assert.match(changeNote(4, 2)!, /4 outbound calls are running.*finish normally/);
  });

  test("the refused insert's message gives the customer's cap", () => {
    assert.equal(orgLimitFromError("ORG_CONCURRENCY_LIMIT: 2 of 2 outbound calls are running"), 2);
    assert.equal(orgLimitFromError("PROVIDER_CONCURRENCY_LIMIT: 4 of 4"), null);
  });
});

describe("saving the customer's choice", () => {
  test("stores the choice, audits it and reports the new allowance", async () => {
    const { db, state } = fakeDb({ selected: null });
    const r = await saveOrgConcurrency(db, { organizationId: "o", userId: "u", value: 3 });
    assert.equal(state.selected, 3);
    assert.equal(r.state.cap, 3);
    assert.equal(r.state.reservedInbound, 1);
    assert.equal(r.note, null);
    assert.equal(state.audit[0]!["action"], "OUTBOUND_CONCURRENCY_CHANGED");
  });

  test("a value outside the platform limit is refused and nothing changes", async () => {
    const { db, state } = fakeDb({ selected: 2 });
    await assert.rejects(
      saveOrgConcurrency(db, { organizationId: "o", userId: "u", value: 5 }),
      /between 1 and 4/,
    );
    assert.equal(state.selected, 2);
    assert.equal(state.audit.length, 0);
  });

  test("lowering below the running calls explains that they finish and none is ended", async () => {
    const { db } = fakeDb({ selected: 4, active: 4 });
    const r = await saveOrgConcurrency(db, { organizationId: "o", userId: "u", value: 2 });
    assert.match(r.note!, /4 outbound calls are running/);
    assert.equal(r.state.activeOutbound, 4, "the running calls are untouched");
  });

  test("the cap used for dialling falls back to 2 when it cannot be read", async () => {
    assert.equal(await readOrgCap(fakeDb({ selected: 4, rpcFails: true }).db, "o"), 2);
    assert.equal(await readOrgCap(fakeDb({ selected: 4 }).db, "o"), 4);
  });
});
