import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { maybeCompleteCampaign } from "./campaign-dispatch.server.ts";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";

/**
 * maybeCompleteCampaign marks a running campaign completed only when every
 * enrolled contact is finished. A read it could not make is "not finished",
 * and a pause or cancel that lands between its read and its write wins.
 */

type Row = Record<string, unknown>;
type Hook = { error?: { message: string }; afterRead?: () => void };

function db(contactStatuses: string[], campaignStatus = "running") {
  return memorySupabase({
    tables: {
      campaigns: [{ id: "camp_1", status: campaignStatus }],
      campaign_contacts: contactStatuses.map((status, i) => ({
        id: `cc_${i}`,
        campaign_id: "camp_1",
        status,
      })),
    },
  });
}

/** The client, with the n-th query on a table failing or followed by a side effect. */
function hooked(memory: ReturnType<typeof db>, hooks: Record<string, Hook[]>) {
  const client = memory.client as unknown as { from: (t: string) => unknown };
  const seen: Record<string, number> = {};
  return {
    from(table: string) {
      const hook = hooks[table]?.[seen[table] ?? 0];
      seen[table] = (seen[table] ?? 0) + 1;
      const real = client.from(table) as Record<string | symbol, unknown>;
      const proxy: Record<string | symbol, unknown> = new Proxy(real, {
        get(target, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
              if (hook?.error) return resolve({ data: null, count: null, error: hook.error });
              return (target["then"] as (a: unknown, b: unknown) => unknown).call(
                target,
                (v: unknown) => {
                  hook?.afterRead?.();
                  resolve(v);
                },
                reject,
              );
            };
          }
          const value = target[prop];
          return typeof value === "function"
            ? (...args: unknown[]) => {
                (value as (...a: unknown[]) => unknown).apply(target, args);
                return proxy;
              }
            : value;
        },
      });
      return proxy;
    },
  } as never;
}

describe("maybeCompleteCampaign", () => {
  test("completes a running campaign whose contacts are all finished", async () => {
    const memory = db(["completed", "failed", "opted_out"]);
    assert.equal(await maybeCompleteCampaign("camp_1", memory.client), true);
    assert.equal((memory.tables["campaigns"]![0] as Row)["status"], "completed");
  });

  test("a campaign with a contact still due stays running", async () => {
    const memory = db(["completed", "pending"]);
    assert.equal(await maybeCompleteCampaign("camp_1", memory.client), false);
    assert.equal((memory.tables["campaigns"]![0] as Row)["status"], "running");
  });

  test("a failed read of the open contacts never completes the campaign", async () => {
    const memory = db(["pending", "calling"]);
    const client = hooked(memory, {
      campaign_contacts: [{ error: { message: "connection reset" } }],
    });
    assert.equal(await maybeCompleteCampaign("camp_1", client), false);
    assert.equal((memory.tables["campaigns"]![0] as Row)["status"], "running");
  });

  test("a failed read of the enrolment total never completes the campaign", async () => {
    const memory = db(["completed"]);
    const client = hooked(memory, {
      campaign_contacts: [{}, { error: { message: "timeout" } }],
    });
    assert.equal(await maybeCompleteCampaign("camp_1", client), false);
    assert.equal((memory.tables["campaigns"]![0] as Row)["status"], "running");
  });

  test("a cancel that lands after the status read is kept, not overwritten", async () => {
    const memory = db(["completed", "cancelled"]);
    const campaign = memory.tables["campaigns"]![0] as Row;
    const client = hooked(memory, {
      campaigns: [{ afterRead: () => (campaign["status"] = "cancelled") }],
    });
    assert.equal(await maybeCompleteCampaign("camp_1", client), false);
    assert.equal(campaign["status"], "cancelled");
  });
});
