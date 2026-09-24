import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sendWhatsAppPaymentMessage } from "./whatsapp-payments.server.ts";
import { encryptCredential } from "./whatsapp-token-crypto.server.ts";

const CRYPTO_KEY = "WHATSAPP_CREDENTIAL_ENCRYPTION_KEY";
const CONFIG_VARS = [
  "META_APP_ID",
  "META_APP_SECRET",
  "META_WHATSAPP_CONFIG_ID",
  "META_GRAPH_API_VERSION",
] as const;
const TEMPLATE_VARS = [
  "WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME",
  "WHATSAPP_TEMPLATE_PAYMENT_LINK_LANGUAGE",
  "WHATSAPP_TEMPLATE_PAYMENT_CONFIRMATION_NAME",
] as const;
const originalValues: Record<string, string | undefined> = {};

beforeEach(() => {
  originalValues[CRYPTO_KEY] = process.env[CRYPTO_KEY];
  process.env[CRYPTO_KEY] = randomBytes(32).toString("base64");
  for (const key of CONFIG_VARS) {
    originalValues[key] = process.env[key];
    process.env[key] = `test-${key.toLowerCase()}`;
  }
  for (const key of TEMPLATE_VARS) {
    originalValues[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of [CRYPTO_KEY, ...CONFIG_VARS, ...TEMPLATE_VARS]) {
    if (originalValues[key] === undefined) delete process.env[key];
    else process.env[key] = originalValues[key];
  }
});

function makeFakeSupabase(script: { table: string; op: string; result: unknown }[]) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  let i = 0;
  function next(table: string, op: string, ...args: unknown[]) {
    calls.push({ table, op, args });
    const entry = script[i];
    i++;
    if (!entry) throw new Error(`test bug: no scripted response for call ${i} (${table}.${op})`);
    return entry.result;
  }
  function selectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      in(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return chain;
      },
      maybeSingle: () => Promise.resolve(next(table, "select.maybeSingle", filters)),
    };
    return chain;
  }
  const client = {
    from(table: string) {
      return {
        select: () => selectChain(table),
        upsert(payload: unknown, opts: unknown) {
          return {
            select: () => ({
              single: () => Promise.resolve(next(table, "upsert.single", payload, opts)),
            }),
          };
        },
        insert(payload: unknown) {
          return {
            then(resolve: (v: unknown) => void) {
              resolve(next(table, "insert", payload));
            },
            select: () => ({
              single: () => Promise.resolve(next(table, "insert.select.single", payload)),
            }),
          };
        },
        update(payload: unknown) {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return chain;
            },
            then(resolve: (v: unknown) => void) {
              resolve(next(table, "update", payload, filters));
            },
          };
          return chain;
        },
      };
    },
  };
  return { client: client as never, calls };
}

function fakeFetchSequence(responses: { status: number; body: unknown }[]): typeof fetch {
  let i = 0;
  return (async () => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const BASE_INPUT = {
  organizationId: "org-1",
  businessId: "biz-1",
  bookingId: "booking-1",
  paymentRequestId: "pr-1",
  customerPhone: "+919876543210",
  purpose: "payment_link" as const,
  bodyText: "Your payment link: https://rzp.io/i/abc",
};

describe("sendWhatsAppPaymentMessage — no connection", () => {
  test("skips (never throws, never fakes success) when no connected WhatsApp number exists for this business", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: { data: null, error: null },
      },
    ]);
    const result = await sendWhatsAppPaymentMessage(client, BASE_INPUT);
    assert.equal(result.outcome, "skipped_no_connection");
  });
});

describe("sendWhatsAppPaymentMessage — tenant isolation", () => {
  test("resolves the connection scoped by BOTH organization_id and business_id — never falls back to another business's connected number", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: { data: null, error: null },
      },
    ]);
    await sendWhatsAppPaymentMessage(client, BASE_INPUT);
    const connectionLookup = calls.find((c) => c.table === "whatsapp_connections");
    assert.ok(connectionLookup);
    const filters = connectionLookup!.args[0] as Record<string, unknown>;
    assert.equal(filters["organization_id"], BASE_INPUT.organizationId);
    assert.equal(filters["business_id"], BASE_INPUT.businessId);
  });
});

describe("sendWhatsAppPaymentMessage — duplicate guard", () => {
  test("skips sending a second time for the same purpose + payment_request_id", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: {
          data: { id: "conn-1", phone_number_id: "pnid-1", access_token_ciphertext: "x" },
          error: null,
        },
      },
      {
        table: "whatsapp_messages",
        op: "select.maybeSingle",
        result: { data: { id: "existing-msg" }, error: null },
      },
    ]);
    const result = await sendWhatsAppPaymentMessage(client, BASE_INPUT);
    assert.equal(result.outcome, "skipped_duplicate");
    const sendAttempt = calls.find((c) => c.table === "whatsapp_messages" && c.op === "insert");
    assert.equal(sendAttempt, undefined, "must never attempt a send after detecting a duplicate");
  });
});

