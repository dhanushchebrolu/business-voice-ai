import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifyWebhookHandshake,
  verifyWebhookSignature,
  processInboundInstagramWebhook,
} from "./instagram-inbound.server.ts";

/**
 * Behavioral coverage against a scripted fake Supabase client — same
 * spirit as whatsapp-onboarding.server.test.ts. The fake connection row
 * used below always has agent_config_id: null, so
 * generateAndSendInstagramReply (instagram-outbound.server.ts) short-
 * circuits before touching the AI core — that tool-calling chain is
 * already covered by Phase 4's ai-tools.server.test.ts/claude tests; this
 * file's job is verifying THIS module's own persistence, idempotency, and
 * bot-loop-protection logic, not re-exercising the shared AI core.
 */

interface Call {
  table: string;
  op: string;
  payload?: unknown;
  filters: Record<string, unknown>;
}

const CONNECTION_ID = "conn-1";
const ORG_ID = "org-1";
const OWN_ACCOUNT_ID = "ig-business-999";
const CUSTOMER_IGSID = "igsid-customer-1";

function makeFakeSupabase(opts: {
  webhookInsertError?: { code: string } | null;
  connectionRow?: Record<string, unknown> | null;
  messageInsertError?: { code: string } | null;
}) {
  const calls: Call[] = [];

  function builder(table: string, op: string, payload?: unknown) {
    const filters: Record<string, unknown> = {};
    const self = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return self;
      },
      neq(col: string, val: unknown) {
        filters[`neq:${col}`] = val;
        return self;
      },
      or() {
        return self;
      },
      select() {
        return self;
      },
      order() {
        return self;
      },
      limit() {
        return self;
      },
      maybeSingle() {
        calls.push({ table, op, payload, filters });
        if (table === "instagram_connections") {
          return Promise.resolve({ data: opts.connectionRow ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        calls.push({ table, op, payload, filters });
        if (table === "instagram_conversations") {
          return Promise.resolve({ data: { id: "conv-1" }, error: null });
        }
        return Promise.resolve({ data: { id: "row-1" }, error: null });
      },
      then(resolve: (r: unknown) => void, reject: (e: unknown) => void) {
        calls.push({ table, op, payload, filters });
        let result: { error: unknown } = { error: null };
        if (table === "webhook_events" && op === "insert") {
          result = { error: opts.webhookInsertError ?? null };
        }
        if (table === "instagram_messages" && op === "insert") {
          result = { error: opts.messageInsertError ?? null };
        }
        return Promise.resolve(result).then(resolve as never, reject);
      },
    };
    return self;
  }

  const client = {
    from(table: string) {
      return {
        select: () => builder(table, "select"),
        insert: (payload: unknown) => builder(table, "insert", payload),
        update: (payload: unknown) => builder(table, "update", payload),
        upsert: (payload: unknown) => builder(table, "upsert", payload),
      };
    },
  };

  return { client: client as never, calls };
}

const connectionRow = {
  id: CONNECTION_ID,
  organization_id: ORG_ID,
  business_id: null,
  agent_config_id: null,
  instagram_business_account_id: OWN_ACCOUNT_ID,
};

describe("verifyWebhookHandshake", () => {
  beforeEach(() => {
    process.env["INSTAGRAM_WEBHOOK_VERIFY_TOKEN"] = "configured-secret";
  });

  test("echoes the challenge when mode=subscribe and the token matches", () => {
    const result = verifyWebhookHandshake({
      mode: "subscribe",
      verifyToken: "configured-secret",
      challenge: "echo-me",
    });
    assert.equal(result, "echo-me");
  });

  test("returns null on a token mismatch", () => {
    const result = verifyWebhookHandshake({
      mode: "subscribe",
      verifyToken: "wrong",
      challenge: "echo-me",
    });
    assert.equal(result, null);
  });

  test("returns null when no verify token is configured", () => {
    delete process.env["INSTAGRAM_WEBHOOK_VERIFY_TOKEN"];
    const result = verifyWebhookHandshake({
      mode: "subscribe",
      verifyToken: "anything",
      challenge: "echo-me",
    });
    assert.equal(result, null);
  });
});

describe("verifyWebhookSignature", () => {
  beforeEach(() => {
    process.env["META_APP_SECRET"] = "app-secret-value";
  });

  test("accepts a correctly-signed body", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig =
      "sha256=" + createHmac("sha256", "app-secret-value").update(body, "utf8").digest("hex");
    assert.equal(verifyWebhookSignature(body, sig), true);
  });

  test("rejects a body with the wrong signature", () => {
    const body = JSON.stringify({ hello: "world" });
    assert.equal(verifyWebhookSignature(body, "sha256=" + "0".repeat(64)), false);
  });

  test("rejects a missing signature header", () => {
    assert.equal(verifyWebhookSignature("{}", null), false);
  });

  test("rejects when META_APP_SECRET is not configured", () => {
    delete process.env["META_APP_SECRET"];
    const body = "{}";
    const sig = "sha256=" + createHmac("sha256", "irrelevant").update(body).digest("hex");
    assert.equal(verifyWebhookSignature(body, sig), false);
  });

  test("rejects a header missing the sha256= prefix", () => {
    process.env["META_APP_SECRET"] = "x";
    assert.equal(verifyWebhookSignature("{}", "deadbeef"), false);
  });

  test("a payload signed for a DIFFERENT app secret is rejected", () => {
    const body = JSON.stringify({ tampered: true });
    const sig = "sha256=" + createHmac("sha256", "someone-elses-secret").update(body).digest("hex");
    assert.equal(verifyWebhookSignature(body, sig), false);
  });
});

