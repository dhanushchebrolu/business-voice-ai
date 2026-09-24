import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  sendInstagramDirectMessage,
  generateAndSendInstagramReply,
} from "./instagram-outbound.server.ts";
import { encryptCredential } from "./instagram-token-crypto.server.ts";

process.env["INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
process.env["META_APP_ID"] = "app-id";
process.env["META_APP_SECRET"] = "app-secret";
process.env["META_GRAPH_API_VERSION"] = "v23.0";
process.env["INSTAGRAM_REDIRECT_URI"] = "https://clickai.in/cb";

interface Call {
  table: string;
  op: string;
  payload?: unknown;
}

function makeFakeSupabase(opts: { connectionRow?: Record<string, unknown> | null }) {
  const calls: Call[] = [];
  function builder(table: string, op: string, payload?: unknown) {
    const self = {
      eq() {
        return self;
      },
      order() {
        return self;
      },
      limit() {
        return self;
      },
      select() {
        return self;
      },
      maybeSingle() {
        calls.push({ table, op, payload });
        if (table === "instagram_connections") {
          return Promise.resolve({ data: opts.connectionRow ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: (r: unknown) => void, reject: (e: unknown) => void) {
        calls.push({ table, op, payload });
        let result: { data?: unknown; error: unknown } = { error: null };
        if (table === "instagram_messages" && op === "select") result = { data: [], error: null };
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
      };
    },
  };
  return { client: client as never, calls };
}

const connectionRow = {
  id: "conn-1",
  organization_id: "org-1",
  instagram_business_account_id: "ig-1",
  status: "connected",
  access_token_ciphertext: encryptCredential("tok"),
};

describe("sendInstagramDirectMessage", () => {
  test("persists an outbound message with status=sent on success", async () => {
    const { client, calls } = makeFakeSupabase({ connectionRow });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message_id: "mid-1" }), { status: 200 })) as typeof fetch;
    const result = await sendInstagramDirectMessage(
      client,
      { connectionId: "conn-1", conversationId: "conv-1", recipientIgsid: "igsid-1", text: "Hi!" },
      fetchImpl,
    );
    assert.equal(result.messageId, "mid-1");
    const insertCall = calls.find((c) => c.table === "instagram_messages" && c.op === "insert");
    assert.equal((insertCall?.payload as { status?: string })?.status, "sent");
    assert.equal((insertCall?.payload as { direction?: string })?.direction, "outbound");
  });

  test("persists a failed outbound message and throws when Meta rejects the send", async () => {
    const { client, calls } = makeFakeSupabase({ connectionRow });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
      })) as typeof fetch;
    await assert.rejects(() =>
      sendInstagramDirectMessage(
        client,
        {
          connectionId: "conn-1",
          conversationId: "conv-1",
          recipientIgsid: "igsid-1",
          text: "Hi!",
        },
        fetchImpl,
      ),
    );
    const insertCall = calls.find((c) => c.table === "instagram_messages" && c.op === "insert");
    assert.equal((insertCall?.payload as { status?: string })?.status, "failed");
  });

  test("throws NOT_CONNECTED when the connection has no stored credentials", async () => {
    const { client } = makeFakeSupabase({
      connectionRow: { ...connectionRow, access_token_ciphertext: null },
    });
    await assert.rejects(() =>
      sendInstagramDirectMessage(
        client,
        { connectionId: "conn-1", conversationId: "conv-1", recipientIgsid: "igsid-1", text: "hi" },
        (async () => new Response("{}")) as typeof fetch,
      ),
    );
  });
});

describe("generateAndSendInstagramReply — no-op guards", () => {
  test("returns null (no AI call, no send) when the connection has no assigned bot", async () => {
    const { client } = makeFakeSupabase({
      connectionRow: {
        id: "conn-1",
        organization_id: "org-1",
        business_id: "biz-1",
        agent_config_id: null,
      },
    });
    const result = await generateAndSendInstagramReply(client, {
      connectionId: "conn-1",
      conversationId: "conv-1",
      igScopedId: "igsid-1",
    });
    assert.equal(result, null);
  });

  test("returns null when the connection row does not exist", async () => {
    const { client } = makeFakeSupabase({ connectionRow: null });
    const result = await generateAndSendInstagramReply(client, {
      connectionId: "conn-missing",
      conversationId: "conv-1",
      igScopedId: "igsid-1",
    });
    assert.equal(result, null);
  });
});
