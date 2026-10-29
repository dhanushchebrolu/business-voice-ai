import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  replyToInboundWhatsAppMessage,
  replyToInboundWhatsAppMessages,
  recoverPendingWhatsAppReplies,
  isHandoffRequest,
  HANDOFF_ACKNOWLEDGEMENT,
  WHATSAPP_EXCLUDED_TOOLS,
  MAX_AI_REPLIES_PER_WINDOW,
  STALE_CLAIM_MS,
  HISTORY_LIMIT,
  AI_REPLY_ATTEMPTS,
} from "./whatsapp-ai-reply.server.ts";
import { latestConsent } from "./whatsapp-consent.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

const ORIGINAL_ENV = { ...process.env };
const NOW = new Date("2026-10-18T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

beforeEach(() => {
  process.env["VOBIZ_AUTH_ID"] = "MA_TEST";
  process.env["VOBIZ_AUTH_TOKEN"] = "vobiz-test-token";
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

function fakeMeta(status = 200) {
  const sent: { to: string; body: string; url: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    sent.push({ url, to: payload.to, body: payload.text?.body });
    return new Response(
      JSON.stringify(
        status === 200
          ? {
              id: `vmsg.R${sent.length}`,
              status: "pending",
              meta_message_id: `wamid.R${sent.length}`,
            }
          : { error: { message: "nope" } },
      ),
      { status },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

type GenCall = { ctx: Record<string, unknown>; history: { role: string; content: string }[] };
function fakeAi(behaviour: (call: number) => Promise<{ reply: string }>) {
  const calls: GenCall[] = [];
  const generateReply = (async (
    _db: unknown,
    ctx: Record<string, unknown>,
    history: GenCall["history"],
  ) => {
    calls.push({ ctx, history });
    return behaviour(calls.length);
  }) as never;
  return { generateReply, calls };
}
const okAi = () => fakeAi(async () => ({ reply: "We open at 9am tomorrow." }));

function seed(
  over: {
    aiEnabled?: boolean;
    agentConfigId?: string | null;
    agentOrg?: string;
    connectionStatus?: string;
    inboundAt?: string;
    content?: string;
    extraMessages?: Record<string, unknown>[];
  } = {},
) {
  return {
    whatsapp_connections: [
      {
        id: "conn-a",
        organization_id: "org-a",
        business_id: "biz-a",
        phone_number_id: "PN_A",
        status: over.connectionStatus ?? "connected",
        agent_config_id: over.agentConfigId === undefined ? "agent-a" : over.agentConfigId,
        provider: "vobiz",
        vobiz_channel_id: "ch-token-a",
      },
    ],
    agent_configs: [
      { id: "agent-a", organization_id: over.agentOrg ?? "org-a", business_id: "biz-a" },
      { id: "agent-b", organization_id: "org-b", business_id: "biz-b" },
    ],
    whatsapp_conversations: [
      {
        id: "conv-a",
        organization_id: "org-a",
        whatsapp_connection_id: "conn-a",
        wa_id: "919876543210",
        ai_enabled: over.aiEnabled ?? true,
      },
    ],
    whatsapp_messages: [
      ...(over.extraMessages ?? []),
      {
        id: "in-1",
        organization_id: "org-a",
        whatsapp_connection_id: "conn-a",
        conversation_id: "conv-a",
        wa_message_id: "wamid.IN1",
        direction: "inbound",
        message_type: "text",
        content: over.content ?? "What time do you open tomorrow?",
        status: "received",
        occurred_at: over.inboundAt ?? minutesAgo(2),
        created_at: over.inboundAt ?? minutesAgo(2),
      },
    ],
  };
}

const reply = (db: ReturnType<typeof createFakeDb>, ai = okAi(), meta = fakeMeta(), id = "in-1") =>
  replyToInboundWhatsAppMessage(db.client, id, {
    generateReply: ai.generateReply,
    fetchImpl: meta.fetchImpl,
    sleep: async () => {},
    now: () => NOW,
  });

const replies = (db: ReturnType<typeof createFakeDb>) =>
  db.rows("whatsapp_messages").filter((m) => m["reply_to_message_id"] === "in-1");

describe("replyToInboundWhatsAppMessage", () => {
  test("happy path: the tenant's own agent answers with history, without booking/payment tools, and the reply is sent and linked", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    const ai = okAi();
    const meta = fakeMeta();
    assert.equal(await reply(db, ai, meta), "replied");
    assert.equal(ai.calls.length, 1);
    const { extraTools, ...ctx } = ai.calls[0]!.ctx as {
      extraTools: { schema: { name: string } }[];
    };
    assert.deepEqual(ctx, {
      organizationId: "org-a",
      businessId: "biz-a",
      agentConfigId: "agent-a",
      source: "whatsapp",
      excludeToolNames: WHATSAPP_EXCLUDED_TOOLS,
    });
    assert.deepEqual(
      extraTools.map((t) => t.schema.name),
      ["list_my_bookings", "propose_booking", "propose_reschedule"],
    );
    for (const direct of [
      "book_appointment",
      "reschedule_appointment",
      "create_payment_required_booking",
      "request_payment",
    ]) {
      assert.ok(WHATSAPP_EXCLUDED_TOOLS.includes(direct as never), direct);
    }
    assert.deepEqual(ai.calls[0]!.history.at(-1), {
      role: "user",
      content: "What time do you open tomorrow?",
    });
    assert.deepEqual(meta.sent, [
      {
        url: "https://api.vobiz.ai/api/v1/messaging/messages",
        to: "+919876543210",
        body: "We open at 9am tomorrow.",
      },
    ]);
    const [row] = replies(db);
    assert.equal(row!["status"], "sent");
    assert.equal(row!["content"], "We open at 9am tomorrow.");
    assert.equal(row!["organization_id"], "org-a");
    assert.equal(
      db.rows("whatsapp_conversations")[0]!["last_message_preview"],
      "We open at 9am tomorrow.",
    );
  });

  test("history is the latest HISTORY_LIMIT text messages, oldest first, skipping failed replies", async () => {
    const extra = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => ({
      id: `old-${i}`,
      organization_id: "org-a",
      whatsapp_connection_id: "conn-a",
      conversation_id: "conv-a",
      direction: i % 2 ? "outbound" : "inbound",
      message_type: "text",
      content: `m${i}`,
      status: i === HISTORY_LIMIT + 3 ? "failed" : "sent",
      occurred_at: minutesAgo(100 - i),
    }));
    const db = createFakeDb(seed({ extraMessages: extra }), { now: () => NOW });
    const ai = okAi();
    await reply(db, ai);
    const history = ai.calls[0]!.history;
    assert.equal(history.length, HISTORY_LIMIT);
    assert.equal(history.at(-1)!.content, "What time do you open tomorrow?");
    assert.ok(!history.some((h) => h.content === `m${HISTORY_LIMIT + 3}`), "failed reply excluded");
    assert.equal(history.at(-2)!.content, `m${HISTORY_LIMIT + 4}`);
    assert.equal(history.at(-2)!.role, "user");
    assert.equal(history.at(-3)!.content, `m${HISTORY_LIMIT + 2}`, "skips the failed m23");
    assert.equal(history.at(-4)!.role, "assistant");
  });

  test("never replies twice to the same inbound message (webhook retry, recovery sweep, concurrent workers)", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    const ai = okAi();
    const meta = fakeMeta();
    const results = await Promise.all([
      reply(db, ai, meta),
      reply(db, ai, meta),
      reply(db, ai, meta),
    ]);
    assert.deepEqual(results.sort(), ["duplicate", "duplicate", "replied"]);
    assert.equal(await reply(db, ai, meta), "duplicate");
    assert.equal(meta.sent.length, 1);
    assert.equal(ai.calls.length, 1);
    assert.equal(replies(db).length, 1);
  });

  test("AI failure: retried once, then the claim ends 'failed' and nothing is sent", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    const ai = fakeAi(async () => {
      throw new Error("Anthropic 529 overloaded");
    });
    const meta = fakeMeta();
    assert.equal(await reply(db, ai, meta), "failed_ai");
    assert.equal(ai.calls.length, AI_REPLY_ATTEMPTS);
    assert.equal(meta.sent.length, 0);
    const [row] = replies(db);
    assert.equal(row!["status"], "failed");
    assert.equal(row!["error_message"], "The AI reply could not be generated.");
    assert.equal(await reply(db, okAi(), meta), "duplicate", "a failed reply is not re-attempted");
  });

  test("AI timeout counts as a failure; a retry that succeeds still replies once", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    const ai = fakeAi((n) =>
      n === 1 ? new Promise(() => {}) : Promise.resolve({ reply: "Hello!" }),
    );
    const meta = fakeMeta();
    const outcome = await replyToInboundWhatsAppMessage(db.client, "in-1", {
      generateReply: ai.generateReply,
      fetchImpl: meta.fetchImpl,
      now: () => NOW,
      aiTimeoutMs: 20,
    });
    assert.equal(outcome, "replied");
    assert.equal(meta.sent.length, 1);

    const db2 = createFakeDb(seed(), { now: () => NOW });
    const hang = fakeAi(() => new Promise(() => {}));
    const outcome2 = await replyToInboundWhatsAppMessage(db2.client, "in-1", {
      generateReply: hang.generateReply,
      fetchImpl: meta.fetchImpl,
      now: () => NOW,
      aiTimeoutMs: 20,
    });
    assert.equal(outcome2, "failed_ai");
    assert.equal(replies(db2)[0]!["error_message"], "The AI reply timed out.");
  });

  test("an empty model reply sends nothing", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    const meta = fakeMeta();
    assert.equal(
      await reply(
        db,
        fakeAi(async () => ({ reply: "   " })),
        meta,
      ),
      "skipped_empty_reply",
    );
    assert.equal(meta.sent.length, 0);
  });

  test("send failure: recorded on the reply row, not retried by the next attempt", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    const meta = fakeMeta(400);
    assert.equal(await reply(db, okAi(), meta), "failed_send");
    assert.equal(replies(db)[0]!["status"], "failed");
    assert.equal(await reply(db, okAi(), fakeMeta()), "duplicate");
  });

  test("human handoff: AI is switched off, the customer gets an acknowledgement, and later messages get no AI reply", async () => {
    const db = createFakeDb(seed({ content: "Can I talk to a person please?" }), {
      now: () => NOW,
    });
    const ai = okAi();
    const meta = fakeMeta();
    assert.equal(await reply(db, ai, meta), "handoff");
    assert.equal(ai.calls.length, 0);
    assert.deepEqual(
      meta.sent.map((s) => s.body),
      [HANDOFF_ACKNOWLEDGEMENT],
    );
    const conv = db.rows("whatsapp_conversations")[0]!;
    assert.equal(conv["ai_enabled"], false);
    assert.equal(conv["handoff_requested_at"], NOW.toISOString());

    db.rows("whatsapp_messages").push({
      ...db.rows("whatsapp_messages").find((m) => m["id"] === "in-1")!,
      id: "in-2",
      wa_message_id: "wamid.IN2",
      content: "hello?",
    });
    assert.equal(await reply(db, ai, meta, "in-2"), "skipped_ai_disabled");
    assert.equal(meta.sent.length, 1);
  });

  test("handoff detection", () => {
    for (const t of [
      "I want a human",
      "talk to someone",
      "Can I speak with your manager",
      "real person please",
      "connect me to a representative",
    ]) {
      assert.equal(isHandoffRequest(t), true, t);
    }
    for (const t of [
      "Is the staff parking free?",
      "I'm a travel agent booking for a client",
      "What time do you open?",
      "humanity",
    ]) {
      assert.equal(isHandoffRequest(t), false, t);
    }
  });

  test("guards that send nothing and write nothing", async () => {
    const cases: [Parameters<typeof seed>[0], string][] = [
      [{ aiEnabled: false }, "skipped_ai_disabled"],
      [{ agentConfigId: null }, "skipped_no_agent"],
      [{ connectionStatus: "disconnected" }, "skipped_no_agent"],
      [{ agentConfigId: "agent-b" }, "skipped_no_agent"], // another tenant's agent
      [{ agentOrg: "org-b" }, "skipped_no_agent"],
      [{ inboundAt: minutesAgo(24 * 60 + 1) }, "skipped_window_closed"],
    ];
    for (const [over, expected] of cases) {
      const db = createFakeDb(seed(over), { now: () => NOW });
      const ai = okAi();
      const meta = fakeMeta();
      assert.equal(await reply(db, ai, meta), expected, JSON.stringify(over));
      assert.equal(ai.calls.length, 0);
      assert.equal(meta.sent.length, 0);
      assert.equal(replies(db).length, 0);
    }
  });

  test("not an inbound text / unknown id: skipped", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    assert.equal(await reply(db, okAi(), fakeMeta(), "missing"), "skipped_not_found");
    db.rows("whatsapp_messages")[0]!["message_type"] = "image";
    assert.equal(await reply(db), "skipped_not_text");
  });

  test("a message from one tenant's conversation is never answered with data from another tenant", async () => {
    const s = seed();
    // The inbound row claims org-b, but its conversation and connection belong to org-a.
    s.whatsapp_messages[0]!["organization_id"] = "org-b";
    const db = createFakeDb(s, { now: () => NOW });
    const ai = okAi();
    assert.equal(await reply(db, ai), "skipped_not_found");
    assert.equal(ai.calls.length, 0);
  });

  test("rate cap: at most MAX_AI_REPLIES_PER_WINDOW recent AI replies per conversation", async () => {
    const extra = Array.from({ length: MAX_AI_REPLIES_PER_WINDOW }, (_, i) => ({
      id: `r-${i}`,
      organization_id: "org-a",
      whatsapp_connection_id: "conn-a",
      conversation_id: "conv-a",
      direction: "outbound",
      message_type: "text",
      status: "sent",
      reply_to_message_id: `x-${i}`,
      created_at: minutesAgo(1),
    }));
    const db = createFakeDb(seed({ extraMessages: extra }), { now: () => NOW });
    const meta = fakeMeta();
    assert.equal(await reply(db, okAi(), meta), "skipped_rate_limited");
    assert.equal(meta.sent.length, 0);
  });

  test("a stale claim with no content (crashed before sending) is taken over; a fresh or already-sending claim is not", async () => {
    const claim = (claimedAgo: number, content: string | null, takeovers = 0) => ({
      id: "claim",
      organization_id: "org-a",
      whatsapp_connection_id: "conn-a",
      conversation_id: "conv-a",
      direction: "outbound",
      message_type: "text",
      status: "queued",
      content,
      reply_to_message_id: "in-1",
      metadata: {
        origin: "ai",
        claimed_at: new Date(NOW.getTime() - claimedAgo).toISOString(),
        takeovers,
      },
      created_at: minutesAgo(30),
    });
    const stale = createFakeDb(seed({ extraMessages: [claim(STALE_CLAIM_MS + 1000, null)] }), {
      now: () => NOW,
    });
    const meta = fakeMeta();
    assert.equal(await reply(stale, okAi(), meta), "replied");
    assert.equal(replies(stale).length, 1);
    assert.equal(replies(stale)[0]!["status"], "sent");
    assert.equal((replies(stale)[0]!["metadata"] as Record<string, unknown>)["takeovers"], 1);

    for (const c of [
      claim(10_000, null),
      claim(STALE_CLAIM_MS + 1000, "maybe already at Meta"),
      claim(STALE_CLAIM_MS + 1000, null, 2),
    ]) {
      const db = createFakeDb(seed({ extraMessages: [c] }), { now: () => NOW });
      const m = fakeMeta();
      assert.equal(await reply(db, okAi(), m), "duplicate");
      assert.equal(m.sent.length, 0);
    }
  });
});