describe("sendWhatsAppPaymentMessage — 24h window / template requirement", () => {
  test("fails explicitly (never fakes a template) when a template is required but not configured", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: {
          data: { id: "conn-1", phone_number_id: "pnid-1", access_token_ciphertext: "x" },
          error: null,
        },
      },
      { table: "whatsapp_messages", op: "select.maybeSingle", result: { data: null, error: null } }, // no duplicate
      {
        table: "whatsapp_conversations",
        op: "upsert.single",
        result: { data: { id: "conv-1" }, error: null },
      },
      {
        table: "whatsapp_messages",
        op: "select.maybeSingle",
        result: { data: null, error: null },
      }, // no prior inbound message -> outside window -> template required
      { table: "whatsapp_messages", op: "insert", result: { error: null } }, // failed row recorded
    ]);
    const result = await sendWhatsAppPaymentMessage(client, BASE_INPUT);
    assert.equal(result.outcome, "failed");
    assert.equal(result.error, "template_not_configured");
    const failedInsert = calls.find((c) => c.table === "whatsapp_messages" && c.op === "insert");
    const payload = failedInsert!.args[0] as Record<string, unknown>;
    assert.equal(payload["status"], "failed");
    assert.match(String(payload["error_message"]), /Message Template is required/);
  });

  test("sends via template when configured and outside the 24h window", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_notify";
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_LANGUAGE"] = "en_US";
    const { client, calls } = makeFakeSupabase([
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            phone_number_id: "pnid-1",
            access_token_ciphertext: encryptCredential("test-access-token"),
          },
          error: null,
        },
      },
      { table: "whatsapp_messages", op: "select.maybeSingle", result: { data: null, error: null } },
      {
        table: "whatsapp_conversations",
        op: "upsert.single",
        result: { data: { id: "conv-1" }, error: null },
      },
      { table: "whatsapp_messages", op: "select.maybeSingle", result: { data: null, error: null } },
      {
        table: "whatsapp_messages",
        op: "insert.select.single",
        result: { data: { id: "msg-1" }, error: null },
      },
      { table: "whatsapp_messages", op: "update", result: { error: null } },
    ]);
    const fetchImpl = fakeFetchSequence([
      { status: 200, body: { messages: [{ id: "wamid.T1" }] } },
    ]);
    const result = await sendWhatsAppPaymentMessage(client, BASE_INPUT, fetchImpl);
    assert.equal(result.outcome, "sent");
    const sentUpdate = calls.find((c) => c.table === "whatsapp_messages" && c.op === "update");
    const payload = sentUpdate!.args[0] as Record<string, unknown>;
    assert.equal(payload["status"], "sent");
    assert.equal(payload["wa_message_id"], "wamid.T1");
  });

  test("sends free-form text when a recent inbound message opens the 24h window", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            phone_number_id: "pnid-1",
            access_token_ciphertext: encryptCredential("test-access-token"),
          },
          error: null,
        },
      },
      { table: "whatsapp_messages", op: "select.maybeSingle", result: { data: null, error: null } },
      {
        table: "whatsapp_conversations",
        op: "upsert.single",
        result: { data: { id: "conv-1" }, error: null },
      },
      {
        table: "whatsapp_messages",
        op: "select.maybeSingle",
        result: { data: { occurred_at: new Date().toISOString() }, error: null },
      },
      {
        table: "whatsapp_messages",
        op: "insert.select.single",
        result: { data: { id: "msg-2" }, error: null },
      },
      { table: "whatsapp_messages", op: "update", result: { error: null } },
    ]);
    const fetchImpl = fakeFetchSequence([
      { status: 200, body: { messages: [{ id: "wamid.FREEFORM1" }] } },
    ]);
    const result = await sendWhatsAppPaymentMessage(client, BASE_INPUT, fetchImpl);
    assert.equal(result.outcome, "sent");
    const insertCall = calls.find(
      (c) => c.table === "whatsapp_messages" && c.op === "insert.select.single",
    );
    const payload = insertCall!.args[0] as Record<string, unknown>;
    assert.equal(payload["message_type"], "text");
  });
});

describe("sendWhatsAppPaymentMessage — delivery failure never throws", () => {
  test("a Meta send failure is recorded on the message row and returned as a result, not thrown", async () => {
    process.env["WHATSAPP_TEMPLATE_PAYMENT_LINK_NAME"] = "payment_link_notify";
    const { client, calls } = makeFakeSupabase([
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            phone_number_id: "pnid-1",
            access_token_ciphertext: encryptCredential("test-access-token"),
          },
          error: null,
        },
      },
      { table: "whatsapp_messages", op: "select.maybeSingle", result: { data: null, error: null } },
      {
        table: "whatsapp_conversations",
        op: "upsert.single",
        result: { data: { id: "conv-1" }, error: null },
      },
      { table: "whatsapp_messages", op: "select.maybeSingle", result: { data: null, error: null } },
      {
        table: "whatsapp_messages",
        op: "insert.select.single",
        result: { data: { id: "msg-3" }, error: null },
      },
      { table: "whatsapp_messages", op: "update", result: { error: null } },
    ]);
    const fetchImpl = fakeFetchSequence([{ status: 500, body: {} }]);
    const result = await sendWhatsAppPaymentMessage(client, BASE_INPUT, fetchImpl);
    assert.equal(result.outcome, "failed");
    const failUpdate = calls.find((c) => c.table === "whatsapp_messages" && c.op === "update");
    const payload = failUpdate!.args[0] as Record<string, unknown>;
    assert.equal(payload["status"], "failed");
  });
});
