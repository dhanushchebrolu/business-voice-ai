import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildWhatsAppActionTools,
  handlePendingActionReply,
  parseConfirmation,
  expirePendingActions,
  PENDING_ACTION_TTL_MS,
  type WhatsAppActionContext,
  type WhatsAppActionDeps,
} from "./whatsapp-actions.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

const NOW = new Date("2026-10-20T06:00:00.000Z");
const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

const CTX: WhatsAppActionContext = {
  organizationId: "org-a",
  businessId: "biz-a",
  agentConfigId: "agent-a",
  conversationId: "conv-a",
  waId: "919876543210",
  customerDisplayName: "Asha",
  inboundMessageId: "in-1",
  timezone: "Asia/Kolkata",
  country: "IN",
  now: NOW,
};

function seed(capabilities: Record<string, boolean>, services: Record<string, unknown>[] = []) {
  return {
    agent_configs: [
      { id: "agent-a", organization_id: "org-a", business_id: "biz-a", capabilities },
      {
        id: "agent-b",
        organization_id: "org-b",
        business_id: "biz-b",
        capabilities: { calendar_book: true },
      },
    ],
    services: services.map((s) => ({
      organization_id: "org-a",
      business_id: "biz-a",
      is_active: true,
      currency: "INR",
      ...s,
    })),
  };
}

function recordingTools(results: Record<string, unknown> = {}) {
  const calls: { name: string; input: Record<string, unknown>; ctx: Record<string, unknown> }[] =
    [];
  const deps: WhatsAppActionDeps = {
    executeTool: async (ctx, name, input) => {
      calls.push({ name, input, ctx });
      return {
        content: JSON.stringify(results[name] ?? { success: true, data: { id: `${name}-id` } }),
      };
    },
    ownsBooking: async (input) =>
      input.bookingId === "bk-mine" && input.callerE164 === "+919876543210",
    guardOwnership: async (ctx, input) =>
      ctx.rescheduleAuthorization.bookingId === input["bookingId"] &&
      ctx.callerE164 === "+919876543210"
        ? null
        : {
            content: JSON.stringify({ success: false, error: { code: "NOT_FOUND" } }),
            isError: true,
          },
  };
  return { calls, deps };
}

const tool = (db: ReturnType<typeof createFakeDb>, name: string, deps: WhatsAppActionDeps = {}) =>
  buildWhatsAppActionTools(db.client, CTX, deps).find((t) => t.schema.name === name)!;
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

describe("propose_booking", () => {
  test("stores one pending action; nothing is booked, and the model is told to ask for YES", async () => {
    const db = createFakeDb(seed({ calendar_book: true }));
    const { calls, deps } = recordingTools();
    const out = parse(
      await tool(db, "propose_booking", deps).execute({
        startIso: inHours(26),
        endIso: inHours(26.5),
        // A model-supplied phone is ignored entirely — identity is the WhatsApp sender.
        customerPhone: "+910000000000",
      }),
    );
    assert.equal(out["status"], "awaiting_customer_confirmation");
    assert.equal(calls.length, 0, "no booking tool ran");
    const [pending] = db.rows("whatsapp_pending_actions");
    assert.equal(pending!["action"], "book");
    assert.equal(pending!["status"], "awaiting_confirmation");
    assert.equal(
      pending!["expires_at"],
      new Date(NOW.getTime() + PENDING_ACTION_TTL_MS).toISOString(),
    );
    assert.ok(!JSON.stringify(pending!["params"]).includes("910000000000"));
  });

  test("a new proposal supersedes the open one (one per conversation)", async () => {
    const db = createFakeDb(seed({ calendar_book: true }));
    const t = tool(db, "propose_booking");
    await t.execute({ startIso: inHours(26), endIso: inHours(27) });
    await t.execute({ startIso: inHours(28), endIso: inHours(29) });
    assert.deepEqual(
      db.rows("whatsapp_pending_actions").map((p) => p["status"]),
      ["superseded", "awaiting_confirmation"],
    );
  });

  test("refused without the agent's booking capability, for past/invalid times, and for another tenant's service", async () => {
    const noCap = createFakeDb(seed({}));
    assert.equal(
      parse(
        await tool(noCap, "propose_booking").execute({
          startIso: inHours(26),
          endIso: inHours(27),
        }),
      )["success"],
      false,
    );
    const db = createFakeDb(
      seed({ calendar_book: true }, [{ id: "svc-a", name: "Cleaning", price: 0 }]),
    );
    for (const input of [
      { startIso: inHours(-2), endIso: inHours(-1) },
      { startIso: inHours(27), endIso: inHours(26) },
      { startIso: inHours(26), endIso: inHours(40) },
      { startIso: "tomorrow", endIso: inHours(27) },
      { startIso: inHours(26), endIso: inHours(27), serviceId: "svc-of-another-tenant" },
    ]) {
      assert.equal(
        parse(await tool(db, "propose_booking").execute(input))["success"],
        false,
        JSON.stringify(input),
      );
    }
    assert.equal(db.rows("whatsapp_pending_actions").length, 0);
  });

  test("a priced service with payment capabilities becomes a payment hold at the SERVICE's price", async () => {
    const db = createFakeDb(
      seed({ calendar_book: true, booking_payment_required: true, payment_request: true }, [
        { id: "svc-a", name: "Whitening", price: 1499.5 },
      ]),
    );
    await tool(db, "propose_booking").execute({
      startIso: inHours(26),
      endIso: inHours(27),
      serviceId: "svc-a",
      amountMinorUnits: 1, // not an input: ignored
    });
    const [pending] = db.rows("whatsapp_pending_actions");
    assert.equal(pending!["action"], "book_with_payment");
    assert.equal((pending!["params"] as Record<string, unknown>)["amountMinorUnits"], 149950);
    assert.match(String(pending!["summary"]), /INR 1499\.50/);
  });
});

