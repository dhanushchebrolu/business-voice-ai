import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./memory-supabase.test-helper.ts";
import {
  claimWebhookEvent,
  markWebhookEvent,
  processRazorpayPlatformEvent,
  type RazorpayEvent,
} from "./razorpay-platform-webhook.server.ts";
import type { RunProvisioningInput } from "../provisioning-runs.server.ts";

const ledgerUnique = {
  table: "webhook_events",
  key: (r: Record<string, unknown>) => `${r["provider"]}:${r["event_id"]}`,
};

/** A stand-in for record_razorpay_capture with the same contract (the real one is tested on PostgreSQL). */
function captureRpc(orders: Record<string, { org: string; purpose: string; amount: number }>) {
  const seen = new Set<string>();
  return (args: Record<string, unknown>) => {
    const o = orders[args["p_provider_order_id"] as string];
    if (!o) return { found: false };
    if (args["p_amount"] !== o.amount)
      return {
        found: true,
        mismatch: true,
        organization_id: o.org,
        purpose: o.purpose,
        expected_amount: o.amount,
        expected_currency: "INR",
      };
    const pid = args["p_provider_payment_id"] as string;
    const first = !seen.has(pid);
    seen.add(pid);
    return {
      found: true,
      mismatch: false,
      organization_id: o.org,
      purpose: o.purpose,
      payment_id: `pay_row_${pid}`,
      first_capture: first,
    };
  };
}

const captured = (
  orderId: string,
  paymentId: string,
  amount: number,
  kind = "payment.captured",
): RazorpayEvent => ({
  event: kind,
  payload: {
    payment: {
      entity: { id: paymentId, order_id: orderId, amount, currency: "INR", created_at: 1763000000 },
    },
  },
});

function setup() {
  const db = memorySupabase({
    uniques: [ledgerUnique],
    rpc: {
      record_razorpay_capture: captureRpc({
        order_setup: { org: "org_1", purpose: "setup_fee", amount: 999900 },
        order_phone: { org: "org_1", purpose: "phone_service_fee", amount: 150000 },
        order_monthly: { org: "org_1", purpose: "monthly_plan", amount: 499900 },
      }),
    },
  });
  const runs: RunProvisioningInput[] = [];
  const deps = {
    runProvisioning: (async (_admin: unknown, input: RunProvisioningInput) => {
      runs.push(input);
      return { runId: "run_1", claimed: true, status: "waiting", result: null };
    }) as never,
  };
  return { db, runs, deps };
}

describe("event ledger", () => {
  test("a new event is processed; once marked processed, a redelivery is acknowledged without work", async () => {
    const { db } = setup();
    assert.deepEqual(await claimWebhookEvent(db.client, "evt_1", { event: "x" }, {}), {
      process: true,
    });
    await markWebhookEvent(db.client, "evt_1", { processed: true });
    assert.deepEqual(await claimWebhookEvent(db.client, "evt_1", { event: "x" }, {}), {
      process: false,
      reason: "already_processed",
    });
  });

  test("an event whose processing failed is processed again on redelivery (never a silent ok)", async () => {
    const { db } = setup();
    await claimWebhookEvent(db.client, "evt_2", { event: "x" }, {});
    await markWebhookEvent(db.client, "evt_2", { processed: false, error: "boom" });
    assert.deepEqual(await claimWebhookEvent(db.client, "evt_2", { event: "x" }, {}), {
      process: true,
    });
  });

  test("a ledger write error is thrown", async () => {
    const { db } = setup();
    db.failNext("webhook_events", "insert", { message: "db down" });
    await assert.rejects(claimWebhookEvent(db.client, "evt_3", { event: "x" }, {}), {
      message: "db down",
    });
  });
});

describe("processRazorpayPlatformEvent", () => {
  test("setup fee: provisioning runs with the setup_fee trigger and the payment row", async () => {
    const { db, runs, deps } = setup();
    const out = await processRazorpayPlatformEvent(
      db.client,
      captured("order_setup", "pay_1", 999900),
      deps,
    );
    assert.equal(out.note, null);
    assert.deepEqual(runs, [
      { organizationId: "org_1", trigger: "setup_fee", sourcePaymentId: "pay_row_pay_1" },
    ]);
  });

  test("phone service fee: provisioning runs with the phone_service_fee trigger", async () => {
    const { db, runs, deps } = setup();
    await processRazorpayPlatformEvent(db.client, captured("order_phone", "pay_2", 150000), deps);
    assert.equal(runs[0]!.trigger, "phone_service_fee");
  });

  test("monthly plan never starts provisioning", async () => {
    const { db, runs, deps } = setup();
    await processRazorpayPlatformEvent(db.client, captured("order_monthly", "pay_3", 499900), deps);
    assert.equal(runs.length, 0);
  });

  test("payment.captured and order.paid for one payment hand the same payment to the (single-run) provisioner", async () => {
    const { db, runs, deps } = setup();
    await processRazorpayPlatformEvent(db.client, captured("order_setup", "pay_4", 999900), deps);
    await processRazorpayPlatformEvent(
      db.client,
      captured("order_setup", "pay_4", 999900, "order.paid"),
      deps,
    );
    assert.equal(new Set(runs.map((r) => r.sourcePaymentId)).size, 1);
  });

  test("an amount mismatch activates nothing and leaves a note", async () => {
    const { db, runs, deps } = setup();
    const out = await processRazorpayPlatformEvent(
      db.client,
      captured("order_setup", "pay_5", 100),
      deps,
    );
    assert.equal(runs.length, 0);
    assert.match(out.note ?? "", /amount mismatch/);
  });

  test("an unknown order is ignored", async () => {
    const { db, runs, deps } = setup();
    const out = await processRazorpayPlatformEvent(
      db.client,
      captured("order_other", "pay_6", 1),
      deps,
    );
    assert.equal(runs.length, 0);
    assert.equal(out.note, "order not found");
  });

  test("an rpc error is thrown so the event is retried", async () => {
    const db = memorySupabase({
      rpc: {
        record_razorpay_capture: () => {
          throw new Error("deadlock detected");
        },
      },
    });
    await assert.rejects(
      processRazorpayPlatformEvent(db.client, captured("order_setup", "pay_7", 999900)),
      {
        message: "deadlock detected",
      },
    );
  });

  test("payment.failed never regresses a paid order, and its write error is thrown", async () => {
    const { db, deps } = setup();
    db.tables["payment_orders"] = [
      { id: "o1", provider_order_id: "order_paid", status: "paid" },
      { id: "o2", provider_order_id: "order_open", status: "created" },
    ];
    const failed = (orderId: string): RazorpayEvent => ({
      event: "payment.failed",
      payload: { payment: { entity: { id: "p", order_id: orderId } } },
    });
    await processRazorpayPlatformEvent(db.client, failed("order_paid"), deps);
    await processRazorpayPlatformEvent(db.client, failed("order_open"), deps);
    assert.equal(db.tables["payment_orders"]![0]!["status"], "paid");
    assert.equal(db.tables["payment_orders"]![1]!["status"], "failed");
    db.failNext("payment_orders", "update", { message: "write failed" });
    await assert.rejects(processRazorpayPlatformEvent(db.client, failed("order_open"), deps), {
      message: "write failed",
    });
  });

  test("refund status write errors are thrown", async () => {
    const { db, deps } = setup();
    db.failNext("refunds", "update", { message: "refund write failed" });
    await assert.rejects(
      processRazorpayPlatformEvent(
        db.client,
        { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1" } } } },
        deps,
      ),
      { message: "refund write failed" },
    );
  });
});
