import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { processInboundComments } from "./instagram-automation.server.ts";
import { encryptCredential } from "./instagram-token-crypto.server.ts";
import { randomBytes } from "node:crypto";

process.env["INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
process.env["META_APP_ID"] = "app-id";
process.env["META_APP_SECRET"] = "app-secret";
process.env["META_GRAPH_API_VERSION"] = "v23.0";
process.env["INSTAGRAM_REDIRECT_URI"] = "https://clickai.in/cb";

const ORG_ID = "org-1";
const CONNECTION_ID = "conn-1";
const OWN_ACCOUNT_ID = "ig-business-999";

interface Call {
  table: string;
  op: string;
  payload?: unknown;
  filters: Record<string, unknown>;
}

function makeFakeSupabase(opts: {
  claimInsertError?: { code: string } | null;
  rules?: Record<string, unknown>[];
  connectionRow?: Record<string, unknown> | null;
}) {
  const calls: Call[] = [];

  function builder(table: string, op: string, payload?: unknown) {
    const filters: Record<string, unknown> = {};
    const self = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return self;
      },
      order() {
        return self;
      },
      select() {
        return self;
      },
      maybeSingle() {
        calls.push({ table, op, payload, filters });
        if (table === "instagram_connections") {
          return Promise.resolve({ data: opts.connectionRow ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: (r: unknown) => void, reject: (e: unknown) => void) {
        calls.push({ table, op, payload, filters });
        let result: { data?: unknown; error: unknown } = { error: null };
        if (table === "instagram_comment_events" && op === "insert") {
          result = { error: opts.claimInsertError ?? null };
        }
        if (table === "instagram_automation_rules" && op === "select") {
          result = { data: opts.rules ?? [], error: null };
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
  access_token_ciphertext: encryptCredential("long-lived-token"),
  status: "connected",
};

const baseConnection = {
  id: CONNECTION_ID,
  organization_id: ORG_ID,
  instagram_business_account_id: OWN_ACCOUNT_ID,
};

/** Never a real network call — see meta-instagram-client.server.test.ts's own requirement, applied here too since processInboundComments' action step calls the real Meta client. */
const fakeFetch = (async () =>
  new Response(JSON.stringify({ id: "reply-id-1" }), { status: 200 })) as typeof fetch;

describe("processInboundComments — idempotency (primary loop guard)", () => {
  test("a duplicate comment_id (23505 on the atomic claim) takes no action at all", async () => {
    const { client, calls } = makeFakeSupabase({ claimInsertError: { code: "23505" } });
    await processInboundComments(client as never, baseConnection, [
      { id: "comment-1", text: "price?" },
    ]);
    assert.equal(
      calls.some((c) => c.table === "instagram_automation_rules"),
      false,
    );
  });

  test("an unrelated claim-insert error is rethrown", async () => {
    const { client } = makeFakeSupabase({ claimInsertError: { code: "99999" } });
    await assert.rejects(() =>
      processInboundComments(client as never, baseConnection, [{ id: "c1", text: "hi" }]),
    );
  });

  test("a comment with no id is skipped entirely (never claimed)", async () => {
    const { client, calls } = makeFakeSupabase({});
    await processInboundComments(client as never, baseConnection, [{ text: "no id here" }]);
    assert.equal(calls.length, 0);
  });
});

describe("processInboundComments — skip own comment (secondary loop guard)", () => {
  test("a comment authored by the connection's own account is recorded as skipped_own_comment and never matched against rules", async () => {
    const { client, calls } = makeFakeSupabase({});
    await processInboundComments(client as never, baseConnection, [
      { id: "comment-2", text: "auto public reply we posted", from: { id: OWN_ACCOUNT_ID } },
    ]);
    assert.equal(
      calls.some((c) => c.table === "instagram_automation_rules"),
      false,
    );
    const updateCall = calls.find(
      (c) => c.table === "instagram_comment_events" && c.op === "update",
    );
    assert.equal(
      (updateCall?.payload as { action_taken?: string })?.action_taken,
      "skipped_own_comment",
    );
  });
});

describe("processInboundComments — rule matching", () => {
  test("comment_keyword rule matches on a case-insensitive substring", async () => {
    const rules = [
      {
        id: "rule-1",
        trigger_type: "comment_keyword",
        trigger_config: { keywords: ["PRICE"] },
        action_type: "public_reply",
        action_config: { replyText: "Check our bio for pricing!" },
      },
    ];
    const { client, calls } = makeFakeSupabase({ rules, connectionRow });
    await processInboundComments(
      client as never,
      baseConnection,
      [{ id: "comment-3", text: "what's the price for this?", from: { id: "customer-1" } }],
      fakeFetch,
    );
    const updateCall = calls.find(
      (c) => c.table === "instagram_comment_events" && c.op === "update",
    );
    assert.equal((updateCall?.payload as { matched_rule_id?: string })?.matched_rule_id, "rule-1");
    assert.equal((updateCall?.payload as { action_taken?: string })?.action_taken, "public_reply");
  });

  test("comment_keyword rule does NOT match when no keyword is present", async () => {
    const rules = [
      {
        id: "rule-1",
        trigger_type: "comment_keyword",
        trigger_config: { keywords: ["price"] },
        action_type: "public_reply",
        action_config: { replyText: "x" },
      },
    ];
    const { client, calls } = makeFakeSupabase({ rules, connectionRow });
    await processInboundComments(client as never, baseConnection, [
      { id: "comment-4", text: "love this post!", from: { id: "customer-1" } },
    ]);
    const updateCall = calls.find(
      (c) => c.table === "instagram_comment_events" && c.op === "update",
    );
    assert.equal(
      updateCall,
      undefined,
      "no rule matched, so no second update beyond the initial claim",
    );
  });

  test("comment_any rule matches every comment regardless of text", async () => {
    const rules = [
      {
        id: "rule-any",
        trigger_type: "comment_any",
        trigger_config: {},
        action_type: "public_reply",
        action_config: { replyText: "Thanks for commenting!" },
      },
    ];
    const { client, calls } = makeFakeSupabase({ rules, connectionRow });
    await processInboundComments(
      client as never,
      baseConnection,
      [{ id: "comment-5", text: "literally anything", from: { id: "customer-1" } }],
      fakeFetch,
    );
    const updateCall = calls.find(
      (c) => c.table === "instagram_comment_events" && c.op === "update",
    );
    assert.equal(
      (updateCall?.payload as { matched_rule_id?: string })?.matched_rule_id,
      "rule-any",
    );
  });

  test("a rule scoped to a specific postId does not match a comment on a different post", async () => {
    const rules = [
      {
        id: "rule-scoped",
        trigger_type: "comment_any",
        trigger_config: { postId: "post-A" },
        action_type: "public_reply",
        action_config: { replyText: "x" },
      },
    ];
    const { client, calls } = makeFakeSupabase({ rules, connectionRow });
    await processInboundComments(client as never, baseConnection, [
      { id: "comment-6", text: "hi", from: { id: "customer-1" }, media: { id: "post-B" } },
    ]);
    const updateCall = calls.find(
      (c) => c.table === "instagram_comment_events" && c.op === "update",
    );
    assert.equal(updateCall, undefined);
  });

  test("when the matched connection has no stored credentials, the action is skipped (never crashes)", async () => {
    const rules = [
      {
        id: "rule-any",
        trigger_type: "comment_any",
        trigger_config: {},
        action_type: "public_reply",
        action_config: { replyText: "x" },
      },
    ];
    const { client, calls } = makeFakeSupabase({
      rules,
      connectionRow: { ...connectionRow, access_token_ciphertext: null },
    });
    await processInboundComments(client as never, baseConnection, [
      { id: "comment-7", text: "hi", from: { id: "customer-1" } },
    ]);
    const updateCall = calls.find(
      (c) => c.table === "instagram_comment_events" && c.op === "update",
    );
    assert.equal(updateCall, undefined);
  });
});