describe("propose_reschedule", () => {
  test("only for a booking the sender's number owns; same answer for 'not yours' and 'doesn't exist'", async () => {
    const db = createFakeDb(seed({ calendar_reschedule: true }));
    const { deps } = recordingTools();
    const t = tool(db, "propose_reschedule", deps);
    const denied = parse(
      await t.execute({
        bookingId: "bk-someone-else",
        newStartIso: inHours(30),
        newEndIso: inHours(31),
      }),
    );
    assert.deepEqual(denied["error"], {
      code: "NOT_FOUND",
      message: "No booking was found for this customer.",
    });
    assert.equal(
      parse(
        await t.execute({ bookingId: "bk-mine", newStartIso: inHours(30), newEndIso: inHours(31) }),
      )["success"],
      true,
    );
    assert.equal(db.rows("whatsapp_pending_actions")[0]!["action"], "reschedule");
  });
});

describe("parseConfirmation", () => {
  test("clear yes / no only", () => {
    for (const t of ["yes", "YES!", "ok", "confirm", "haan", "👍"])
      assert.equal(parseConfirmation(t), "yes", t);
    for (const t of ["no", "No.", "cancel", "nahi"]) assert.equal(parseConfirmation(t), "no", t);
    for (const t of ["yes but at 5pm", "maybe", "what time?", "no idea, which slots are free?"]) {
      assert.equal(parseConfirmation(t), null, t);
    }
  });
});