describe("replyToInboundWhatsAppMessages / recoverPendingWhatsAppReplies", () => {
  test("one failing message never stops the rest", async () => {
    let failConversationRead = true;
    const db = createFakeDb(seed(), {
      now: () => NOW,
      failWhen: (table, op) => {
        if (table === "whatsapp_conversations" && op === "select" && failConversationRead) {
          failConversationRead = false;
          return { code: "08006", message: "connection failure" };
        }
        return null;
      },
    });
    db.rows("whatsapp_messages").push({
      ...db.rows("whatsapp_messages")[0]!,
      id: "in-2",
      wa_message_id: "wamid.IN2",
    });
    const meta = fakeMeta();
    const results = await replyToInboundWhatsAppMessages(db.client, ["in-1", "in-2"], {
      generateReply: okAi().generateReply,
      fetchImpl: meta.fetchImpl,
      now: () => NOW,
    });
    assert.deepEqual(results, { "in-1": "error", "in-2": "replied" });
  });

  test("the recovery sweep answers messages whose background reply never ran, and nothing already answered", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    const meta = fakeMeta();
    const deps = { generateReply: okAi().generateReply, fetchImpl: meta.fetchImpl, now: () => NOW };
    const first = await recoverPendingWhatsAppReplies(db.client, deps);
    assert.deepEqual(
      { examined: first.examined, attempted: first.attempted },
      { examined: 1, attempted: 1 },
    );
    assert.equal(meta.sent.length, 1);
    const second = await recoverPendingWhatsAppReplies(db.client, deps);
    assert.deepEqual(
      { examined: second.examined, attempted: second.attempted },
      { examined: 1, attempted: 0 },
    );
    assert.equal(meta.sent.length, 1);
  });

  test("the recovery sweep leaves the newest minute to the webhook's own background reply", async () => {
    const db = createFakeDb(seed({ inboundAt: new Date(NOW.getTime() - 10_000).toISOString() }), {
      now: () => NOW,
    });
    const result = await recoverPendingWhatsAppReplies(db.client, { now: () => NOW });
    assert.equal(result.examined, 0);
  });

  test("a message skipped because AI was off, no agent was assigned, or the chat was rate-limited never gets a late AI reply", async () => {
    const recentReplies = Array.from({ length: MAX_AI_REPLIES_PER_WINDOW }, (_, i) => ({
      id: `out-r${i}`,
      organization_id: "org-a",
      whatsapp_connection_id: "conn-a",
      conversation_id: "conv-a",
      direction: "outbound",
      message_type: "text",
      content: "earlier reply",
      status: "sent",
      reply_to_message_id: `in-old-${i}`,
      occurred_at: minutesAgo(3),
      created_at: minutesAgo(3),
    }));
    const cases: [
      Parameters<typeof seed>[0],
      string,
      (db: ReturnType<typeof createFakeDb>) => void,
      number,
    ][] = [
      // AI turned back on five minutes later.
      [
        { aiEnabled: false },
        "skipped_ai_disabled",
        (db) => (db.rows("whatsapp_conversations")[0]!["ai_enabled"] = true),
        5,
      ],
      // An agent assigned five minutes later.
      [
        { agentConfigId: null },
        "skipped_no_agent",
        (db) => (db.rows("whatsapp_connections")[0]!["agent_config_id"] = "agent-a"),
        5,
      ],
      // The rate-limit window has passed by the next sweep.
      [{ extraMessages: recentReplies }, "skipped_rate_limited", () => {}, 12],
    ];
    for (const [over, expected, later, minutesLater] of cases) {
      const db = createFakeDb(seed(over), { now: () => NOW });
      assert.equal(await reply(db), expected);
      later(db);
      const ai = okAi();
      const meta = fakeMeta();
      const sweepAt = new Date(NOW.getTime() + minutesLater * 60_000);
      await recoverPendingWhatsAppReplies(db.client, {
        generateReply: ai.generateReply,
        fetchImpl: meta.fetchImpl,
        sleep: async () => {},
        now: () => sweepAt,
      });
      assert.equal(ai.calls.length, 0, expected);
      assert.equal(meta.sent.length, 0, expected);
      // A direct retry (e.g. a redelivery) doesn't answer it either.
      await replyToInboundWhatsAppMessage(db.client, "in-1", {
        generateReply: ai.generateReply,
        fetchImpl: meta.fetchImpl,
        sleep: async () => {},
        now: () => sweepAt,
      });
      assert.equal(meta.sent.length, 0, expected);
    }
  });

  test("a message whose own reply claim is in flight is never marked rate-limited; a crashed claim is taken over once", async () => {
    const others = Array.from({ length: MAX_AI_REPLIES_PER_WINDOW }, (_, i) => ({
      id: `out-r${i}`,
      organization_id: "org-a",
      whatsapp_connection_id: "conn-a",
      conversation_id: "conv-a",
      direction: "outbound",
      message_type: "text",
      content: "earlier reply",
      status: "sent",
      reply_to_message_id: `in-old-${i}`,
      occurred_at: minutesAgo(3),
      created_at: minutesAgo(3),
    }));
    // The webhook's worker claimed the reply for in-1 (within the limit at
    // the time) and is still generating it.
    const claim = (claimedAt: string) => ({
      id: "claim-1",
      organization_id: "org-a",
      whatsapp_connection_id: "conn-a",
      conversation_id: "conv-a",
      direction: "outbound",
      message_type: "text",
      content: null,
      status: "queued",
      reply_to_message_id: "in-1",
      metadata: { origin: "ai", claimed_at: claimedAt, takeovers: 0 },
      created_at: claimedAt,
    });
    const db = createFakeDb(seed({ extraMessages: [...others, claim(minutesAgo(1))] }), {
      now: () => NOW,
    });
    const ai = okAi();
    const meta = fakeMeta();
    const sweep = (minutesLater: number) =>
      recoverPendingWhatsAppReplies(db.client, {
        generateReply: ai.generateReply,
        fetchImpl: meta.fetchImpl,
        sleep: async () => {},
        now: () => new Date(NOW.getTime() + minutesLater * 60_000),
      });
    const inbound = () => db.rows("whatsapp_messages").find((m) => m["id"] === "in-1")!;
    const skipped = () =>
      (inbound()["metadata"] as Record<string, unknown> | null)?.["ai_reply_skipped"];

    // The recovery sweep sees it while the claim is still active.
    await sweep(0);
    assert.equal(skipped(), undefined, "not marked rate-limited");
    assert.equal(meta.sent.length, 0, "the claim's owner is still working on it");

    // The owner crashed; once the claim is stale, the sweep takes it over and replies once.
    await sweep(STALE_CLAIM_MS / 60_000 + 1);
    await sweep(STALE_CLAIM_MS / 60_000 + 2);
    assert.equal(meta.sent.length, 1);
    assert.equal(replies(db).length, 1, "no second reply row");
    assert.equal(skipped(), undefined);
  });

  test("a message whose reply was merely interrupted is still recovered", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    const meta = fakeMeta();
    await recoverPendingWhatsAppReplies(db.client, {
      generateReply: okAi().generateReply,
      fetchImpl: meta.fetchImpl,
      now: () => new Date(NOW.getTime() + 5 * 60_000),
    });
    assert.equal(meta.sent.length, 1);
  });
});

