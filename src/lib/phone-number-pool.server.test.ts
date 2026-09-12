import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { claimAvailablePhoneNumber } from "./phone-number-pool.server.ts";

/**
 * Behavioral coverage for claimAvailablePhoneNumber. Unlike this repo's
 * createServerFn-wrapped handlers (which import their own Supabase client
 * internally and so can only be source-scanned — see
 * telephony-admin.functions.test.ts's doc comment), this function takes its
 * Supabase client as a parameter, so its actual claim/retry/race-loss logic
 * can be exercised directly against a scripted fake query builder — no live
 * Supabase instance required.
 */

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface RecordedCall {
  type: "select" | "update";
  filters: Record<string, unknown>;
  payload?: unknown;
}

function makeFakeSupabase(script: { select: QueryResult[]; update: QueryResult[] }) {
  let selectIdx = 0;
  let updateIdx = 0;
  const calls: RecordedCall[] = [];

  function makeBuilder(type: "select" | "update", payload?: unknown) {
    const filters: Record<string, unknown> = {};
    const builder = {
      select() {
        return builder;
      },
      is(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      then(resolve: (r: QueryResult) => void, reject: (e: unknown) => void): Promise<void> {
        calls.push({ type, filters, payload });
        const result = type === "select" ? script.select[selectIdx++] : script.update[updateIdx++];
        if (!result)
          throw new Error(`test bug: no scripted ${type} result for call ${calls.length}`);
        return Promise.resolve(result).then(resolve as never, reject);
      },
    };
    return builder;
  }

  const client = {
    from(_table: string) {
      return {
        select() {
          return makeBuilder("select");
        },
        update(payload: unknown) {
          return makeBuilder("update", payload);
        },
      };
    },
  };

  return { client: client as never, calls };
}

describe("claimAvailablePhoneNumber", () => {
  test("returns null immediately when the pool has no candidate — never calls update", async () => {
    const { client, calls } = makeFakeSupabase({
      select: [{ data: [], error: null }],
      update: [],
    });
    const result = await claimAvailablePhoneNumber(client, {
      organizationId: "org_1",
      provider: "sarvam",
    });
    assert.equal(result, null);
    assert.equal(calls.filter((c) => c.type === "update").length, 0);
  });

  test("claims and returns the row on the first successful attempt", async () => {
    const claimedRow = {
      id: "num_1",
      organization_id: "org_1",
      status: "reserved",
      e164: "+911234567890",
    };
    const { client, calls } = makeFakeSupabase({
      select: [{ data: [{ id: "num_1" }], error: null }],
      update: [{ data: [claimedRow], error: null }],
    });
    const result = await claimAvailablePhoneNumber(client, {
      organizationId: "org_1",
      provider: "sarvam",
    });
    assert.deepEqual(result, claimedRow);

    const updateCall = calls.find((c) => c.type === "update")!;
    assert.equal((updateCall.payload as { organization_id: string }).organization_id, "org_1");
    assert.equal((updateCall.payload as { status: string }).status, "reserved");
    assert.ok((updateCall.payload as { reserved_at: string }).reserved_at);
    // The UPDATE re-checks status/organization_id at write time — the whole
    // point of the race-safety.
    assert.equal(updateCall.filters["status"], "available");
    assert.equal(updateCall.filters["organization_id"], null);
  });

  test("applies the provider filter always, and the country filter only when supplied", async () => {
    const { client, calls } = makeFakeSupabase({
      select: [{ data: [], error: null }],
      update: [],
    });
    await claimAvailablePhoneNumber(client, { organizationId: "org_1", provider: "sarvam" });
    const selectCall = calls.find((c) => c.type === "select")!;
    assert.equal(selectCall.filters["provider"], "sarvam");
    assert.equal("country" in selectCall.filters, false);

    const { client: client2, calls: calls2 } = makeFakeSupabase({
      select: [{ data: [], error: null }],
      update: [],
    });
    await claimAvailablePhoneNumber(client2, {
      organizationId: "org_1",
      provider: "sarvam",
      country: "IN",
    });
    const selectCall2 = calls2.find((c) => c.type === "select")!;
    assert.equal(selectCall2.filters["country"], "IN");
  });

  test("when a concurrent claim wins the race on the first candidate, retries and succeeds on the next candidate", async () => {
    const claimedRow = { id: "num_2", organization_id: "org_1", status: "reserved" };
    const { client, calls } = makeFakeSupabase({
      select: [
        { data: [{ id: "num_1" }], error: null },
        { data: [{ id: "num_2" }], error: null },
      ],
      update: [
        { data: [], error: null }, // lost the race on num_1 — 0 rows matched
        { data: [claimedRow], error: null }, // won on num_2
      ],
    });
    const result = await claimAvailablePhoneNumber(client, {
      organizationId: "org_1",
      provider: "sarvam",
    });
    assert.deepEqual(result, claimedRow);
    assert.equal(calls.filter((c) => c.type === "select").length, 2);
    assert.equal(calls.filter((c) => c.type === "update").length, 2);
  });

  test("gives up and returns null after repeatedly losing the race, rather than retrying forever", async () => {
    const ATTEMPTS = 5;
    const { client, calls } = makeFakeSupabase({
      select: Array.from({ length: ATTEMPTS }, (_, i) => ({
        data: [{ id: `num_${i}` }],
        error: null,
      })),
      update: Array.from({ length: ATTEMPTS }, () => ({ data: [], error: null })),
    });
    const result = await claimAvailablePhoneNumber(client, {
      organizationId: "org_1",
      provider: "sarvam",
    });
    assert.equal(result, null);
    assert.equal(calls.filter((c) => c.type === "select").length, ATTEMPTS);
  });

  test("propagates a Supabase error from the candidate select rather than swallowing it", async () => {
    const { client } = makeFakeSupabase({
      select: [{ data: null, error: new Error("boom") }],
      update: [],
    });
    await assert.rejects(
      claimAvailablePhoneNumber(client, { organizationId: "org_1", provider: "sarvam" }),
    );
  });

  test("propagates a Supabase error from the claim update rather than swallowing it", async () => {
    const { client } = makeFakeSupabase({
      select: [{ data: [{ id: "num_1" }], error: null }],
      update: [{ data: null, error: new Error("boom") }],
    });
    await assert.rejects(
      claimAvailablePhoneNumber(client, { organizationId: "org_1", provider: "sarvam" }),
    );
  });
});