describe("handlePendingActionReply", () => {
  async function withProposal(
    caps: Record<string, boolean>,
    input: Record<string, unknown>,
    services: Record<string, unknown>[] = [],
    name = "propose_booking",
  ) {
    const db = createFakeDb(seed(caps, services));
    const { calls, deps } = recordingTools();
    await tool(db, name, deps).execute(input);
    return { db, calls, deps };
  }
  const reply = (
    db: ReturnType<typeof createFakeDb>,
    deps: WhatsAppActionDeps,
    text: string,
    messageId = "in-2",
    now = NOW,
  ) =>
    handlePendingActionReply(
      db.client,
      { ...CTX, inboundMessageId: messageId, now, messageText: text },
      deps,
    );

  test("YES books exactly the proposed slot, with the verified WhatsApp number — once", async () => {
    const { db, calls, deps } = await withProposal(
      { calendar_book: true },
      { startIso: inHours(26), endIso: inHours(26.5), customerName: "Asha" },
    );
    const first = await reply(db, deps, "Yes");
    assert.equal(first.handled && first.status, "completed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "book_appointment");
    assert.equal(calls[0]!.input["customerPhone"], "+919876543210");
    assert.equal(calls[0]!.input["startIso"], inHours(26));
    assert.deepEqual(calls[0]!.ctx, {
      organizationId: "org-a",
      businessId: "biz-a",
      agentConfigId: "agent-a",
      source: "whatsapp",
    });
    // A second YES (duplicate delivery, or the customer repeating) does nothing.
    assert.deepEqual(await reply(db, deps, "yes", "in-3"), { handled: false });
    assert.equal(calls.length, 1);
    assert.equal(db.rows("whatsapp_pending_actions")[0]!["status"], "completed");
  });

  test("two workers racing on the same YES execute it once", async () => {
    const { db, calls, deps } = await withProposal(
      { calendar_book: true },
      { startIso: inHours(26), endIso: inHours(27) },
    );
    const results = await Promise.all([reply(db, deps, "yes"), reply(db, deps, "yes")]);
    assert.equal(calls.length, 1);
    assert.equal(results.filter((r) => r.handled && r.status === "completed").length, 1);
  });

  test("the message that produced the proposal can't confirm it", async () => {
    const { db, calls, deps } = await withProposal(
      { calendar_book: true },
      { startIso: inHours(26), endIso: inHours(27) },
    );
    assert.deepEqual(await reply(db, deps, "yes", "in-1"), { handled: false });
    assert.equal(calls.length, 0);
  });

  test("NO declines; anything else leaves it open; an expired one is closed and not executed", async () => {
    const { db, calls, deps } = await withProposal(
      { calendar_book: true },
      { startIso: inHours(26), endIso: inHours(27) },
    );
    assert.deepEqual(await reply(db, deps, "which other times?"), { handled: false });
    assert.equal(db.rows("whatsapp_pending_actions")[0]!["status"], "awaiting_confirmation");
    const no = await reply(db, deps, "no");
    assert.equal(no.handled && no.status, "declined");
    assert.equal(calls.length, 0);

    const later = await withProposal(
      { calendar_book: true },
      { startIso: inHours(26), endIso: inHours(27) },
    );
    const afterExpiry = new Date(NOW.getTime() + PENDING_ACTION_TTL_MS + 1000);
    assert.deepEqual(await reply(later.db, later.deps, "yes", "in-2", afterExpiry), {
      handled: false,
    });
    assert.equal(later.calls.length, 0);
    assert.equal(later.db.rows("whatsapp_pending_actions")[0]!["status"], "expired");
  });

  test("a slot taken in the meantime: honest reply, nothing claimed as booked", async () => {
    const db = createFakeDb(seed({ calendar_book: true }));
    const { calls, deps } = recordingTools({
      book_appointment: { success: false, error: { code: "SLOT_NO_LONGER_AVAILABLE" } },
    });
    await tool(db, "propose_booking", deps).execute({ startIso: inHours(26), endIso: inHours(27) });
    const out = await reply(db, deps, "yes");
    assert.ok(out.handled && out.status === "failed");
    assert.match(
      out.handled ? String(out.reply) : "",
      /no longer available, so nothing was booked/,
    );
    assert.equal(calls.length, 1);
  });

  test("payment: YES creates the hold, then a payment link for the stored service price; booking is never called confirmed", async () => {
    const db = createFakeDb(
      seed({ calendar_book: true, booking_payment_required: true, payment_request: true }, [
        { id: "svc-a", name: "Whitening", price: 500 },
      ]),
    );
    const { calls, deps } = recordingTools({
      create_payment_required_booking: {
        success: true,
        data: { id: "bk-hold", status: "PENDING_PAYMENT" },
      },
      request_payment: {
        success: true,
        data: { paymentLinkUrl: "https://rzp.io/i/x", whatsappSent: true, status: "CREATED" },
      },
    });
    await tool(db, "propose_booking", deps).execute({
      startIso: inHours(26),
      endIso: inHours(27),
      serviceId: "svc-a",
    });
    const out = await reply(db, deps, "yes");
    assert.deepEqual(
      calls.map((c) => c.name),
      ["create_payment_required_booking", "request_payment"],
    );
    assert.equal(calls[0]!.input["customerPhone"], "+919876543210");
    assert.deepEqual(calls[1]!.input, {
      bookingId: "bk-hold",
      amountMinorUnits: 50000,
      currency: "INR",
    });
    assert.ok(out.handled && out.status === "completed");
    assert.match(
      String(out.handled && out.reply),
      /held .* sent the payment link\. Your booking is confirmed once the payment is received/,
    );
  });

  test("reschedule: executed only with the exact confirmed move, through the ownership guard", async () => {
    const { db, calls, deps } = await withProposal(
      { calendar_reschedule: true },
      { bookingId: "bk-mine", newStartIso: inHours(30), newEndIso: inHours(31) },
      [],
      "propose_reschedule",
    );
    const out = await reply(db, deps, "yes");
    assert.ok(out.handled && out.status === "completed");
    assert.deepEqual(calls[0]!.input, {
      bookingId: "bk-mine",
      newStartIso: inHours(30),
      newEndIso: inHours(31),
    });
  });

  test("expirePendingActions closes unanswered proposals", async () => {
    const { db } = await withProposal(
      { calendar_book: true },
      { startIso: inHours(26), endIso: inHours(27) },
    );
    assert.equal(
      await expirePendingActions(db.client, new Date(NOW.getTime() + PENDING_ACTION_TTL_MS + 1)),
      1,
    );
    assert.equal(db.rows("whatsapp_pending_actions")[0]!["status"], "expired");
  });
});