describe("STOP / START keywords", () => {
  test("STOP records an opt-out for both scopes and is acknowledged — even with AI off and no agent", async () => {
    for (const over of [{ aiEnabled: false }, { agentConfigId: null }]) {
      const db = createFakeDb(seed({ ...over, content: "STOP" }), { now: () => NOW });
      const ai = okAi();
      const meta = fakeMeta();
      assert.equal(await reply(db, ai, meta), "consent_updated");
      assert.equal(ai.calls.length, 0);
      assert.deepEqual(
        db
          .rows("whatsapp_consent_events")
          .map((e) => [e["scope"], e["action"], e["source"], e["wa_id"]]),
        [
          ["transactional", "opt_out", "customer_keyword", "919876543210"],
          ["marketing", "opt_out", "customer_keyword", "919876543210"],
        ],
      );
      assert.equal(meta.sent.length, 1);
      assert.match(meta.sent[0]!.body, /unsubscribed/);
      assert.equal(db.rows("whatsapp_audit_log")[0]!["action"], "consent.opt_out");
      // A redelivery of the same STOP records and sends nothing more.
      assert.equal(await reply(db, ai, meta), "duplicate");
      assert.equal(db.rows("whatsapp_consent_events").length, 2);
    }
  });

  test("START opts back in to transactional messages only — never to marketing", async () => {
    for (const word of ["start", "Subscribe", "unstop", "opt in"]) {
      const db = createFakeDb(seed({ content: word }), { now: () => NOW });
      const meta = fakeMeta();
      assert.equal(await reply(db, okAi(), meta), "consent_updated", word);
      assert.deepEqual(
        db.rows("whatsapp_consent_events").map((e) => [e["scope"], e["action"]]),
        [["transactional", "opt_in"]],
        word,
      );
      assert.equal(meta.sent.length, 1);
      assert.doesNotMatch(meta.sent[0]!.body, /offers|promotion|marketing/i);
    }
  });

  test("STOP is recorded even when the number isn't 'connected' or the 24-hour window has closed; no acknowledgement is sent then", async () => {
    const cases: [Parameters<typeof seed>[0], string][] = [
      [{ connectionStatus: "needs_attention" }, "connection"],
      [{ connectionStatus: "error" }, "connection"],
      [{ inboundAt: minutesAgo(26 * 60) }, "window"],
    ];
    for (const [over, why] of cases) {
      const db = createFakeDb(seed({ ...over, content: "STOP" }), { now: () => NOW });
      const ai = okAi();
      const meta = fakeMeta();
      assert.equal(await reply(db, ai, meta), "consent_updated", JSON.stringify(over));
      assert.deepEqual(
        db.rows("whatsapp_consent_events").map((e) => [e["scope"], e["action"]]),
        [
          ["transactional", "opt_out"],
          ["marketing", "opt_out"],
        ],
        JSON.stringify(over),
      );
      assert.equal(meta.sent.length, 0, "nothing can be sent on this connection/window");
      assert.equal(ai.calls.length, 0);
      // The reply slot is settled (failed, with the reason), so recovery and
      // redeliveries neither record again nor try to send.
      const [row] = replies(db);
      assert.equal(row!["status"], "failed");
      assert.match(String(row!["error_message"]), /recorded/i);
      assert.match(String(row!["error_message"]), why === "window" ? /24-hour/ : /connected/);
      assert.equal(await reply(db, ai, meta), "duplicate");
      assert.equal(db.rows("whatsapp_consent_events").length, 2);
    }
  });

  test("consent is ordered by when the customer sent the keyword: a delayed START can't override a later STOP", async () => {
    const stop = {
      id: "in-2",
      organization_id: "org-a",
      whatsapp_connection_id: "conn-a",
      conversation_id: "conv-a",
      wa_message_id: "wamid.IN2",
      direction: "inbound",
      message_type: "text",
      content: "STOP",
      status: "received",
      occurred_at: minutesAgo(5),
      created_at: minutesAgo(5),
    };
    const db = createFakeDb(
      seed({ content: "START", inboundAt: minutesAgo(10), extraMessages: [stop] }),
      {
        now: () => NOW,
      },
    );
    const at = (m: number) => ({
      sleep: async () => {},
      fetchImpl: fakeMeta().fetchImpl,
      now: () => new Date(NOW.getTime() + m * 60_000),
    });
    // STOP is processed right away; START's reply was interrupted and the recovery sweep runs it later.
    assert.equal(await replyToInboundWhatsAppMessage(db.client, "in-2", at(0)), "consent_updated");
    assert.equal(await replyToInboundWhatsAppMessage(db.client, "in-1", at(2)), "consent_updated");
    const latest = await latestConsent(db.client, "biz-a", "transactional", ["919876543210"]);
    assert.equal(latest.get("919876543210"), "opt_out");
    // Each event carries its message's own time, not the processing time.
    const times = db
      .rows("whatsapp_consent_events")
      .map((e) => [e["action"], e["scope"], e["created_at"]])
      .sort();
    assert.deepEqual(times, [
      ["opt_in", "transactional", minutesAgo(10)],
      ["opt_out", "marketing", minutesAgo(5)],
      ["opt_out", "transactional", minutesAgo(5)],
    ]);
  });

  test("STOP and START sent in the same second: the opt-out wins, whichever is processed first", async () => {
    for (const order of [
      ["in-1", "in-2"],
      ["in-2", "in-1"],
    ]) {
      const sameSecond = new Date(NOW.getTime() - 5 * 60_000).toISOString();
      const db = createFakeDb(
        seed({
          content: "START",
          inboundAt: sameSecond,
          extraMessages: [
            {
              id: "in-2",
              organization_id: "org-a",
              whatsapp_connection_id: "conn-a",
              conversation_id: "conv-a",
              wa_message_id: "wamid.IN2",
              direction: "inbound",
              message_type: "text",
              content: "STOP",
              status: "received",
              occurred_at: sameSecond,
              created_at: sameSecond,
            },
          ],
        }),
        { now: () => NOW },
      );
      for (const id of order) await reply(db, okAi(), fakeMeta(), id);
      const latest = await latestConsent(db.client, "biz-a", "transactional", ["919876543210"]);
      assert.equal(latest.get("919876543210"), "opt_out", order.join(","));
    }
  });

  test("a non-keyword message on a non-connected number or outside the window still writes nothing", async () => {
    for (const over of [
      { connectionStatus: "needs_attention" },
      { inboundAt: minutesAgo(26 * 60) },
    ]) {
      const db = createFakeDb(seed(over), { now: () => NOW });
      await reply(db);
      assert.equal(replies(db).length, 0);
      assert.equal(db.rows("whatsapp_consent_events").length, 0);
    }
  });
});