describe("processInboundInstagramWebhook — idempotency", () => {
  test("a duplicate event_id (23505) is reported as 'duplicate' without touching any other table", async () => {
    const { client, calls } = makeFakeSupabase({ webhookInsertError: { code: "23505" } });
    const result = await processInboundInstagramWebhook(client as never, {
      rawBody: JSON.stringify({
        entry: [{ id: OWN_ACCOUNT_ID, messaging: [{ sender: { id: "x" } }] }],
      }),
      eventId: "evt-1",
    });
    assert.equal(result.outcome, "duplicate");
    assert.equal(calls.filter((c) => c.table !== "webhook_events").length, 0);
  });

  test("an unrelated insert error is rethrown, not silently swallowed", async () => {
    const { client } = makeFakeSupabase({ webhookInsertError: { code: "99999" } });
    await assert.rejects(() =>
      processInboundInstagramWebhook(client as never, { rawBody: "{}", eventId: "evt-2" }),
    );
  });
});

describe("processInboundInstagramWebhook — bot-loop protection", () => {
  test("a message whose sender.id equals the connection's own account id is NEVER persisted", async () => {
    const { client, calls } = makeFakeSupabase({ connectionRow });
    const body = JSON.stringify({
      entry: [
        {
          id: OWN_ACCOUNT_ID,
          messaging: [{ sender: { id: OWN_ACCOUNT_ID }, message: { text: "echo of my own send" } }],
        },
      ],
    });
    await processInboundInstagramWebhook(client as never, { rawBody: body, eventId: "evt-3" });
    assert.equal(
      calls.some((c) => c.table === "instagram_messages" && c.op === "insert"),
      false,
    );
  });

  test("a message with is_echo:true is never persisted even if sender.id differs", async () => {
    const { client, calls } = makeFakeSupabase({ connectionRow });
    const body = JSON.stringify({
      entry: [
        {
          id: OWN_ACCOUNT_ID,
          messaging: [{ sender: { id: "someone-else" }, message: { text: "hi", is_echo: true } }],
        },
      ],
    });
    await processInboundInstagramWebhook(client as never, { rawBody: body, eventId: "evt-4" });
    assert.equal(
      calls.some((c) => c.table === "instagram_messages" && c.op === "insert"),
      false,
    );
  });

  test("a genuine customer message (different sender, no echo flag) IS persisted", async () => {
    const { client, calls } = makeFakeSupabase({ connectionRow });
    const body = JSON.stringify({
      entry: [
        {
          id: OWN_ACCOUNT_ID,
          messaging: [
            {
              sender: { id: CUSTOMER_IGSID },
              message: { text: "Do you have availability tomorrow?" },
            },
          ],
        },
      ],
    });
    const result = await processInboundInstagramWebhook(client as never, {
      rawBody: body,
      eventId: "evt-5",
    });
    assert.equal(result.outcome, "processed");
    assert.equal(
      calls.some((c) => c.table === "instagram_messages" && c.op === "insert"),
      true,
    );
    assert.equal(
      calls.some((c) => c.table === "instagram_conversations" && c.op === "upsert"),
      true,
    );
  });
});

describe("processInboundInstagramWebhook — connection resolution", () => {
  test("an entry id matching no connection is silently ignored (not an error)", async () => {
    const { client, calls } = makeFakeSupabase({ connectionRow: null });
    const body = JSON.stringify({
      entry: [
        { id: "unknown-account", messaging: [{ sender: { id: "x" }, message: { text: "hi" } }] },
      ],
    });
    const result = await processInboundInstagramWebhook(client as never, {
      rawBody: body,
      eventId: "evt-6",
    });
    assert.equal(result.outcome, "ignored");
    assert.equal(
      calls.some((c) => c.table === "instagram_messages"),
      false,
    );
  });

  test("a malformed (non-JSON) body never throws — processed as an empty batch", async () => {
    const { client } = makeFakeSupabase({});
    const result = await processInboundInstagramWebhook(client as never, {
      rawBody: "not json at all {{{",
      eventId: "evt-7",
    });
    assert.equal(result.outcome, "ignored");
  });
});
