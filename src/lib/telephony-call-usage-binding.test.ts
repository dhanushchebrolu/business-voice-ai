import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

/**
 * Production incident (2026-10-16): every call-ended webhook for a call of
 * one minute or more failed with
 *   "Cannot read properties of undefined (reading 'rest')"
 * because finalizeCallBilling called a detached `supabaseAdmin.rpc`
 * reference — supabase-js's rpc is `return this.rest.rpc(...)`, so it needs
 * the client as `this`. The wallet debit (a normal method call) succeeded,
 * the usage record was never written, and the webhook returned 500.
 *
 * The existing billing suite only scans source text, so this one runs
 * finalizeCallBilling for real against a fake admin client whose methods
 * depend on `this` exactly like supabase-js's, behind the same lazy Proxy
 * client.server.ts exports.
 */

const CLIENT_SPECIFIER = "@/integrations/supabase/client.server";
const FAKE_CLIENT_MODULE = `
const target = () => globalThis.__fakeSupabaseAdmin;
export const supabaseAdmin = new Proxy({}, {
  get(_, prop, receiver) { return Reflect.get(target(), prop, receiver); },
});
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === CLIENT_SPECIFIER) {
      return {
        url: `data:text/javascript,${encodeURIComponent(FAKE_CLIENT_MODULE)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

type RpcCall = { fn: string; args: Record<string, unknown> };

/** Methods reach the backend only through `this.rest`, like supabase-js's SupabaseClient. */
class FakeAdminClient {
  rest: {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>;
    from: (table: string) => unknown;
  };
  rpcCalls: RpcCall[] = [];
  updates: { table: string; values: unknown }[] = [];

  constructor(opts: { usageError?: { code: string; message: string } } = {}) {
    this.rest = {
      rpc: async (fn, args) => {
        this.rpcCalls.push({ fn, args });
        if (fn === "debit_wallet_for_call") {
          return { data: [{ applied: true, already_applied: false, balance: 900 }], error: null };
        }
        if (fn === "record_call_usage") return { data: null, error: opts.usageError ?? null };
        return { data: null, error: { code: "42883", message: "unexpected rpc" } };
      },
      from: (table) => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          update: (values: unknown) => {
            this.updates.push({ table, values });
            return chain;
          },
          maybeSingle: async () =>
            table === "pricing_rules"
              ? { data: { customer_amount: 50, provider_cost: 20, currency: "INR" }, error: null }
              : { data: null, error: null },
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(res, rej),
        };
        return chain;
      },
    };
  }

  rpc(fn: string, args: Record<string, unknown> = {}) {
    return this.rest.rpc(fn, args);
  }

  from(table: string) {
    return this.rest.from(table);
  }
}

const { finalizeCallBilling } = await import("./telephony-guard.server.ts");

const CALL = { id: "call-1", organization_id: "org-1", direction: "inbound" as const };

let client: FakeAdminClient;
beforeEach(() => {
  client = new FakeAdminClient();
  (globalThis as { __fakeSupabaseAdmin?: unknown }).__fakeSupabaseAdmin = client;
});

describe("finalizeCallBilling records call usage through the bound client", () => {
  test("the fake reproduces the incident: a detached rpc throws on `this.rest`", () => {
    const detached = client.rpc;
    assert.throws(() => detached("record_call_usage", {}), {
      message: "Cannot read properties of undefined (reading 'rest')",
    });
  });

  test("a billed call debits the wallet and writes the usage record", async () => {
    const result = await finalizeCallBilling(CALL, 95);

    assert.deepEqual(
      client.rpcCalls.map((c) => c.fn),
      ["debit_wallet_for_call", "record_call_usage"],
    );
    assert.deepEqual(client.rpcCalls[1]!.args, {
      p_organization_id: "org-1",
      p_call_id: "call-1",
      p_kind: "call",
      p_provider: "telephony",
      p_quantity: 2,
      p_unit: "minute",
      p_provider_cost: 40,
      p_billable_cost: 100,
    });
    assert.deepEqual(result, {
      customerCharge: 100,
      providerCost: 40,
      currency: "INR",
      walletBalance: 900,
    });
    assert.equal(client.updates[0]?.table, "call_logs");
  });

  test("a zero-length call is not recorded as usage", async () => {
    await finalizeCallBilling(CALL, 0);
    assert.deepEqual(
      client.rpcCalls.map((c) => c.fn),
      ["debit_wallet_for_call"],
    );
  });

  test("a usage-record failure still surfaces as that error, not a TypeError", async () => {
    client = new FakeAdminClient({ usageError: { code: "42501", message: "permission denied" } });
    (globalThis as { __fakeSupabaseAdmin?: unknown }).__fakeSupabaseAdmin = client;
    const originalError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(finalizeCallBilling(CALL, 60), { code: "42501" });
    } finally {
      console.error = originalError;
    }
  });
});