describe("confirmed WhatsApp actions through the reply worker", () => {
  test("YES to an open proposal is executed by the server (not the model) with the sender's verified number", async () => {
    const s = seed({
      content: "yes",
      // The reply that showed the customer the proposal was sent.
      extraMessages: [
        {
          id: "out-0",
          organization_id: "org-a",
          whatsapp_connection_id: "conn-a",
          conversation_id: "conv-a",
          direction: "outbound",
          message_type: "text",
          content: "Shall I book it? Reply YES.",
          status: "sent",
          reply_to_message_id: "in-0",
          occurred_at: minutesAgo(3),
          created_at: minutesAgo(3),
        },
      ],
    });
    (s as Record<string, unknown[]>)["businesses"] = [
      { id: "biz-a", organization_id: "org-a", timezone: "Asia/Kolkata", country: "IN" },
    ];
    (s as Record<string, unknown[]>)["whatsapp_pending_actions"] = [
      {
        id: "pa-1",
        organization_id: "org-a",
        business_id: "biz-a",
        conversation_id: "conv-a",
        proposed_in_message_id: "in-0",
        action: "book",
        params: { startIso: "2026-10-21T04:30:00.000Z", endIso: "2026-10-21T05:00:00.000Z" },
        summary: "An appointment",
        expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
      },
    ];
    const db = createFakeDb(s, { now: () => NOW });
    const ai = okAi();
    const meta = fakeMeta();
    const executed: { name: string; input: Record<string, unknown> }[] = [];
    const outcome = await replyToInboundWhatsAppMessage(db.client, "in-1", {
      generateReply: ai.generateReply,
      fetchImpl: meta.fetchImpl,
      sleep: async () => {},
      now: () => NOW,
      actions: {
        executeTool: async (_ctx, name, input) => {
          executed.push({ name, input });
          return {
            content: JSON.stringify({
              success: true,
              bookingOutcome: "confirmed",
              data: { id: "bk-1" },
            }),
          };
        },
      },
    });
    assert.equal(outcome, "action_completed");
    assert.equal(ai.calls.length, 0, "the model isn't asked");
    assert.equal(executed.length, 1);
    assert.equal(executed[0]!.input["customerPhone"], "+919876543210");
    assert.match(meta.sent[0]!.body, /^Booked — see you on/);
    assert.equal(replies(db).length, 1);
  });

  test("a proposal made by a reply that never reached the customer can't be confirmed by a later 'ok'", async () => {
    // The model proposes a booking, then: the AI fails / times out / returns
    // nothing, or the send itself fails.
    const scenarios = [
      ["error", fakeMeta(), "failed_ai"],
      ["empty", fakeMeta(), "skipped_empty_reply"],
      ["send_fails", fakeMeta(400), "failed_send"],
    ] as const;
    for (const [mode, meta, expected] of scenarios) {
      const s = seed({ content: "Can I come tomorrow at 10?" });
      (s as Record<string, unknown[]>)["agent_configs"]![0] = {
        id: "agent-a",
        organization_id: "org-a",
        business_id: "biz-a",
        capabilities: { calendar_book: true },
      };
      const db = createFakeDb(s, { now: () => NOW });
      const ai = fakeAi(async () => {
        const call = ai.calls[ai.calls.length - 1]!;
        const tools = call.ctx["extraTools"] as {
          schema: { name: string };
          execute: (i: Record<string, unknown>) => Promise<unknown>;
        }[];
        await tools
          .find((t) => t.schema.name === "propose_booking")!
          .execute({ startIso: "2026-10-19T04:30:00.000Z", endIso: "2026-10-19T05:00:00.000Z" });
        if (mode === "error") throw new Error("model failed");
        return { reply: mode === "empty" ? "  " : "Shall I book 10am tomorrow? Reply YES." };
      });
      assert.equal(await reply(db, ai, meta), expected, mode);
      assert.equal(db.rows("whatsapp_pending_actions").length > 0, true, mode);
      assert.ok(
        db.rows("whatsapp_pending_actions").every((p) => p["status"] !== "awaiting_confirmation"),
        mode,
      );

      // The customer, having seen nothing, sends "ok".
      db.rows("whatsapp_messages").push({
        id: "in-2",
        organization_id: "org-a",
        whatsapp_connection_id: "conn-a",
        conversation_id: "conv-a",
        wa_message_id: "wamid.IN2",
        direction: "inbound",
        message_type: "text",
        content: "ok",
        status: "received",
        occurred_at: minutesAgo(1),
        created_at: minutesAgo(1),
      });
      const executed: string[] = [];
      await replyToInboundWhatsAppMessage(db.client, "in-2", {
        generateReply: okAi().generateReply,
        fetchImpl: fakeMeta().fetchImpl,
        sleep: async () => {},
        now: () => NOW,
        actions: {
          executeTool: async (_ctx, name) => {
            executed.push(name);
            return { content: JSON.stringify({ success: true, data: { id: "bk-x" } }) };
          },
        },
      });
      assert.deepEqual(executed, [], mode);
    }
  });

  test("a timed-out AI attempt that proposes late leaves no open proposal", async () => {
    const s = seed({ content: "Can I come tomorrow at 10?" });
    (s as Record<string, unknown[]>)["agent_configs"]![0] = {
      id: "agent-a",
      organization_id: "org-a",
      business_id: "biz-a",
      capabilities: { calendar_book: true },
    };
    const db = createFakeDb(s, { now: () => NOW });
    let late: Promise<unknown> = Promise.resolve();
    const ai = fakeAi(async (n) => {
      if (n === 1) {
        const tools = ai.calls[0]!.ctx["extraTools"] as {
          schema: { name: string };
          execute: (i: Record<string, unknown>) => Promise<unknown>;
        }[];
        late = new Promise((r) => setTimeout(r, 30)).then(() =>
          tools
            .find((t) => t.schema.name === "propose_booking")!
            .execute({ startIso: "2026-10-19T04:30:00.000Z", endIso: "2026-10-19T05:00:00.000Z" }),
        );
        await late;
        return { reply: "too late" };
      }
      return { reply: "We have 10am free tomorrow — would you like it?" };
    });
    const meta = fakeMeta();
    const outcome = await replyToInboundWhatsAppMessage(db.client, "in-1", {
      generateReply: ai.generateReply,
      fetchImpl: meta.fetchImpl,
      sleep: async () => {},
      now: () => NOW,
      aiTimeoutMs: 5,
    });
    assert.equal(outcome, "replied");
    await late;
    assert.equal(
      db.rows("whatsapp_pending_actions").filter((p) => p["status"] === "awaiting_confirmation")
        .length,
      0,
    );
  });

  test("a handoff request closes any open proposal", async () => {
    const s = seed({ content: "I want to talk to a person" });
    (s as Record<string, unknown[]>)["whatsapp_pending_actions"] = [
      {
        id: "pa-1",
        organization_id: "org-a",
        business_id: "biz-a",
        conversation_id: "conv-a",
        action: "book",
        params: {},
        summary: "x",
        expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
      },
    ];
    const db = createFakeDb(s, { now: () => NOW });
    assert.equal(await reply(db), "handoff");
    assert.equal(db.rows("whatsapp_pending_actions")[0]!["status"], "superseded");
  });
});
