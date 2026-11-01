import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  assertWhatsAppUnlockedForCaller,
  featureLockedAs,
} from "./whatsapp-feature-gate.server.ts";

/**
 * Runtime tests of the WhatsApp onboarding gate. The database side (why the
 * caller's client must be used: service_role has no EXECUTE on
 * feature_locked) is proven on real PostgreSQL in
 * supabase/migrations/whatsapp_feature_gate.pg.test.ts.
 */

const ORIGINAL_BYPASS = process.env["BYPASS_BILLING_GATES"];
afterEach(() => {
  if (ORIGINAL_BYPASS === undefined) delete process.env["BYPASS_BILLING_GATES"];
  else process.env["BYPASS_BILLING_GATES"] = ORIGINAL_BYPASS;
});

function callerClient(result: { data: boolean | null; error: { message: string } | null }) {
  const calls: { fn: string; args: unknown }[] = [];
  const client = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return result;
    },
  };
  return { client: client as never, calls };
}

describe("assertWhatsAppUnlockedForCaller", () => {
  test("asks feature_locked for exactly this organization and 'whatsapp', through the caller's client", async () => {
    delete process.env["BYPASS_BILLING_GATES"];
    const { client, calls } = callerClient({ data: false, error: null });
    await assertWhatsAppUnlockedForCaller(client, "org-a");
    assert.deepEqual(calls, [
      { fn: "feature_locked", args: { _org: "org-a", _feature: "whatsapp" } },
    ]);
  });

  test("a locked organization is refused with the gate's message", async () => {
    delete process.env["BYPASS_BILLING_GATES"];
    const { client } = callerClient({ data: true, error: null });
    await assert.rejects(
      assertWhatsAppUnlockedForCaller(client, "org-a"),
      /not available for this workspace/,
    );
  });

  test("an evaluation error fails closed (never treated as unlocked)", async () => {
    delete process.env["BYPASS_BILLING_GATES"];
    const { client } = callerClient({
      data: null,
      error: { message: "permission denied for function feature_locked" },
    });
    await assert.rejects(assertWhatsAppUnlockedForCaller(client, "org-a"), /Could not evaluate/);
  });

  test("BYPASS_BILLING_GATES keeps its existing meaning (checked first, no RPC)", async () => {
    process.env["BYPASS_BILLING_GATES"] = "true";
    const { client, calls } = callerClient({ data: true, error: null });
    await assertWhatsAppUnlockedForCaller(client, "org-a");
    assert.equal(calls.length, 0);
  });

  test("featureLockedAs passes the RPC result through unchanged", async () => {
    const { client } = callerClient({ data: true, error: null });
    assert.deepEqual(await featureLockedAs(client)("org-x", "whatsapp"), {
      data: true,
      error: null,
    });
  });
});
